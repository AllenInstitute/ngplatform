"""The render service at scale: one GPU budget (admission, a job queue, uploads shared), bounded disk (the cache
of made levels, movie frames, free space), streamed downloads with ranges, channels and time points, zarr v2
stores, the splat fit, and memory given back.

Most need no GPU (the GPU is stood in for, or budgets are counted only); those that render need CuPy and a
CUDA GPU. The fit's test needs a Python with torch (NGP_TEST_TORCH_PYTHON); gsplat is stood in for.
"""

from __future__ import annotations

import gc
import json
import os
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

import numpy as np
import pytest

import helpers  # noqa: F401 - puts the runner's packages on the path
from ngplatform_render import gpu as G
from ngplatform_render import server, volumes
from ngplatform_render.server import BadRequest, Job, JobQueue, Movie, Session
from test_render_limits import VIEW, FakeRenderer, fake_ffmpeg, ready_session, serve, wait_for

zarr = pytest.importorskip("zarr")


def _gpu() -> bool:
    try:
        import cupy

        return cupy.cuda.runtime.getDeviceCount() > 0
    except Exception:  # noqa: BLE001
        return False


needs_gpu = pytest.mark.skipif(not _gpu(), reason="needs CuPy and a CUDA GPU")
MB = 1 << 20


# ------------------------------------------------------------------ the budget
def test_budget_counts_refuses_and_gives_back():
    b = G.Budget(1000)
    r1 = b.reserve(600, "a view")
    with pytest.raises(G.Refused) as e:
        b.reserve(500, "another view")
    assert e.value.status == 503 and e.value.retry_after and e.value.detail["reason"] == "gpu-budget"
    assert "another view" in str(e.value) and b.used == 600
    r1.resize(300)
    r2 = b.reserve(500, "another view")
    with pytest.raises(G.Refused):
        r2.resize(800)  # growing past the budget: refused, and left as it was
    assert r2.bytes == 500 and b.used == 800
    # In place of part of another: counted in one step.
    r3 = b.reserve(400, "an upload", instead_of=(r2, 300))
    assert (r2.bytes, r3.bytes, b.used) == (200, 400, 900)
    for r in (r1, r2, r3, r3):
        r.release()
    assert b.used == 0 and b.info()["held"] == []


def test_budget_as_given():
    free = 10 << 30
    assert G.parse_budget(None, free) == int(free * G.DEFAULT_FRACTION)
    assert G.parse_budget("0.5", free) == free // 2
    assert G.parse_budget("24G", free) == 24 << 30
    assert G.parse_budget("1500M", free) == 1500 << 20
    assert G.parse_budget("2048", free) == 2048
    with pytest.raises(ValueError):
        G.parse_budget("lots", free)


def test_an_upload_is_made_once_and_shared():
    b = G.Budget(1000)
    t = G.Textures(b)
    made = []

    def make():
        time.sleep(0.1)  # a slow upload: a second asker waits for it, not makes its own
        made.append(1)
        return object()

    got = []
    threads = [threading.Thread(target=lambda: got.append(t.acquire(("volume", "a", "0"), "volume", 400, make, "a", spec_key=("k",)))) for _ in range(3)]
    for th in threads:
        th.start()
    for th in threads:
        th.join()
    assert len(made) == 1 and len({id(s.upload) for s in got}) == 1 and got[0].refs == 3 and b.used == 400
    assert t.find(("k",)) is got[0]
    with pytest.raises(G.Refused):
        t.acquire(("volume", "b", "0"), "volume", 700, make, "b")
    assert t.find(("other",)) is None and len(t.info()) == 1
    for s in got:
        t.release(s)
    assert b.used == 0 and t.info() == [] and got[0].upload is None


def test_a_session_counts_its_parts_and_shares_what_it_can():
    gpu = G.Gpu(0, total=1 << 40)
    spec = {"volume": {"url": "/data/a.ome.zarr", "budget": 1_000_000, "detail_budget": 0}}
    need = server.session_need(spec, gpu)
    assert need["volume"] > 1_000_000 and need["detail"] == 0 and need["frame"] >= 1920 * 1080 * 100
    # The same image asked for alike, already up: its volume is not counted again.
    s = gpu.textures.acquire(("volume", "x"), "volume", 10, object, "a", spec_key=server.spec_key(spec["volume"]))
    assert server.session_need(spec, gpu)["volume"] == 0
    assert server.session_need({"volume": {**spec["volume"], "channel": 1}}, gpu)["volume"] > 0
    gpu.textures.release(s)


def test_sessions_beyond_the_budget_are_refused_with_the_reason(tmp_path, monkeypatch):
    monkeypatch.setattr(Session, "_load", lambda self: None)
    spec = {"volume": {"url": str(tmp_path / "a.ome.zarr"), "budget": 1_000_000, "detail_budget": 0}}
    one = sum(server.session_need(spec, G.Gpu(0, total=1 << 40)).values())
    srv, call = serve(tmp_path, gpu_budget=int(2.5 * one))
    try:
        ids = []
        for _ in range(2):
            st, body = call("POST", "/sessions", spec)
            assert st == 200, body
            ids.append(body["id"])
        r = urllib.request.Request(f"http://127.0.0.1:{srv.server_port}/sessions", method="POST", data=json.dumps(spec).encode(),
                                   headers={"X-NGP-Service-Token": "tok", "Content-Type": "application/json"})
        with pytest.raises(urllib.error.HTTPError) as e:
            urllib.request.urlopen(r, timeout=10)
        body = json.loads(e.value.read())
        assert e.value.code == 503 and e.value.headers["Retry-After"] == str(server.RETRY_AFTER)
        assert body["reason"] == "gpu-budget" and body["need_mb"] > 0 and "GPU is busy" in body["error"]
        info = call("GET", "/info")[1]
        assert info["budget"]["used_mb"] == round(2 * one / MB) and info["queue"]["running"] is None
        # One closed: its part of the budget given back, and the next let in.
        assert call("DELETE", f"/sessions/{ids[0]}")[0] == 200
        assert wait_for(lambda: srv.gpu_share.budget.used == one)
        assert call("POST", "/sessions", spec)[0] == 200
        # Channels and time points: whole numbers from 0, else a 400.
        for bad in ("x", -1, 1.5, True):
            st, body = call("POST", "/sessions", {"volume": {**spec["volume"], "channel": bad}})
            assert st == 400 and "channel" in body["error"]
    finally:
        srv.shutdown()
        srv.server_close()


def test_a_larger_view_is_counted_before_it_is_drawn(tmp_path, monkeypatch):
    monkeypatch.setattr(Session, "_load", lambda self: None)
    spec = {"volume": {"url": str(tmp_path / "a.ome.zarr"), "budget": 1_000_000, "detail_budget": 0}}
    one = sum(server.session_need(spec, G.Gpu(0, total=1 << 40)).values())
    srv, call = serve(tmp_path, gpu_budget=one + 50 * MB)
    try:
        sid = call("POST", "/sessions", spec)[1]["id"]
        assert call("PUT", f"/sessions/{sid}/view", {**VIEW, "width": 1920, "height": 1080})[0] == 200
        st, body = call("PUT", f"/sessions/{sid}/view", {**VIEW, "width": 4096, "height": 4096})
        assert st == 503 and body["reason"] == "gpu-budget"
        assert srv.gpu_share.budget.used == one
    finally:
        srv.shutdown()
        srv.server_close()


# ------------------------------------------------------------------ the queue
class Gate(Job):
    """A job that runs until its gate opens."""

    kind = "still"

    def __init__(self, jid, session, gate, width=64, height=48):
        self.gate = gate
        super().__init__(jid, session, Path("/nonexistent") / jid, width, height)

    def _run(self):
        while not self.gate.wait(0.02):
            if self.cancelled:
                raise RuntimeError("cancelled")
        self.status = "done"


def test_jobs_run_one_at_a_time_and_say_where_they_wait(monkeypatch):
    s = ready_session(monkeypatch, FakeRenderer())
    try:
        gate = threading.Event()
        q = JobQueue(max_waiting=2)
        jobs = [Gate(f"j{i}", s, gate) for i in range(4)]
        q.submit(jobs[0])
        assert wait_for(lambda: jobs[0].status == "running")
        q.submit(jobs[1])
        q.submit(jobs[2])
        with pytest.raises(server.Refused) as e:
            q.submit(jobs[3])
        assert e.value.status == 429 and e.value.detail["reason"] == "queue-full"
        i1, i2 = jobs[1].info(), jobs[2].info()
        assert (i1["status"], i1["queue_position"], i1["jobs_ahead"]) == ("queued", 1, 1)
        assert (i2["queue_position"], i2["jobs_ahead"], i2["message"]) == (2, 2, "waiting for 2 jobs ahead")
        assert q.info()["running"] == {"kind": "still", "id": "j0"} and [w["id"] for w in q.info()["waiting"]] == ["j1", "j2"]
        # One cancelled while it waits: gone at once, and the next moves up.
        jobs[1].cancel()
        assert jobs[1].status == "cancelled" and jobs[2].info()["queue_position"] == 1
        time.sleep(0.2)
        assert jobs[2].status == "queued"  # still waiting: one at a time
        gate.set()
        assert wait_for(lambda: jobs[2].status == "done")
        assert jobs[0].info()["queue_position"] == 0 and s.gpu.budget.used == 0
    finally:
        s.close()


def test_a_job_waits_for_the_memory_sessions_hold(monkeypatch):
    s = ready_session(monkeypatch, FakeRenderer())
    try:
        s.gpu = G.Gpu(0, total=1 << 30)
        held = s.gpu.budget.reserve((1 << 30) - 10 * MB, "a view")
        gate = threading.Event()
        gate.set()
        q = JobQueue()
        j = Gate("j", s, gate)
        q.submit(j)
        assert wait_for(lambda: "waiting for GPU memory" in j.info()["message"])
        assert j.status == "running"
        held.release()
        assert wait_for(lambda: j.status == "done") and s.gpu.budget.used == 0
        # One that waits too long fails, saying why; one too large for the budget is refused when asked for.
        held = s.gpu.budget.reserve((1 << 30) - 10 * MB, "a view")
        monkeypatch.setattr(server, "JOB_GPU_WAIT", 0.3)
        j2 = Gate("j2", s, gate)
        q.submit(j2)
        assert wait_for(lambda: j2.status == "failed") and "GPU is busy" in j2.error
        held.release()
        with pytest.raises(BadRequest, match="more than the render computer's budget"):
            Gate("j3", s, gate, 8192, 8192)
    finally:
        s.close()


def test_jobs_refused_by_the_queue_or_the_disk(tmp_path, monkeypatch):
    s = ready_session(monkeypatch, FakeRenderer())
    srv, call = serve(tmp_path, max_waiting=0)
    try:
        s.gpu = srv.gpu_share
        srv.sessions[s.id] = s
        body = {"view": dict(VIEW), "width": 64, "height": 48, "samples": 4}
        st, answer = call("POST", f"/sessions/{s.id}/stills", body)
        assert st == 429 and answer["reason"] == "queue-full" and srv.stills == {}
        Usage = type("Usage", (), {})
        u = Usage()
        u.free, u.total, u.used = 100 * MB, 1 << 40, 0
        monkeypatch.setattr(server.shutil, "disk_usage", lambda p: u)
        st, answer = call("POST", f"/sessions/{s.id}/stills", body)
        assert st == 507 and answer["reason"] == "disk" and "Too little disk" in answer["error"]
        assert call("GET", "/info")[1]["disk"]["free_mb"] == 100
    finally:
        s.close()
        srv.shutdown()
        srv.server_close()


# ------------------------------------------------------------------ movies without a GPU, and downloads
class FrameRenderer(FakeRenderer):
    def step_beside(self, n, cancelled=None):
        self.samples += n
        return self.samples

    def close(self):
        self.closed = True


def test_a_movie_keeps_its_mp4_not_its_frames_and_downloads_by_range(tmp_path, monkeypatch):
    s = ready_session(monkeypatch, FakeRenderer())
    ffmpeg = fake_ffmpeg(tmp_path, 'for a; do out="$a"; done; head -c 5000 /dev/urandom > "$out"')
    srv, call = serve(tmp_path, ffmpeg=ffmpeg)
    try:
        s.gpu = srv.gpu_share
        s.loaded = type("Loaded", (), {"data": np.zeros((8, 8, 8), np.uint8)})()  # "loaded": the renderer is stood in for
        monkeypatch.setattr(Movie, "renderer", lambda self: FrameRenderer())
        srv.sessions[s.id] = s
        from test_splat import _view

        st, m = call("POST", f"/sessions/{s.id}/movies", {"keyframes": [{"time": 0, "view": _view(w=64, h=48)}], "rotation": {"degrees": 360, "step": 90},
                                                          "width": 64, "height": 48, "samples": 2, "fps": 4, "name": "spin"})
        assert st == 200 and m["status"] in ("queued", "running")
        assert wait_for(lambda: call("GET", f"/movies/{m['id']}")[1]["status"] in server.FINISHED, 10)
        done = call("GET", f"/movies/{m['id']}")[1]
        assert done["status"] == "done", done
        folder = Path(done["file"]).parent
        assert not (folder / "frames").exists() and [p.name for p in folder.iterdir()] == ["spin.mp4"]
        whole = Path(done["file"]).read_bytes()

        def get(rng=None):
            h = {"X-NGP-Service-Token": "tok", **({"Range": rng} if rng else {})}
            r = urllib.request.Request(f"http://127.0.0.1:{srv.server_port}/movies/{m['id']}/file", headers=h)
            try:
                with urllib.request.urlopen(r, timeout=10) as f:
                    return f.status, f.headers, f.read()
            except urllib.error.HTTPError as e:
                return e.code, e.headers, e.read()

        st, h, data = get()
        assert st == 200 and data == whole and h["Accept-Ranges"] == "bytes" and h["Content-Type"] == "video/mp4"
        st, h, data = get("bytes=100-199")
        assert st == 206 and data == whole[100:200] and h["Content-Range"] == f"bytes 100-199/{len(whole)}"
        st, h, data = get("bytes=4990-")
        assert st == 206 and data == whole[4990:]
        st, h, data = get("bytes=-10")
        assert st == 206 and data == whole[-10:]
        st, h, _ = get("bytes=9000-9100")
        assert st == 416 and h["Content-Range"] == f"bytes */{len(whole)}"
        assert srv.gpu_share.budget.used == 0
    finally:
        s.close()
        srv.shutdown()
        srv.server_close()


def test_downloads_are_not_read_whole(tmp_path, monkeypatch):
    """A large file is sent a chunk at a time: never more than FILE_CHUNK bytes held."""
    s = ready_session(monkeypatch, FakeRenderer())
    srv, call = serve(tmp_path)
    try:
        big = tmp_path / "big.mp4"
        with open(big, "wb") as f:
            f.truncate(64 * MB)
        m = Movie.__new__(Movie)
        m.id, m.status, m.file = "big", "done", big
        srv.movies["big"] = m
        reads = []
        real_open = open

        class Watched:
            def __init__(self, f):
                self.f = f

            def __enter__(self):
                return self

            def __exit__(self, *a):
                self.f.close()

            def seek(self, n):
                self.f.seek(n)

            def read(self, n):
                reads.append(n)
                return self.f.read(n)

        monkeypatch.setattr(server, "open", lambda p, mode="r", *a, **k: Watched(real_open(p, mode, *a, **k)), raising=False)
        r = urllib.request.Request(f"http://127.0.0.1:{srv.server_port}/movies/big/file", headers={"X-NGP-Service-Token": "tok"})
        with urllib.request.urlopen(r, timeout=30) as f:
            n = sum(len(c) for c in iter(lambda: f.read(MB), b""))
        assert n == 64 * MB and max(reads) <= server.FILE_CHUNK and len(reads) >= 64
    finally:
        s.close()
        srv.shutdown()
        srv.server_close()


# ------------------------------------------------------------------ the cache of made levels
def write_v3(path: Path, data: np.ndarray, voxel_um: float = 500.0) -> str:
    from test_render import write_store

    return write_store(path, data, voxel_um, levels=1)


def test_a_store_written_again_is_read_again(tmp_path, monkeypatch):
    monkeypatch.setenv("NGP_RENDER_CACHE", str(tmp_path / "cache"))
    url = str(tmp_path / "a.ome.zarr")
    write_v3(Path(url), np.full((32, 32, 32), 10, np.uint8))
    a = volumes.load(url, budget=32**3 // 8)
    b = volumes.load(url, budget=32**3 // 8)
    assert a.made and not a.from_cache and b.from_cache and (b.data == 10).all()
    time.sleep(0.01)
    write_v3(Path(url), np.full((32, 32, 32), 20, np.uint8))  # the same path, new data
    c = volumes.load(url, budget=32**3 // 8)
    assert not c.from_cache and (c.data == 20).all()


def test_the_cache_keeps_within_its_size_least_recently_used_out(tmp_path, monkeypatch):
    monkeypatch.setenv("NGP_RENDER_CACHE", str(tmp_path / "cache"))
    one = (32 // 2) ** 3  # a made level of a 32^3 uint8 store: 4 KB and a header
    monkeypatch.setenv("NGP_RENDER_CACHE_GB", str(2.5 * (one + 128) / (1 << 30)))
    urls = [write_v3(tmp_path / f"s{i}.ome.zarr", np.full((32, 32, 32), i + 1, np.uint8)) for i in range(4)]
    for i, u in enumerate(urls[:2]):
        volumes.load(u, budget=32**3 // 8)
        time.sleep(0.02)
    assert volumes.load(urls[0], budget=32**3 // 8).from_cache  # used again: now the most recent
    time.sleep(0.02)
    volumes.load(urls[2], budget=32**3 // 8)  # a third: the least recently used (s1) goes
    entries = volumes.cache_entries()
    assert len(entries) == 2 and sum(n for _, n, _ in entries) <= volumes.cache_max_bytes()
    assert volumes.load(urls[0], budget=32**3 // 8).from_cache and not volumes.load(urls[1], budget=32**3 // 8).from_cache
    info = volumes.cache_info()
    assert info["files"] == 2 and info["max_mb"] == round(volumes.cache_max_bytes() / MB)


# ------------------------------------------------------------------ channels, time points and zarr v2
def write_ct(path: Path, version: int = 3, typed: bool = True) -> str:
    """A (t, c, z, y, x) store of 4 time points and 3 channels: each 3-D volume all 10 t + c + 1."""
    data = np.zeros((4, 3, 16, 16, 16), np.uint8)
    for t in range(4):
        for c in range(3):
            data[t, c] = 10 * t + c + 1
    g = zarr.open_group(str(path), mode="w", zarr_format=version)
    g.create_array("0", data=data, chunks=(1, 1, 8, 8, 8))
    kinds = {"t": "time", "c": "channel"}
    axes = [{"name": n, "type": kinds.get(n, "space"), **({"unit": "micrometer"} if n in "zyx" else {})} if typed else {"name": n} for n in "tczyx"]
    ms = {"axes": axes, "datasets": [{"path": "0", "coordinateTransformations": [{"type": "scale", "scale": [1, 1, 500, 500, 500]}]}], "name": path.name}
    if version == 3:
        g.attrs["ome"] = {"version": "0.5", "multiscales": [ms]}
    else:
        g.attrs["multiscales"] = [{**ms, "version": "0.4"}]
    return str(path)


@pytest.mark.parametrize("version", [3, 2])
def test_channels_and_time_points(tmp_path, monkeypatch, version):
    monkeypatch.setenv("NGP_RENDER_CACHE", str(tmp_path / "cache"))
    url = write_ct(tmp_path / "ct.ome.zarr", version)
    ms = volumes.open_multiscale(url)
    assert ms.counts() == {"axes": ["t", "c", "z", "y", "x"], "channels": 3, "times": 4}
    first = volumes.load(url)
    assert (first.data == 1).all() and (first.channel, first.time) == (0, 0) and first.counts["channels"] == 3
    L = volumes.load(url, channel=2, time=3)
    assert (L.data == 33).all() and L.data.shape == (16, 16, 16) and (L.channel, L.time) == (2, 3)
    # A made level, at its channel and time point (and cached apart from the others').
    for c in (1, 2):
        M = volumes.load(url, budget=8**3, channel=c, time=1)
        assert M.made and (M.data == 10 + c + 1).all()
    for bad, words in (({"channel": 3}, "this image has 3"), ({"time": 9}, "this image has 4"), ({"channel": -1}, "out of range")):
        with pytest.raises(ValueError, match=words):
            volumes.load(url, **bad)
    # Finer detail reads its regions at the same channel and time point.
    from ngplatform_render import detail

    region = detail.read_region(url, ms, ms.levels[0], (0, 0, 0), (12, 12, 12), cache=detail.ChunkCache(1 << 30), fixed=ms.fixed(1, 2))
    assert (region == 22).all()


def test_untyped_axes_by_name_and_images_without_channels(tmp_path):
    url = write_ct(tmp_path / "ct.ome.zarr", 3, typed=False)
    assert (volumes.load(url, channel=1, time=1).data == 12).all()
    from test_render import ball, write_store

    plain = write_store(tmp_path / "b.ome.zarr", ball(16), levels=1)
    assert volumes.open_multiscale(plain).counts() == {"axes": ["z", "y", "x"], "channels": 1, "times": 1}
    assert volumes.load(plain, channel=0).channel == 0
    with pytest.raises(ValueError, match="no channel axis"):
        volumes.load(plain, channel=1)


def test_zarr_v2_stores(tmp_path, monkeypatch):
    monkeypatch.setenv("NGP_RENDER_CACHE", str(tmp_path / "cache"))
    data = np.arange(32**3, dtype=np.uint16).reshape(32, 32, 32) % 1000
    g = zarr.open_group(str(tmp_path / "v2.ome.zarr"), mode="w", zarr_format=2)
    g.create_array("0", data=data, chunks=(16, 16, 16))
    g.attrs["multiscales"] = [{"version": "0.4", "axes": [{"name": n, "type": "space", "unit": "millimeter"} for n in "zyx"],
                               "datasets": [{"path": "0", "coordinateTransformations": [{"type": "scale", "scale": [0.5, 0.25, 0.125]}]}]}]
    url = str(tmp_path / "v2.ome.zarr")
    L = volumes.load(url)
    assert (L.data == data).all() and L.voxel_mm == (0.125, 0.25, 0.5)
    M = volumes.load(url, budget=32**3 // 8)
    N = volumes.load(url, budget=32**3 // 8)
    assert M.made and not M.from_cache and N.from_cache  # stamped by its .zarray
    assert "|" in volumes.content_stamp(url, volumes.open_multiscale(url), volumes.open_multiscale(url).levels[0])


# ------------------------------------------------------------------ a load stopped by a close
def test_closing_a_loading_session_stops_the_read(tmp_path, monkeypatch):
    g = zarr.open_group(str(tmp_path / "c.ome.zarr"), mode="w", zarr_format=3)
    g.create_array("0", data=np.ones((64, 64, 64), np.uint8), chunks=(8, 8, 8))
    g.attrs["ome"] = {"version": "0.5", "multiscales": [{"axes": [{"name": n, "type": "space"} for n in "zyx"],
                                                         "datasets": [{"path": "0", "coordinateTransformations": [{"type": "scale", "scale": [1, 1, 1]}]}]}]}
    url = str(tmp_path / "c.ome.zarr")
    monkeypatch.setattr(volumes, "READ_BLOCK_BYTES", 1)  # a block a chunk: 512 of them, 8 read at once
    blocks = []
    real = volumes.level_array

    class Slow:
        def __init__(self, a):
            self.a = a
            self.shape, self.chunks, self.dtype = a.shape, a.chunks, a.dtype

        def __getitem__(self, sel):
            blocks.append(1)
            time.sleep(0.05)
            return self.a[sel]

    monkeypatch.setattr(volumes, "level_array", lambda u, ms, path: Slow(real(u, ms, path)))
    srv, call = serve(tmp_path, gpu_budget=1 << 34)
    try:
        st, s = call("POST", "/sessions", {"volume": {"url": url, "detail_budget": 0}})
        assert st == 200 and srv.gpu_share.budget.used > 0
        time.sleep(0.3)
        sess = srv.sessions[s["id"]]
        assert call("DELETE", f"/sessions/{s['id']}")[0] == 200
        assert wait_for(lambda: srv.gpu_share.budget.used == 0, 5)
        n = len(blocks)
        time.sleep(0.5)
        # Stopped between blocks (those under way finished), not read to the end; said in the session.
        assert len(blocks) == n and n < 200, n
        assert sess.status == "failed" and sess.message == "closed while loading" and sess._torn
    finally:
        srv.shutdown()
        srv.server_close()


# ------------------------------------------------------------------ the splat fit, with gsplat stood in for
GSPLAT_STANDIN = {
    "gsplat/__init__.py": '''
__version__ = "1.4.0"
import torch


def rasterization(means, quats, scales, opacities, colors, viewmats, Ks, width, height, sh_degree, packed, backgrounds):
    """Each Gaussian's mean colour over the background, everywhere: enough for the fit's loop to run and learn."""
    assert packed is False and viewmats.shape[0] == 1 and Ks.shape[0] == 1
    rgb = colors[:, 0, :] * 0.28209479177387814 + 0.5
    a = opacities.mean()
    c = (rgb * opacities[:, None]).sum(0) / opacities.sum() + 0.0 * (means.sum() + scales.sum() + quats.sum())
    out = c.view(1, 1, 1, 3).expand(1, height, width, 3) * a + backgrounds.view(1, 1, 1, 3) * (1 - a)
    return out, a.view(1, 1, 1, 1).expand(1, height, width, 1), {"means2d": means[:, :2]}
''',
    "gsplat/strategy.py": '''
class DefaultStrategy:
    def __init__(self, **kw):
        self.kw = kw

    def check_sanity(self, params, optimizers):
        assert set(params) == set(optimizers)

    def initialize_state(self, scene_scale=1.0):
        return {"scene_scale": scene_scale}

    def step_pre_backward(self, params, optimizers, state, step, info):
        pass

    def step_post_backward(self, params, optimizers, state, step, info, packed=False):
        assert packed is False
''',
}


def torch_python() -> str | None:
    """A Python with torch, for the fit's test (NGP_TEST_TORCH_PYTHON; this one when it has torch)."""
    p = os.environ.get("NGP_TEST_TORCH_PYTHON")
    if p:
        return p
    try:
        import torch  # noqa: F401

        return sys.executable
    except ImportError:
        return None


def standin(tmp_path: Path) -> Path:
    d = tmp_path / "standin"
    for name, text in GSPLAT_STANDIN.items():
        (d / name).parent.mkdir(parents=True, exist_ok=True)
        (d / name).write_text(text)
    return d


def capture(folder: Path, n: int = 16, w: int = 48, h: int = 32) -> None:
    """A capture folder as a splat job writes it: views, cameras and starting points."""
    from PIL import Image

    from ngplatform_render.splat import views as V
    from test_splat import _view

    cams, _, _, centre = V.capture_cameras(_view(), n, 180)
    (folder / "images").mkdir(parents=True)
    rng = np.random.default_rng(0)
    recs = []
    for i, c in enumerate(cams):
        name = f"images/{i:05d}.png"
        Image.fromarray(rng.integers(0, 255, (h, w, 4), dtype=np.uint8), "RGBA").save(folder / name)
        recs.append(V.camera_record(name, c, w, h))
    V.write_points(folder / "points.ply", rng.normal(size=(200, 3)).astype(np.float32) * 10, rng.integers(0, 255, (200, 3), dtype=np.uint8))
    V.write_cameras(folder, recs, centre, {})


def test_views_are_read_as_needed_within_their_memory(tmp_path):
    from ngplatform_render.splat.fit import Views

    capture(tmp_path)
    frames = json.loads((tmp_path / "cameras.json").read_text())["frames"]
    one = 48 * 32 * 4
    v = Views(tmp_path, frames, 1, 2 * one)
    for i in (0, 1, 2, 0, 2):
        assert v.host(i).shape == (32, 48, 4)
    assert v.reads == 4 and v.bytes <= 2 * one  # 0 had gone (the least recently used) when it was asked again
    small = Views(tmp_path, frames, 2, 0)
    assert small.host(3).shape == (16, 24, 4) and small.bytes == 0


@pytest.mark.skipif(torch_python() is None, reason="needs a Python with torch: set NGP_TEST_TORCH_PYTHON (gsplat is stood in for)")
def test_the_fit_runs_with_gsplat_stood_in_for(tmp_path):
    capture(tmp_path / "cap")
    env = {**os.environ, "PYTHONPATH": os.pathsep.join([str(standin(tmp_path)), str(helpers.RUNNER)])}
    r = subprocess.run([torch_python(), "-m", "ngplatform_render.splat.fit", str(tmp_path / "cap"), "--steps", "12", "--sh", "1",
                        "--device", "cpu", "--views-gb", "0"], capture_output=True, text=True, env=env, timeout=600)
    assert r.returncode == 0, r.stdout + r.stderr
    fit = json.loads((tmp_path / "cap" / "fit.json").read_text())
    assert fit["gsplat"] == "1.4.0" and fit["device"] == "cpu" and fit["steps"] == 12 and fit["held_out"] == 2
    assert fit["psnr_held_out"] is not None and (tmp_path / "cap" / "splat.ply").stat().st_size > 0
    assert "[progress] 1.0000" in r.stdout


# ------------------------------------------------------------------ on a GPU
def _open(call, url, **extra):
    st, s = call("POST", "/sessions", {"volume": {"url": url, **extra}})
    assert st == 200, s
    assert wait_for(lambda: call("GET", f"/sessions/{s['id']}")[1]["status"] != "loading", 60)
    info = call("GET", f"/sessions/{s['id']}")[1]
    assert info["status"] == "ready", info
    return info


def _view_of(info, w=64, h=48):
    from ngplatform_render.camera import bounds, framing_radius, orbit

    A = np.asarray(info["volume"]["affine"]).reshape(4, 4).T
    lo, hi = bounds(A, info["volume"]["shape"])
    cam = orbit((lo + hi) / 2, framing_radius(lo, hi, 30), 0, 0)
    return {"inv_view_projection": np.linalg.inv(cam.view_projection(w, h)).T.ravel().tolist(), "width": w, "height": h,
            "orbit_center": ((lo + hi) / 2).tolist()}


@needs_gpu
def test_two_sessions_and_a_still_share_one_upload(tmp_path, monkeypatch):
    import cupy

    from test_render import write_store

    monkeypatch.setenv("NGP_RENDER_CACHE", str(tmp_path / "cache"))
    n = 256
    z, y, x = np.mgrid[:n, :n, :n] / (n - 1) - 0.5
    data = np.where(np.sqrt(x * x + y * y + z * z) < 0.35, 40000, 500).astype(np.uint16)  # 32 MB
    url = write_store(tmp_path / "big.ome.zarr", data, levels=1)
    del x, y, z
    srv, call = serve(tmp_path)
    try:
        free0 = cupy.cuda.runtime.memGetInfo()[0]
        a = _open(call, url, detail_budget=0)
        free1 = cupy.cuda.runtime.memGetInfo()[0]
        b = _open(call, url, detail_budget=0)
        free2 = cupy.cuda.runtime.memGetInfo()[0]
        sa, sb = srv.sessions[a["id"]], srv.sessions[b["id"]]
        assert sa._R._arr is sb._R._arr and sa.loaded is sb.loaded  # one upload, one read
        first, second = free0 - free1, free1 - free2
        assert first >= data.nbytes and second < data.nbytes / 2, (first >> 20, second >> 20)
        ups = srv.gpu_share.textures.info()
        assert len(ups) == 1 and ups[0]["users"] == 2
        # The budget counts the volume once.
        from ngplatform_render import renderer as rmod

        assert srv.gpu_share.budget.used < 2 * rmod.volume_bytes(data.shape, 2) + 2 * rmod.renderer_bytes(*server.SESSION_FRAME, data.shape)
        # A still shares it too, and holds it while it runs even when its session closes.
        view = _view_of(a)
        st, j = call("POST", f"/sessions/{a['id']}/stills", {"view": view, "width": 64, "height": 48, "samples": 64})
        assert st == 200
        assert call("DELETE", f"/sessions/{a['id']}")[0] == 200
        assert call("DELETE", f"/sessions/{b['id']}")[0] == 200
        assert wait_for(lambda: call("GET", f"/stills/{j['id']}")[1]["status"] in server.FINISHED, 60)
        assert call("GET", f"/stills/{j['id']}")[1]["status"] == "done"
        assert wait_for(lambda: srv.gpu_share.textures.info() == [] and srv.gpu_share.budget.used == 0, 10), srv.gpu_share.info()
    finally:
        srv.shutdown()
        srv.server_close()


@needs_gpu
def test_memory_is_given_back(tmp_path, monkeypatch):
    import cupy

    from ngplatform_render import renderer as rmod
    from test_render import ball, write_store

    monkeypatch.setenv("NGP_RENDER_CACHE", str(tmp_path / "cache"))
    url = write_store(tmp_path / "s.ome.zarr", ball(64), levels=2)
    # Pinned host memory: freed by close(), and by a renderer let go of without one.
    rt = cupy.cuda.runtime
    counts = {"alloc": 0, "free": 0}
    real_alloc, real_free = rt.hostAlloc, rt.freeHost

    def alloc(*a):
        counts["alloc"] += 1
        return real_alloc(*a)

    def free(p):
        counts["free"] += 1
        return real_free(p)

    monkeypatch.setattr(rt, "hostAlloc", alloc)
    monkeypatch.setattr(rt, "freeHost", free)
    R = rmod.Renderer(0)
    R.close()
    R.close()
    rmod.Renderer(0)
    gc.collect()
    assert counts == {"alloc": 2, "free": 2}

    pool = cupy.get_default_memory_pool()
    server.free_gpu_pool()
    before = pool.used_bytes()
    srv, call = serve(tmp_path)
    try:
        info = _open(call, url)
        sid = info["id"]
        call("PUT", f"/sessions/{sid}/view", {**_view_of(info), "max_samples": 16})
        st, _ = call("GET", f"/sessions/{sid}/frame?after=0&timeout=20")
        assert st == 200 and pool.used_bytes() > before
        st, j = call("POST", f"/sessions/{sid}/stills", {"view": _view_of(info), "width": 64, "height": 48, "samples": 8})
        assert wait_for(lambda: call("GET", f"/stills/{j['id']}")[1]["status"] == "done", 30)
        s = srv.sessions[sid]
        assert call("DELETE", f"/sessions/{sid}")[0] == 200
        assert wait_for(lambda: s.vol_share is None and srv.gpu_share.budget.used == 0, 10)
        assert s._torn and s._R is None and s.detail_meta is None and s._detail_pending is None and s.vol_share is None
        assert pool.used_bytes() <= before, (pool.used_bytes(), before)
        assert srv.gpu_share.budget.used == 0
        gc.collect()
        assert counts["alloc"] == counts["free"]
    finally:
        srv.shutdown()
        srv.server_close()


@needs_gpu
def test_a_session_shows_the_channel_and_time_asked_for(tmp_path, monkeypatch):
    monkeypatch.setenv("NGP_RENDER_CACHE", str(tmp_path / "cache"))
    url = write_ct(tmp_path / "ct.ome.zarr", 2)
    srv, call = serve(tmp_path)
    try:
        info = _open(call, url, channel=1, time=2)
        v = info["volume"]
        assert (v["channel"], v["time"], v["channels"], v["times"], v["axes"]) == (1, 2, 3, 4, ["t", "c", "z", "y", "x"])
        assert (srv.sessions[info["id"]].loaded.data == 22).all()
        # Another channel of the same image is another upload; out of range, the session fails saying why.
        other = _open(call, url, channel=2, time=2)
        assert len(srv.gpu_share.textures.info()) == 2 and (srv.sessions[other["id"]].loaded.data == 23).all()
        st, s = call("POST", "/sessions", {"volume": {"url": url, "channel": 7}})
        assert wait_for(lambda: call("GET", f"/sessions/{s['id']}")[1]["status"] == "failed", 30)
        assert "this image has 3" in call("GET", f"/sessions/{s['id']}")[1]["error"]
    finally:
        srv.shutdown()
        srv.server_close()


@needs_gpu
def test_a_splat_of_views_only_and_a_movie_end_to_end(tmp_path, monkeypatch):
    from test_render import ball, write_store

    monkeypatch.setenv("NGP_RENDER_CACHE", str(tmp_path / "cache"))
    url = write_store(tmp_path / "s.ome.zarr", ball(48), levels=1)
    srv, call = serve(tmp_path)
    try:
        info = _open(call, url)
        view = _view_of(info)
        st, j = call("POST", f"/sessions/{info['id']}/splats", {"view": view, "views": 8, "size": 64, "samples": 2, "steps": 0, "points": 2000})
        assert st == 200, j
        assert wait_for(lambda: call("GET", f"/splats/{j['id']}")[1]["status"] in server.FINISHED, 60)
        done = call("GET", f"/splats/{j['id']}")[1]
        assert done["status"] == "done" and "fitting not asked for" in done["message"] and "cameras.json" in done["files"]
        folder = Path(done["folder"])
        assert len(list((folder / "images").glob("*.png"))) == 8 and (folder / "points.ply").stat().st_size > 0
        r = urllib.request.Request(f"http://127.0.0.1:{srv.server_port}/splats/{j['id']}/file/cameras.json",
                                   headers={"X-NGP-Service-Token": "tok", "Range": "bytes=0-0"})
        with urllib.request.urlopen(r, timeout=10) as f:
            assert f.status == 206 and f.read() == b"{"
        if not shutil.which("ffmpeg"):
            pytest.skip("no ffmpeg on the PATH: the movie's encoding is not tried (the splat's views were)")
        st, m = call("POST", f"/sessions/{info['id']}/movies", {"keyframes": [{"time": 0, "view": view}], "rotation": {"degrees": 360, "step": 120},
                                                               "width": 64, "height": 48, "samples": 2, "fps": 3})
        assert st == 200
        assert wait_for(lambda: call("GET", f"/movies/{m['id']}")[1]["status"] in server.FINISHED, 60)
        done = call("GET", f"/movies/{m['id']}")[1]
        assert done["status"] == "done", done
        assert Path(done["file"]).stat().st_size > 0 and not (Path(done["file"]).parent / "frames").exists()
    finally:
        srv.shutdown()
        srv.server_close()


@needs_gpu
@pytest.mark.skipif(torch_python() is None, reason="needs a Python with torch: set NGP_TEST_TORCH_PYTHON (gsplat is stood in for)")
def test_a_fitted_splat_through_the_service_on_its_gpu(tmp_path, monkeypatch):
    from test_render import ball, write_store

    monkeypatch.setenv("NGP_RENDER_CACHE", str(tmp_path / "cache"))
    monkeypatch.setenv("PYTHONPATH", str(standin(tmp_path)))
    url = write_store(tmp_path / "s.ome.zarr", ball(48), levels=1)
    srv, call = serve(tmp_path, splat_python=torch_python())
    try:
        assert wait_for(lambda: srv.splat_check.get("error") != "checking", 120)
        assert srv.splat_check["ready"] and srv.splat_check["gsplat"] == "1.4.0" and "warning" not in srv.splat_check, srv.splat_check
        info = _open(call, url)
        st, j = call("POST", f"/sessions/{info['id']}/splats", {"view": _view_of(info), "views": 16, "size": 64, "samples": 2, "steps": 20, "points": 2000})
        assert st == 200
        assert wait_for(lambda: call("GET", f"/splats/{j['id']}")[1]["status"] in server.FINISHED, 300)
        done = call("GET", f"/splats/{j['id']}")[1]
        assert done["status"] == "done", (done, (Path(done["folder"]) / "fit.log").read_text())
        assert done["result"]["device"] == "cuda:0" and done["result"]["gsplat"] == "1.4.0" and "splat.ply" in done["files"]
        assert srv.gpu_share.budget.used <= srv.gpu_share.budget.total and wait_for(lambda: srv.gpu_share.budget.used < (1 << 30), 5)
    finally:
        srv.shutdown()
        srv.server_close()
