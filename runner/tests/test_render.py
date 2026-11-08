"""The render service's package: OME-Zarr levels (made ones included), presets, the CUDA path tracer, the HTTP service.

Tests that render need CuPy and a CUDA GPU, and are skipped without them.
"""

from __future__ import annotations

import json
import threading
import time
import urllib.request
import zlib
from pathlib import Path

import numpy as np
import pytest

zarr = pytest.importorskip("zarr")

from ngplatform_render import movie, presets, volumes  # noqa: E402
from ngplatform_render.camera import bounds, framing_radius, orbit  # noqa: E402


def _gpu() -> bool:
    try:
        import cupy

        return cupy.cuda.runtime.getDeviceCount() > 0
    except Exception:  # noqa: BLE001
        return False


needs_gpu = pytest.mark.skipif(not _gpu(), reason="needs CuPy and a CUDA GPU")


def write_store(path: Path, data: np.ndarray, voxel_um: float = 500.0, levels: int = 1, version: str = "0.5", labels: bool = False) -> str:
    """An OME-Zarr (zarr v3) of `data` (z, y, x) with `levels` levels made by 2x means (or striding for labels)."""
    g = zarr.open_group(str(path), mode="w", zarr_format=3)
    datasets = []
    a = data
    for i in range(levels):
        g.create_array(str(i), data=a, chunks=tuple(min(32, s) for s in a.shape))
        s = voxel_um * 2**i
        datasets.append({"path": str(i), "coordinateTransformations": [{"type": "scale", "scale": [s, s, s]}, {"type": "translation", "translation": [(2**i - 1) * voxel_um / 2] * 3}]})
        a = a[::2, ::2, ::2] if labels else np.rint(volumes._reduce2(a, False)).astype(a.dtype)
    ms = {"axes": [{"name": n, "type": "space", "unit": "micrometer"} for n in "zyx"], "datasets": datasets, "name": path.name}
    g.attrs["ome"] = {"version": version, "multiscales": [ms], **({"image-label": {}} if labels else {})}
    return str(path)


def ball(n: int = 48, r: float = 0.35) -> np.ndarray:
    z, y, x = np.mgrid[:n, :n, :n] / (n - 1) - 0.5
    d = np.sqrt(x * x + y * y + z * z)
    return np.where(d < r, 180 + 40 * (d < r * 0.5), 5).astype(np.uint8)


def test_levels_and_affine(tmp_path):
    url = write_store(tmp_path / "a.ome.zarr", ball(), levels=3)
    ms = volumes.open_multiscale(url)
    assert [lv.path for lv in ms.levels] == ["0", "1", "2"]
    assert ms.levels[0].voxel_mm == pytest.approx((0.5, 0.5, 0.5))
    L = volumes.load(url, budget=48**3)
    assert L.level == "0" and L.data.shape == (48, 48, 48) and not L.made
    # Voxel (x, y, z) = (1, 2, 3) is at physical mm (0.5, 1.0, 1.5).
    assert L.affine @ [1, 2, 3, 1] == pytest.approx([0.5, 1.0, 1.5, 1])


def test_made_levels_from_one_level(tmp_path, monkeypatch):
    monkeypatch.setenv("NGP_RENDER_CACHE", str(tmp_path / "cache"))
    data = ball(64)
    url = write_store(tmp_path / "one.ome.zarr", data, levels=1)
    L = volumes.load(url, budget=20_000)  # 64^3 > budget: made 4x (16^3 = 4096)
    assert L.made and not L.from_cache and L.level == "0/4x" and L.data.shape == (16, 16, 16)
    want = data.reshape(16, 4, 16, 4, 16, 4).astype(np.float64).mean(axis=(1, 3, 5))
    assert np.abs(L.data.astype(np.float64) - np.rint(want)).max() <= 1
    # A coarse voxel's centre is the mean of the fine ones it covers.
    assert L.affine @ [0, 0, 0, 1] == pytest.approx([0.75, 0.75, 0.75, 1])
    again = volumes.load(url, budget=20_000)
    assert again.from_cache and np.array_equal(again.data, L.data)


def test_made_level_matches_a_stored_one(tmp_path, monkeypatch):
    monkeypatch.setenv("NGP_RENDER_CACHE", str(tmp_path / "cache"))
    url = write_store(tmp_path / "b.ome.zarr", ball(64), levels=2)
    made = volumes.load(url, make_from="0", factor=2)
    stored = volumes.load(url, level="1")
    assert np.array_equal(made.data, stored.data)
    assert np.allclose(made.affine, stored.affine)


def test_label_majority():
    a = np.zeros((2, 2, 2), np.uint16)
    a[0, 0, 0] = 7
    a[1, 1, 1] = 7
    a[0, 1, 0] = 7
    assert volumes._reduce2(a, True)[0, 0, 0] == 0
    a[1, 0, 0] = 7
    a[0, 0, 1] = 7
    assert volumes._reduce2(a, True)[0, 0, 0] == 7


def test_presets_and_transfer_table():
    ps = presets.builtin()
    assert "HiP-CT brain" in ps and "Regions (labels)" in ps
    vol = volumes.Loaded(np.zeros((1, 1, 1), np.uint8), np.eye(4), 0.0, 255.0, {0.0: 10.0, 50.0: 100.0, 99.9: 200.0}, "0", (1, 1, 1), (1, 1, 1))
    p = presets.Preset.from_dict({"name": "t", "domain": "percentile", "stops": [{"value": 0, "color": [0, 0, 0], "opacity": 0}, {"value": 99.9, "color": [1, 1, 1], "opacity": 1}]})
    tab = presets.transfer_table(p, vol).reshape(-1, 4)
    # Opacity 0 below the background (10/255), 1 at 200/255.
    t = np.linspace(0, 1, len(tab))
    assert tab[t < 10 / 255, 3].max() == 0
    assert tab[t > 200 / 255, 3].min() == pytest.approx(1)
    with pytest.raises(ValueError):
        presets.Preset.from_dict({"name": "x", "domain": "hounsfield"})


def test_keyframes_interpolate_orbit():
    c = orbit((0, 0, 0), 100, 0, 0)
    d = orbit((0, 0, 0), 100, 90, 0)

    def view(cam):
        vp = cam.view_projection(400, 300)
        return {"inv_view_projection": np.linalg.inv(vp).T.ravel().tolist(), "width": 400, "height": 300, "overrides": {"exposure": 1.0}, "orbit_center": [0, 0, 0]}

    frames = movie.frames_for([{"time": 0, "view": view(c)}, {"time": 1, "view": {**view(d), "overrides": {"exposure": 2.0}}}], fps=4)
    assert len(frames) == 5
    eyes = [movie.camera_from_inverse(f["inv_view_projection"])[0].eye for f in frames]
    # The eye stays on the orbit (distance 100) and moves from azimuth 0 to 90.
    assert [np.linalg.norm(e) for e in eyes] == pytest.approx([100] * 5, rel=1e-3)
    assert eyes[0] == pytest.approx(c.eye, abs=1e-2) and eyes[-1] == pytest.approx(d.eye, abs=1e-2)
    assert frames[2]["overrides"]["exposure"] == pytest.approx(1.5)


@needs_gpu
def test_render_ball(tmp_path):
    from ngplatform_render import renderer

    data = ball(48)
    L = volumes.Loaded(data, np.diag([0.5, 0.5, 0.5, 1.0]), 0.0, 255.0, volumes.tissue_percentiles(data, 0, 255), "0", (0.5,) * 3, data.shape)
    R = renderer.Renderer(0)
    R.set_volume(renderer.Volume(L.data, L.affine, L.lo, L.hi, L.percentiles))
    lo, hi = bounds(L.affine, data.shape)
    cam = orbit((lo + hi) / 2, framing_radius(lo, hi, 30), 30, 20)
    st = renderer.RenderState(np.linalg.inv(cam.view_projection(96, 72)), 96, 72, presets.builtin()["HiP-CT brain"])
    R.set_view(st)
    R.step(32)
    img = R.image()
    d = R.depth()
    assert img.shape == (72, 96, 4)
    covered = img[..., 3] > 128
    # The ball fills the middle of the view and nothing at the corners; it is lit (not black) where it is.
    assert covered[36, 48] and not covered[0, 0]
    assert img[covered, :3].mean() > 60
    assert (d[..., 0] < 1)[36, 48] and d[0, 0, 0] == 1
    # A cut through the middle that keeps x < centre leaves only part of the ball.
    centre = (lo + hi) / 2
    st2 = renderer.RenderState(st.inv_view_projection, 96, 72, st.preset, clips=[(-1.0, 0.0, 0.0, float(centre[0]))])
    R.set_view(st2)
    R.step(8)
    assert 0 < (R.image()[..., 3] > 128).sum() < covered.sum()
    # A clip box of the volume's lower half in x (voxel coordinates) leaves part of it too.
    st3 = renderer.RenderState(st.inv_view_projection, 96, 72, st.preset, crop=((-0.5, -0.5, -0.5), (23.5, 47.5, 47.5)))
    R.set_view(st3)
    R.step(8)
    assert 0 < (R.image()[..., 3] > 128).sum() < covered.sum()


@needs_gpu
def test_service_session(tmp_path, monkeypatch):
    from ngplatform_render import server

    monkeypatch.setenv("NGP_RENDER_CACHE", str(tmp_path / "cache"))
    url = write_store(tmp_path / "s.ome.zarr", ball(48), levels=2)
    srv = server.RenderServer(0, "tok", [tmp_path], 0, tmp_path / "renders")
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{srv.server_port}"

    def call(method, path, body=None, raw=False, token="tok"):
        r = urllib.request.Request(base + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                   headers={"X-NGP-Service-Token": token, "Content-Type": "application/json"})
        with urllib.request.urlopen(r, timeout=60) as f:
            data = f.read()
            return (f.status, f.headers, data) if raw else json.loads(data or b"null")

    with pytest.raises(urllib.error.HTTPError):
        call("GET", "/info", token="wrong")
    s = call("POST", "/sessions", {"volume": {"url": url}})
    for _ in range(200):
        info = call("GET", f"/sessions/{s['id']}")
        if info["status"] != "loading":
            break
        time.sleep(0.05)
    assert info["status"] == "ready", info
    A = np.asarray(info["volume"]["affine"]).reshape(4, 4).T
    lo, hi = bounds(A, info["volume"]["shape"])
    cam = orbit((lo + hi) / 2, framing_radius(lo, hi, 30), 0, 0)
    call("PUT", f"/sessions/{s['id']}/view", {"inv_view_projection": np.linalg.inv(cam.view_projection(64, 48)).T.ravel().tolist(), "width": 64, "height": 48, "max_samples": 8})
    st, h, data = call("GET", f"/sessions/{s['id']}/frame?after=0&timeout=20", raw=True)
    assert st == 200 and h["Content-Type"] == "image/webp" and int(h["X-Samples"]) >= 1
    st, h, dz = call("GET", f"/sessions/{s['id']}/depth", raw=True)
    depth = np.frombuffer(zlib.decompress(dz), np.float16).reshape(int(h["X-Height"]), int(h["X-Width"]))
    assert depth.shape == (48, 64) and depth.min() < 1
    with pytest.raises(urllib.error.HTTPError):
        call("POST", f"/sessions/{s['id']}/movies", {"keyframes": [{"time": 0, "view": {}}], "output": "/etc"})
    srv.shutdown()


def test_movie_names_stay_in_their_folder():
    from ngplatform_render.server import safe_name

    assert safe_name("/tmp/x") == "tmp_x"
    assert safe_name("../../../.config/x") == "config_x"
    assert safe_name('a"b\r\nc') == "a_b_c"
    assert safe_name("") == "movie"


def test_labels_above_65535_keep_their_identity():
    from ngplatform_render.renderer import label_index

    data = np.array([[[0, 484682470, 65537], [1, 65537, 0]]], np.uint32)
    ids, index = label_index(data)
    assert list(ids) == [0, 1, 65537, 484682470]
    assert index.dtype == np.uint16 and ids[index].tolist() == data.tolist()
    small = np.array([[[0, 3, 7]]], np.uint16)
    ids, index = label_index(small)
    assert len(ids) == 8 and np.array_equal(index, small)


def test_movie_frames_take_the_movie_shape():
    c = orbit((0, 0, 0), 100, 0, 0)

    def view(cam, w, h):
        return {"inv_view_projection": np.linalg.inv(cam.view_projection(w, h)).T.ravel().tolist(), "width": w, "height": h, "orbit_center": [0, 0, 0]}

    # Keyframes from a square panel, a 16:9 movie: the frames' projection is 16:9.
    frames = movie.frames_for([{"time": 0, "view": view(c, 500, 500)}, {"time": 1, "view": view(orbit((0, 0, 0), 100, 30, 0), 500, 500)}], 2, aspect=16 / 9)
    _, aspect, _, _ = movie.camera_from_inverse(frames[1]["inv_view_projection"])
    assert aspect == pytest.approx(16 / 9, rel=1e-3)


def test_orthographic_keyframes_are_refused():
    ortho = np.eye(4)
    ortho[2, 2] = -0.01
    with pytest.raises(ValueError, match="perspective"):
        movie.camera_from_inverse(np.linalg.inv(ortho).T.ravel().tolist())


def test_local_stores_only_under_the_roots(tmp_path):
    from ngplatform_render.server import BadRequest, RenderServer

    srv = RenderServer(0, "tok", [tmp_path], 0, tmp_path / "renders")
    try:
        srv.check_source(str(tmp_path / "a.ome.zarr"))
        srv.check_source("gs://bucket/a.ome.zarr")
        srv.check_source("https://host/a.ome.zarr")
        with pytest.raises(BadRequest):
            srv.check_source("/etc/passwd")
        with pytest.raises(BadRequest):
            srv.check_source(str(tmp_path / ".." / "elsewhere.zarr"))
    finally:
        srv.server_close()


def test_rotation_ranges_and_reshaped_stills():
    c = orbit((0, 0, 0), 100, 0, 0)
    v = {"inv_view_projection": np.linalg.inv(c.view_projection(400, 300)).T.ravel().tolist(), "width": 400, "height": 300, "orbit_center": [0, 0, 0]}
    full = movie.rotation_frames(v, "vertical", 360, 90)
    assert len(full) == 4  # 0, 90, 180, 270: the last frame is not the first again
    half = movie.rotation_frames(v, "horizontal", 180, 45)
    assert len(half) == 5
    eyes = [movie.camera_from_inverse(f["inv_view_projection"], [0, 0, 0])[0].eye for f in full]
    assert [np.linalg.norm(e) for e in eyes] == pytest.approx([100] * 4, rel=1e-3)
    assert eyes[2] == pytest.approx(-eyes[0], abs=1e-2)
    wide = movie.reshaped(v["inv_view_projection"], 2.0, [0, 0, 0])
    cam, aspect, _, _ = movie.camera_from_inverse(wide, [0, 0, 0])
    assert aspect == pytest.approx(2.0) and cam.eye == pytest.approx(c.eye, abs=1e-3)


def test_light_maps(tmp_path):
    from ngplatform_render import lightmaps

    assert {"studio", "photo-studio", "sky"} <= set(lightmaps.names())
    m = lightmaps.load("sky")
    assert m.shape == (128, 256, 3) and np.isfinite(m).all() and m.max() > 1
    # A flat (not run-length encoded) RGBE file: 1.0 is mantissa 128 at exponent 129.
    hdr = tmp_path / "t.hdr"
    hdr.write_bytes(b"#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 1 +X 2\n" + bytes([128, 64, 0, 129, 128, 128, 128, 130]))
    assert lightmaps.read_rgbe(hdr).tolist() == [[[1.0, 0.5, 0.0], [2.0, 2.0, 2.0]]]
