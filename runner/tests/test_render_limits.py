"""The render service's limits and its lifecycle: what one request may ask of the GPU, sessions that fail or are
left behind, stills and movies as jobs in folders of their own, ffmpeg, and bad input answered with a 400.

Most need no GPU: a session's renderer is stood in for. The jobs end to end need CuPy and a CUDA GPU.
"""

from __future__ import annotations

import json
import os
import shutil
import stat
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

import pytest

import helpers  # noqa: F401 - puts the runner's packages on the path
from ngplatform_render import server
from ngplatform_render.server import BadRequest, Movie, RenderServer, Session


def serve(tmp_path: Path, **kw) -> tuple[RenderServer, callable]:
    srv = RenderServer(0, "tok", [tmp_path], 0, tmp_path / "renders", **kw)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{srv.server_port}"

    def call(method, path, body=None):
        """(status, the answer's JSON or None)."""
        r = urllib.request.Request(base + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                   headers={"X-NGP-Service-Token": "tok", "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(r, timeout=30) as f:
                data = f.read()
                return f.status, (json.loads(data) if data and f.headers["Content-Type"] == "application/json" else None)
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b"null")

    return srv, call


class OutOfMemoryError(Exception):
    """As CuPy names it."""


class FakeRenderer:
    """A renderer that fails as told when given a view."""

    def __init__(self, error: Exception | None = None):
        self.error = error
        self.samples = 0
        self.detail = None
        self.views = 0

    def set_view(self, st) -> None:
        self.views += 1
        if self.error is not None:
            raise self.error

    def depth(self):
        import numpy as np

        return np.zeros((8, 8, 2), np.float32)

    def set_fast(self, f) -> None:
        pass

    def step(self, n=1, stop=None) -> int:
        self.samples += n
        return self.samples

    def synchronize(self) -> None:
        pass

    def image(self, premultiplied=True):
        import numpy as np

        return np.zeros((8, 8, 4), np.uint8)


def ready_session(monkeypatch, renderer: FakeRenderer) -> Session:
    """A session 'loaded' without a volume, rendering with `renderer`."""

    def load(self):
        self.renderer = renderer
        self.status = "ready"
        threading.Thread(target=self._loop, daemon=True).start()

    monkeypatch.setattr(Session, "_load", load)
    monkeypatch.setattr(Session, "_state", lambda self, view, R=None: type("St", (), {"fast": 0.0, "width": 8, "height": 8})())
    s = Session("s1", {"volume": {"url": "x"}}, 0)
    for _ in range(100):
        if s.status == "ready":
            break
        time.sleep(0.01)
    return s


VIEW = {"inv_view_projection": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], "width": 64, "height": 48}


def wait_for(cond, seconds=5.0) -> bool:
    end = time.time() + seconds
    while time.time() < end:
        if cond():
            return True
        time.sleep(0.02)
    return False


# ------------------------------------------------------------------ the loop
def test_out_of_memory_fails_the_session_and_tells_the_page(tmp_path, monkeypatch):
    R = FakeRenderer(OutOfMemoryError("out of memory allocating 1,073,741,824 bytes"))
    s = ready_session(monkeypatch, R)
    srv, call = serve(tmp_path)
    try:
        srv.sessions[s.id] = s
        assert call("PUT", f"/sessions/{s.id}/view", VIEW)[0] == 200
        assert wait_for(lambda: s.status == "failed")
        time.sleep(0.6)
        # Not tried again every half second: once, then the session let go of its renderer.
        assert R.views == 1 and s.renderer is None and s.closed
        assert s.error.startswith("The GPU ran out of memory")
        st, body = call("GET", f"/sessions/{s.id}/frame?after=0&timeout=5")
        assert st == 410 and body["status"] == "failed" and "out of memory" in body["error"]
        assert call("GET", f"/sessions/{s.id}")[1]["status"] == "failed"
    finally:
        srv.shutdown()
        srv.server_close()


def test_a_view_that_fails_waits_for_the_next_one(monkeypatch):
    R = FakeRenderer(ValueError("a bad preset"))
    s = ready_session(monkeypatch, R)
    try:
        s.set_view(dict(VIEW))
        assert wait_for(lambda: s.error is not None)
        time.sleep(0.6)
        assert R.views == 1 and s.status == "ready"  # not retried every pass
        R.error = None
        s.set_view(dict(VIEW))
        assert wait_for(lambda: R.views == 2) and wait_for(lambda: s.error is None)
    finally:
        s.close()


def test_gpu_failures_are_told_apart():
    assert server.gpu_failure(OutOfMemoryError("x")).startswith("The GPU ran out of memory")
    assert server.gpu_failure(RuntimeError("cudaErrorMemoryAllocation: out of memory"))
    assert server.gpu_failure(ValueError("no preset")) is None


# ------------------------------------------------------------------ sessions left behind
def test_idle_sessions_are_closed(tmp_path, monkeypatch):
    monkeypatch.setattr(Session, "_load", lambda self: None)
    srv = RenderServer(0, "tok", [tmp_path], 0, tmp_path / "renders")
    try:
        old, new = Session("old", {"volume": {"url": "x"}}, 0), Session("new", {"volume": {"url": "x"}}, 0)
        srv.sessions.update(old=old, new=new)
        now = time.time()
        old.last_used = now - server.IDLE_SECONDS - 1
        assert srv.reap(now) == ["old"]
        assert old.closed and not new.closed and list(srv.sessions) == ["new"]
    finally:
        srv.server_close()


# ------------------------------------------------------------------ views
def test_view_sizes_and_samples_are_clamped(tmp_path, monkeypatch):
    monkeypatch.setattr(Session, "_load", lambda self: None)
    srv, call = serve(tmp_path)
    try:
        s = Session("s2", {"volume": {"url": "x"}}, 0)
        srv.sessions[s.id] = s
        st, _ = call("PUT", f"/sessions/{s.id}/view", {**VIEW, "width": 10**6, "height": 2, "max_samples": 10**9})
        assert st == 200
        assert (s.view["width"], s.view["height"], s.max_samples) == (server.MAX_SIDE, server.MIN_SIDE, server.MAX_SAMPLES)
        st, body = call("PUT", f"/sessions/{s.id}/view", {**VIEW, "width": "wide"})
        assert st == 400 and "width" in body["error"]
        # Query values decoded; a bad one is a 400, not a 500.
        assert call("GET", f"/sessions/{s.id}/frame?after=x&timeout=1")[0] == 400
        assert call("GET", f"/sessions/{s.id}/frame?after=%31&timeout=0.1")[0] == 204
        assert call("GET", "/sessions/nope/frame")[0] == 404
    finally:
        srv.shutdown()
        srv.server_close()


# ------------------------------------------------------------------ stills and movies
def test_still_limits():
    view, samples = server.still_plan({"view": dict(VIEW), "width": 64, "height": 48, "samples": 10**6})
    assert samples == server.MAX_SAMPLES and (view["width"], view["height"], view["scale"]) == (64, 48, 1.0)
    for bad in ({"width": 4}, {"width": 9000}, {"width": 8192, "height": 8192, "samples": 4096}, {"view": {}}):
        with pytest.raises(BadRequest):
            server.still_plan({"view": dict(VIEW), "width": 64, "height": 48, **bad})


def kf(t):
    return {"time": t, "view": dict(VIEW)}


def test_movie_inputs_are_checked_before_rendering():
    plan = server.movie_plan({"keyframes": [kf(0), kf(2)], "fps": 25, "width": 1281, "height": 721, "samples": 10**6}, "/usr/bin/ffmpeg")
    # H.264 needs even sides: made so before rendering; samples within the limit.
    assert (plan["width"], plan["height"], plan["frames"], plan["samples"]) == (1280, 720, 51, server.MAX_SAMPLES)
    png = server.movie_plan({"keyframes": [kf(0), kf(1)], "width": 1281, "height": 721, "format": "png"}, None)
    assert (png["width"], png["height"]) == (1281, 721)
    bad = [
        {"fps": 0}, {"fps": "x"}, {"fps": 1000},
        {"width": 4}, {"height": 10**5},
        {"keyframes": [kf(0), kf(10**6)]},  # too many frames
        {"keyframes": [kf(0), kf(600)], "width": 8192, "height": 8192},  # too many pixels
        {"rotation": {"step": 1e-6}}, {"rotation": {"step": 0}}, {"rotation": "spin"},
        {"keyframes": []}, {"keyframes": [{"time": 0}]}, {"format": "gif"},
    ]
    for b in bad:
        with pytest.raises(BadRequest):
            server.movie_plan({"keyframes": [kf(0), kf(2)], **b}, "/usr/bin/ffmpeg")
    with pytest.raises(BadRequest, match="ffmpeg"):
        server.movie_plan({"keyframes": [kf(0), kf(2)]}, None)


def test_info_says_whether_movies_can_be_made(tmp_path):
    srv, call = serve(tmp_path)
    try:
        srv.ffmpeg = None
        assert call("GET", "/info")[1]["ffmpeg"] is False
        srv.ffmpeg = "/usr/bin/ffmpeg"
        assert call("GET", "/info")[1]["ffmpeg"] is True
    finally:
        srv.shutdown()
        srv.server_close()


def fake_ffmpeg(tmp_path: Path, script: str) -> str:
    p = tmp_path / "ffmpeg"
    p.write_text("#!/bin/sh\n" + script + "\n")
    p.chmod(p.stat().st_mode | stat.S_IEXEC)
    return str(p)


def encoder(tmp_path: Path, ffmpeg: str) -> Movie:
    """A movie at its encoding (no thread, no session)."""
    m = Movie.__new__(Movie)
    m.spec, m.plan, m.out_dir, m.ffmpeg = {"name": "m"}, {"fps": 25, "crf": 18}, tmp_path, ffmpeg
    m.cancelled, m.proc = False, None
    return m


def test_ffmpeg_failures_keep_its_words(tmp_path):
    m = encoder(tmp_path, fake_ffmpeg(tmp_path, 'echo "width not divisible by 2 (1281x721)" >&2; exit 1'))
    with pytest.raises(RuntimeError, match="width not divisible by 2"):
        m._encode(tmp_path / "frames")


def test_cancelling_a_movie_stops_ffmpeg(tmp_path):
    m = encoder(tmp_path, fake_ffmpeg(tmp_path, "exec sleep 30"))
    got: list[BaseException] = []

    def run():
        try:
            m._encode(tmp_path / "frames")
        except BaseException as e:  # noqa: BLE001
            got.append(e)

    t = threading.Thread(target=run)
    t0 = time.time()
    t.start()
    assert wait_for(lambda: m.proc is not None)
    m.cancel()
    t.join(10)
    assert not t.is_alive() and time.time() - t0 < 10 and "cancelled" in str(got[0])


def test_jobs_write_into_folders_of_their_own(tmp_path):
    srv = RenderServer(0, "tok", [tmp_path], 0, tmp_path / "renders")
    try:
        assert srv.output_dir(None, "movie-1") == tmp_path / "renders" / "movie-1"
        data = tmp_path / "data"
        data.mkdir()
        assert srv.output_dir(str(data), "movie-2") == data / "movie-2"
        with pytest.raises(BadRequest):
            srv.output_dir("/etc", "movie-3")
    finally:
        srv.server_close()


def test_finished_jobs_are_let_go_of_under_the_lock(tmp_path):
    srv = RenderServer(0, "tok", [tmp_path], 0, tmp_path / "renders")
    try:
        job = lambda status: type("J", (), {"status": status})()  # noqa: E731
        for i in range(30):
            srv.keep(srv.movies, f"d{i}", job("done"))
        srv.keep(srv.movies, "r", job("running"))
        assert len(srv.movies) == server.KEEP_FINISHED + 1 and "r" in srv.movies and "d29" in srv.movies
    finally:
        srv.server_close()


def test_remote_stores_from_allowed_sources_only(tmp_path):
    srv = RenderServer(0, "tok", [tmp_path], 0, tmp_path / "renders", sources=["gs://bucket/brains", "https://data.example.org/"])
    try:
        srv.check_source("gs://bucket/brains/a.ome.zarr")
        srv.check_source("https://storage.googleapis.com/bucket/brains/b.ome.zarr")
        srv.check_source("zarr3://https://data.example.org/c.ome.zarr")
        srv.check_source(str(tmp_path / "local.ome.zarr"))  # stores on this computer: the roots, as before
        for bad in ("gs://bucket/brainsX/a.ome.zarr", "http://169.254.169.254/latest", "s3://other/a.zarr"):
            with pytest.raises(BadRequest):
                srv.check_source(bad)
    finally:
        srv.server_close()
    open_srv = RenderServer(0, "tok", [tmp_path], 0, tmp_path / "renders")
    try:
        open_srv.check_source("https://anywhere.example.com/a.ome.zarr")  # none given: any
    finally:
        open_srv.server_close()


# ------------------------------------------------------------------ end to end, on a GPU
def _gpu() -> bool:
    try:
        import cupy

        return cupy.cuda.runtime.getDeviceCount() > 0
    except Exception:  # noqa: BLE001
        return False


@pytest.mark.skipif(not _gpu(), reason="needs CuPy and a CUDA GPU")
def test_still_and_movie_jobs(tmp_path, monkeypatch):
    pytest.importorskip("zarr")
    import numpy as np
    from test_render import ball, write_store

    from ngplatform_render.camera import bounds, framing_radius, orbit

    monkeypatch.setenv("NGP_RENDER_CACHE", str(tmp_path / "cache"))
    url = write_store(tmp_path / "s.ome.zarr", ball(48), levels=1)
    srv, call = serve(tmp_path)
    try:
        st, s = call("POST", "/sessions", {"volume": {"url": url}})
        assert wait_for(lambda: call("GET", f"/sessions/{s['id']}")[1]["status"] != "loading", 20)
        info = call("GET", f"/sessions/{s['id']}")[1]
        A = np.asarray(info["volume"]["affine"]).reshape(4, 4).T
        lo, hi = bounds(A, info["volume"]["shape"])
        cam = orbit((lo + hi) / 2, framing_radius(lo, hi, 30), 0, 0)
        view = {"inv_view_projection": np.linalg.inv(cam.view_projection(64, 48)).T.ravel().tolist(), "width": 64, "height": 48,
                "orbit_center": ((lo + hi) / 2).tolist()}
        # A still is a job: progress, then its PNG.
        assert call("POST", f"/sessions/{s['id']}/still", {"view": view})[0] == 404  # in the request no more
        st, j = call("POST", f"/sessions/{s['id']}/stills", {"view": view, "width": 64, "height": 48, "samples": 8, "name": "a"})
        assert st == 200
        assert wait_for(lambda: call("GET", f"/stills/{j['id']}")[1]["status"] == "done", 30), call("GET", f"/stills/{j['id']}")
        r = urllib.request.Request(f"http://127.0.0.1:{srv.server_port}/stills/{j['id']}/file", headers={"X-NGP-Service-Token": "tok"})
        with urllib.request.urlopen(r) as f:
            assert f.read(8) == b"\x89PNG\r\n\x1a\n"
        assert Path(call("GET", f"/stills/{j['id']}")[1]["file"]).parent.name == f"still-{j['id']}"
        # A movie at odd sides: made even before rendering, encoded at the end.
        if shutil.which("ffmpeg"):
            st, m = call("POST", f"/sessions/{s['id']}/movies", {"keyframes": [{"time": 0, "view": view}], "rotation": {"degrees": 360, "step": 90},
                                                                "width": 65, "height": 49, "samples": 2, "fps": 4})
            assert st == 200 and (m["width"], m["height"], m["frames"]) == (64, 48, 4)
            assert wait_for(lambda: call("GET", f"/movies/{m['id']}")[1]["status"] in server.FINISHED, 60)
            done = call("GET", f"/movies/{m['id']}")[1]
            assert done["status"] == "done", done
            assert os.path.getsize(done["file"]) > 0 and Path(done["file"]).parent.name == f"movie-{m['id']}"
    finally:
        srv.shutdown()
        srv.server_close()
