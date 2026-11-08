"""The render service's package: OME-Zarr levels (made ones included), presets, the CUDA path tracer, the HTTP service.

Tests that render need CuPy and a CUDA GPU, and are skipped without them.
"""

from __future__ import annotations

import json
import math
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
    # Frames as a JPEG and its alpha plane, for a view that asks; while moving (half size), fast tracking.
    from PIL import Image
    import io as _io

    v = call("PUT", f"/sessions/{s['id']}/view", {"inv_view_projection": np.linalg.inv(cam.view_projection(64, 48)).T.ravel().tolist(), "width": 64, "height": 48,
                                                "scale": 0.5, "max_samples": 4, "frame_format": "jpeg"})["version"]
    after = 0
    for _ in range(50):
        st, h, data = call("GET", f"/sessions/{s['id']}/frame?after={after}&timeout=20", raw=True)
        after = int(h["X-Frame"])
        if int(h["X-Version"]) == v:
            break
    off = int(h["X-Alpha-Offset"])
    assert h["Content-Type"] == "image/jpeg" and Image.open(_io.BytesIO(data[:off])).size == (32, 24)
    alpha = np.frombuffer(zlib.decompress(data[off:]), np.uint8).reshape(24, 32)
    assert alpha[12, 16] > 128 and alpha[0, 0] == 0
    srv.shutdown()


@needs_gpu
def test_fast_tracking_is_close_and_passes_stop_for_a_new_view():
    from ngplatform_render import renderer

    data = ball(48)
    R = renderer.Renderer(0)
    R.set_volume(renderer.Volume(data, np.diag([0.5, 0.5, 0.5, 1.0]), 0.0, 255.0, volumes.tissue_percentiles(data, 0, 255)))
    lo, hi = bounds(np.diag([0.5, 0.5, 0.5, 1.0]), data.shape)
    cam = orbit((lo + hi) / 2, framing_radius(lo, hi, 30), 30, 20)
    p = presets.builtin()["HiP-CT brain"].with_overrides(density=40.0)
    means = []
    for fast in (0.0, 1.0):
        R.set_view(renderer.RenderState(np.linalg.inv(cam.view_projection(96, 72)), 96, 72, p, fast=fast, denoise=False))
        R.step(64)
        img = R.image()
        means.append(img[img[..., 3] > 128, :3].astype(float).mean())
    # Steps a voxel long, the collision found by bisection: within a few per cent of exact tracking
    # (measured: -0.3% at 20 per mm, -3% at 40, -7% at 80 on this ball of 0.5 mm voxels).
    assert abs(means[1] - means[0]) < 0.05 * means[0], means
    # A pass in bands stops when asked, and does not count as a sample.
    R.set_view(renderer.RenderState(np.linalg.inv(cam.view_projection(96, 72)), 96, 72, p))
    R._band_rows = 8
    assert R.step(1, stop=lambda: True) == 0
    assert R.step(1, stop=lambda: False) == 1


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


def test_tissue_box():
    q = np.zeros((40, 40, 40), np.uint8)
    q[8:20, 4:36, 12:16] = 200  # z, y, x
    lo, hi = volumes.tissue_box(q, np.diag([0.5, 0.5, 0.5, 1.0]), 10.0, 0.0, 255.0)
    # Sampled every 4th voxel, so the box is within 4 voxels (2 mm) of the tissue.
    assert lo == pytest.approx([6.0, 2.0, 4.0], abs=2.0) and hi == pytest.approx([8.0, 18.0, 10.0], abs=2.0)
    assert volumes.tissue_box(np.zeros((8, 8, 8), np.uint8), np.eye(4), 10.0, 0.0, 255.0) is None


def _specimen(tissue: float, medium: float, dtype=np.uint16, calcium: float | None = None, seed: int = 0) -> np.ndarray:
    """A HiP-CT-like scan: a round jar (outside it 0) of medium, a ball of tissue, maybe a fleck of calcium."""
    rng = np.random.default_rng(seed)
    n = 64
    z, y, x = np.mgrid[:n, :n, :n].astype(np.float32)
    r_axis = np.hypot(y - (n - 1) / 2, x - (n - 1) / 2) / (n / 2)
    a = np.where(r_axis < 0.97, medium, 0.0) + rng.normal(0, abs(tissue - medium) * 0.04, (n, n, n)) * (r_axis < 0.97)
    ball = np.hypot(np.hypot(z - 32, y - 32), x - 30) < 18
    a[ball] = tissue + rng.normal(0, abs(tissue - medium) * 0.1, ball.sum())
    if calcium is not None:
        a[30:34, 30:34, 28:32] = calcium
    top = np.iinfo(dtype).max
    return np.clip(a, 0, top).astype(dtype)


@pytest.mark.parametrize("tissue,medium,calcium", [(30000, 20000, 65000), (8000, 20000, None), (180, 90, 255)])
def test_window_guess_puts_the_tissue_in_the_middle(tissue, medium, calcium):
    dtype = np.uint8 if tissue < 256 else np.uint16
    q = _specimen(tissue, medium, dtype, calcium)
    top = float(np.iinfo(dtype).max)
    lo, hi = volumes.guess_window(q, 0.0, top)
    # The medium is outside the window, and the tissue near its middle, whatever the calcium.
    assert not (lo <= medium <= hi)
    assert (lo + hi) / 2 == pytest.approx(tissue, rel=0.05)


def test_window_presets_take_the_window():
    vol = volumes.Loaded(np.zeros((1, 1, 1), np.uint16), np.eye(4), 0.0, 1000.0, {}, "0", (1, 1, 1), (1, 1, 1), window=(100.0, 300.0))
    p = presets.Preset.from_dict({"name": "w", "domain": "window", "stops": [{"value": 0, "color": [0, 0, 0], "opacity": 0}, {"value": 1, "color": [1, 1, 1], "opacity": 1}]})
    tab = presets.transfer_table(p, vol).reshape(-1, 4)
    t = np.linspace(0, 1, len(tab))
    assert tab[t < 0.1, 3].max() == 0 and tab[t > 0.3, 3].min() == pytest.approx(1)
    # The page's window wins over the guess.
    tab = presets.transfer_table(p.with_overrides(window=[500, 900]), vol).reshape(-1, 4)
    assert tab[t < 0.5, 3].max() == 0 and tab[t > 0.9, 3].min() == pytest.approx(1)
    with pytest.raises(ValueError):
        p.with_overrides(window=[5, 5])
    organs = [q for q in presets.builtin().values() if q.modality == "HiP-CT" and q.organ]
    assert len(organs) >= 10 and all(q.domain == "window" and q.reference for q in organs)


def test_hide_the_jar():
    q = _specimen(30000, 20000)
    volumes.hide_outside_cylinder(q, 0.9)
    assert q[:, 0, 0].max() == 0 and q[:, 32, 2].max() == 0  # a corner, and the jar's side
    assert q[32, 32, 30] > 25000  # the tissue stays


def test_detail_plan_picks_the_level_the_view_needs():
    from ngplatform_render import detail

    # Levels of a 64 mm cube: 0.25, 0.5 mm (finer than the coarse 1 mm one), finest first.
    def level(vox):
        A = np.diag([vox, vox, vox, 1.0])
        A[:3, 3] = vox / 2
        return (int(64 / vox),) * 3, A

    levels = [level(0.25), level(0.5)]
    centre = np.array([32.0, 32.0, 32.0])

    def view(radius, W=200, H=150):
        cam = orbit(centre, radius, 30, 20)
        inv = np.linalg.inv(cam.view_projection(W, H))
        ys, xs = np.mgrid[:H, :W]
        o, d = detail.pixel_rays(inv, W, H, xs.ravel().astype(float), ys.ravel().astype(float))
        # The view meets a ball of radius 20 mm about the centre.
        oc = o - centre
        b = (oc * d).sum(1)
        disc = b * b - ((oc * oc).sum(1) - 400)
        t = -b - np.sqrt(np.maximum(disc, 0))
        dist = np.where(disc > 0, t, -1.0).reshape(H, W)
        return inv, W, H, dist

    # The whole ball in view: a pixel is wider than the coarse voxel, so no finer detail.
    assert detail.plan(*view(400.0), levels, 1.0, 1e9) is None
    # Close: the finest level, around where the view meets the ball, within the level.
    inv, W, H, dist = view(30.0)
    i, lo, hi, nlo, nhi = detail.plan(inv, W, H, dist, levels, 1.0, 1e9)
    assert i == 0 and all(0 <= a < b <= 256 for a, b in zip(lo, hi)) and detail.contains((lo, hi), (nlo, nhi))
    assert math.prod(np.subtract(hi, lo).tolist()) < 256**3
    # A small budget: the coarser of the finer levels.
    i2, lo2, hi2, _, _ = detail.plan(inv, W, H, dist, levels, 1.0, math.prod(np.subtract(hi, lo).tolist()) // 4)
    assert i2 == 1
    # Nothing in view: nothing to read.
    assert detail.plan(inv, W, H, np.full_like(dist, -1.0), levels, 1.0, 1e9) is None


def test_detail_regions_read_through_the_chunk_cache(tmp_path):
    from ngplatform_render import detail

    data = (np.arange(40 * 50 * 60) % 251).astype(np.uint8).reshape(40, 50, 60)
    url = write_store(tmp_path / "r.ome.zarr", data, levels=1)
    ms = volumes.open_multiscale(url)
    cache = detail.ChunkCache(max_bytes=1 << 30)
    lo, hi = (5, 7, 3), (45, 33, 38)  # x, y, z
    a = detail.read_region(url, ms, ms.levels[0], lo, hi, cache=cache)
    assert np.array_equal(a, data[3:38, 7:33, 5:45])
    held = cache.bytes
    b = detail.read_region(url, ms, ms.levels[0], lo, hi, cache=cache)
    assert np.array_equal(a, b) and cache.bytes == held  # every chunk from the cache
    assert detail.read_region(url, ms, ms.levels[0], lo, hi, cache=cache, cancelled=lambda: True) is None


@needs_gpu
def test_a_session_reads_finer_detail_where_the_view_is_close(tmp_path, monkeypatch):
    from ngplatform_render import server

    monkeypatch.setenv("NGP_RENDER_CACHE", str(tmp_path / "cache"))
    url = write_store(tmp_path / "s.ome.zarr", ball(128), voxel_um=250.0, levels=3)
    srv = server.RenderServer(0, "tok", [tmp_path], 0, tmp_path / "renders")
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{srv.server_port}"

    def call(method, path, body=None, raw=False):
        r = urllib.request.Request(base + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                   headers={"X-NGP-Service-Token": "tok", "Content-Type": "application/json"})
        with urllib.request.urlopen(r, timeout=60) as f:
            data = f.read()
            return (f.status, f.headers, data) if raw else json.loads(data or b"null")

    # The whole volume at the coarsest level (32^3); detail from the 128^3 and 64^3 ones.
    s = call("POST", "/sessions", {"volume": {"url": url, "budget": 40000, "detail_budget": 4e6}})
    for _ in range(200):
        info = call("GET", f"/sessions/{s['id']}")
        if info["status"] != "loading":
            break
        time.sleep(0.05)
    assert info["status"] == "ready" and info["volume"]["shape"] == [32, 32, 32] and info["detail"]["levels"] == ["0", "1"], info
    A = np.asarray(info["volume"]["affine"]).reshape(4, 4).T
    lo, hi = bounds(A, info["volume"]["shape"])
    cam = orbit((lo + hi) / 2, 9.0, 0, 0)  # close to the ball's surface (radius 11 mm)
    call("PUT", f"/sessions/{s['id']}/view", {"inv_view_projection": np.linalg.inv(cam.view_projection(120, 90)).T.ravel().tolist(),
                                            "width": 120, "height": 90, "max_samples": 16})
    after, det = 0, ""
    for _ in range(100):
        st, h, _ = call("GET", f"/sessions/{s['id']}/frame?after={after}&timeout=5", raw=True)
        if st == 200:
            after = int(h["X-Frame"])
            det = h.get("X-Detail", "")
            if det.startswith("level 0"):
                break
    held = call("GET", f"/sessions/{s['id']}")["detail"]["held"]
    assert det.startswith("level 0") and held["path"] == "0" and held["voxels"] < 128**3, (det, held)
    srv.shutdown()
