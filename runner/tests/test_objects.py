"""The image within objects (objects.py): pages the surface passes through and those wholly inside, each
brick's voxels kept inside the mesh and 0 outside, and the tables that find a page's brick."""

from __future__ import annotations

import json
import os

import numpy as np
import pytest

import helpers  # noqa: F401 - puts the runner on the path

cp = pytest.importorskip("cupy")
try:
    cp.cuda.runtime.getDeviceCount()
except Exception:  # pragma: no cover - no GPU
    pytest.skip("no CUDA device", allow_module_level=True)

from ngplatform_render import geometry, objects, volumes  # noqa: E402
from test_geometry import _sphere  # noqa: E402
from test_precomputed import _write_unsharded  # noqa: E402


def test_page_dims_are_about_cubic_in_space():
    assert objects.page_dims((8e-6, 8e-6, 40e-6)) == (32, 32, 8)
    assert objects.page_dims((16e-6, 16e-6, 40e-6)) == (32, 32, 16)
    assert objects.page_dims((64e-6, 64e-6, 80e-6)) == (8, 8, 8)
    assert objects.page_dims((1, 1, 1)) == (8, 8, 8)


def test_the_image_is_kept_inside_the_mesh_and_nowhere_else(tmp_path):
    rng = np.random.default_rng(3)
    n = (64, 96, 96)  # z, y, x at 8 x 8 x 8 nm... as voxels of 1 µm here
    vol = rng.integers(1, 255, n, dtype=np.uint8)
    info = {"type": "image", "data_type": "uint8", "num_channels": 1,
            "scales": [{"key": "s0", "size": [96, 96, 64], "resolution": [1000, 1000, 1000], "voxel_offset": [0, 0, 0],
                        "chunk_sizes": [[32, 32, 32]], "encoding": "raw"}]}
    (tmp_path / "info").write_text(json.dumps(info))
    _write_unsharded(tmp_path, "s0", vol, (32, 32, 32), (0, 0, 0))
    url = f"precomputed://{tmp_path}"
    ms = volumes.open_multiscale(url)
    lv = ms.levels[0]
    # A sphere of radius 20 voxels about voxel (48, 40, 30), in physical mm (1 µm voxels).
    centre_vox = np.array([48.0, 40.0, 30.0])
    r = 20.0
    tris_vox = _sphere(60).astype(np.float64) * r + centre_vox
    A = np.asarray(lv.affine)
    tris = (tris_vox.reshape(-1, 3) @ A[:3, :3].T + A[:3, 3]).reshape(-1, 3, 3)
    bvh = geometry.build(tris.astype(np.float32))
    ob = objects.build(url, ms, tris, bvh, budget=10**8, to_u8=lambda a: a)
    assert ob.page == (8, 8, 8)
    assert ob.stats["surface_pages"] > 0
    # Every voxel of the volume, found through the tables, against the sphere.
    zz, yy, xx = np.meshgrid(np.arange(n[0]), np.arange(n[1]), np.arange(n[2]), indexing="ij")
    vox = np.stack([xx, yy, zz], -1).reshape(-1, 3)
    P = np.array(ob.page)
    B = P + 2
    pg = vox // P
    rel = pg - np.array(ob.origin)
    cell, loc = rel // objects.TOP, rel % objects.TOP
    ok = (cell >= 0).all(1) & (cell < np.array(ob.top.shape[::-1])).all(1)
    brick = np.full(len(vox), -1)
    t = np.full(len(vox), -1)
    t[ok] = ob.top[cell[ok, 2], cell[ok, 1], cell[ok, 0]]
    has = t >= 0
    brick[has] = ob.sub[t[has], loc[has, 2], loc[has, 1], loc[has, 0]]
    ax, ay, _ = ob.atlas_grid
    got = np.zeros(len(vox), np.int64)
    k = brick >= 0
    bx, by, bz = brick[k] % ax, (brick[k] // ax) % ay, brick[k] // (ax * ay)
    lp = vox[k] - pg[k] * P + 1
    got[k] = ob.atlas[bz * B[2] + lp[:, 2], by * B[1] + lp[:, 1], bx * B[0] + lp[:, 0]]
    d = np.linalg.norm(vox - centre_vox, axis=1)
    want = vol.reshape(-1).astype(np.int64)
    inside, outside = d < r - 0.6, d > r + 0.6  # the mesh is a polygon a little inside the sphere
    assert (got[inside] == want[inside]).mean() > 0.999
    assert (got[outside] == 0).all()
    # About the sphere's volume in voxels.
    assert abs(ob.inside_voxels - 4 / 3 * np.pi * r**3) / (4 / 3 * np.pi * r**3) < 0.05


def test_objects_render_their_surfaces_and_the_image_within_them(tmp_path):
    """The image within a sphere, drawn as objects: the sphere fills the middle of the view, nothing is drawn
    outside it (though the volume around it has values there too), and its surface alone draws it too."""
    from ngplatform_render import presets, renderer
    from ngplatform_render.camera import framing_radius, orbit

    rng = np.random.default_rng(4)
    n = (64, 64, 64)
    vol = rng.integers(120, 255, n, dtype=np.uint8)
    info = {"type": "image", "data_type": "uint8", "num_channels": 1,
            "scales": [{"key": "s0", "size": [64, 64, 64], "resolution": [1000, 1000, 1000], "voxel_offset": [0, 0, 0],
                        "chunk_sizes": [[32, 32, 32]], "encoding": "raw"}]}
    (tmp_path / "info").write_text(json.dumps(info))
    _write_unsharded(tmp_path, "s0", vol, (32, 32, 32), (0, 0, 0))
    url = f"precomputed://{tmp_path}"
    ms = volumes.open_multiscale(url)
    A = np.asarray(ms.levels[0].affine)
    centre_vox, r = np.array([32.0, 32.0, 32.0]), 14.0
    tris = ((_sphere(40).astype(np.float64) * r + centre_vox).reshape(-1, 3) @ A[:3, :3].T + A[:3, 3]).reshape(-1, 3, 3)
    bvh = geometry.build(tris.astype(np.float32))
    ob = objects.build(url, ms, tris, bvh, budget=10**8, to_u8=lambda a: a)

    R = renderer.Renderer(0)
    R.set_volume(renderer.Volume(vol, A, 0.0, 255.0, volumes.tissue_percentiles(vol, 0, 255)))
    R.set_objects(renderer.Objects(bvh, ob, np.array([[0.9, 0.3, 0.2]]), np.eye(4), surface=0.0, image=True))
    lo = A[:3, 3] - A[0, 0] / 2
    hi = lo + A[0, 0] * 64
    cam = orbit((lo + hi) / 2, framing_radius(lo, hi, 30), 30, 20)
    p = presets.builtin()["HiP-CT brain"].with_overrides(density=2000.0)
    st = renderer.RenderState(np.linalg.inv(cam.view_projection(96, 96)), 96, 96, p, denoise=False)
    R.set_view(st)
    R.step(16)
    img = R.image()
    covered = img[..., 3] > 128
    assert covered[48, 48] and not covered[0, 0] and not covered[48, 2]
    # A disc about the middle: the sphere's projection, well inside the frame (the volume fills it all).
    assert 0.02 < covered.mean() < 0.3
    assert img[covered, :3].mean() > 30
    d = R.depth()
    assert d[48, 48, 0] < 1 and d[0, 0, 0] == 1
    # The surface alone (opaque) draws the same disc, in the object's colour (red over blue).
    R.set_object_look(surface=1.0, image=False, mix=0.0)
    R.set_view(st)
    R.step(16)
    img2 = R.image()
    if os.environ.get("NGP_TEST_SAVE"):
        from PIL import Image

        Image.fromarray(np.concatenate([img, img2], 1)).save(os.environ["NGP_TEST_SAVE"])
    cov2 = img2[..., 3] > 128
    assert abs(cov2.mean() - covered.mean()) < 0.05
    assert img2[cov2, 0].mean() > img2[cov2, 2].mean()
    R.close()


def _write_legacy_mesh_segmentation(root, sid: int, tris_nm: np.ndarray):
    """A precomputed segmentation with one segment's legacy mesh (vertices in nm, one fragment)."""
    root.mkdir(parents=True, exist_ok=True)
    (root / "info").write_text(json.dumps({"type": "segmentation", "data_type": "uint64", "num_channels": 1, "mesh": "mesh",
                                           "scales": [{"key": "s0", "size": [1, 1, 1], "resolution": [1000, 1000, 1000],
                                                       "voxel_offset": [0, 0, 0], "chunk_sizes": [[1, 1, 1]], "encoding": "raw"}]}))
    (root / "mesh").mkdir()
    (root / "mesh" / "info").write_text(json.dumps({"@type": "neuroglancer_legacy_mesh"}))
    (root / "mesh" / f"{sid}:0").write_text(json.dumps({"fragments": [f"{sid}:0:0"]}))
    v = tris_nm.reshape(-1, 3).astype(np.float32)
    f = np.arange(len(v), dtype=np.uint32).reshape(-1, 3)
    (root / "mesh" / f"{sid}:0:0").write_bytes(np.uint32(len(v)).tobytes() + v.tobytes() + f.tobytes())


def test_a_session_draws_chosen_segments_and_the_image_within_them(tmp_path, monkeypatch):
    import threading
    import time
    import urllib.request

    from ngplatform_render import server
    from ngplatform_render.camera import framing_radius, orbit
    from ngplatform_render.meshes import MeshSource

    monkeypatch.setenv("NGP_RENDER_CACHE", str(tmp_path / "cache"))
    rng = np.random.default_rng(5)
    vol = rng.integers(120, 255, (48, 48, 48), dtype=np.uint8)
    em = tmp_path / "em"
    em.mkdir()
    (em / "info").write_text(json.dumps({"type": "image", "data_type": "uint8", "num_channels": 1,
                                         "scales": [{"key": "s0", "size": [48, 48, 48], "resolution": [1000, 1000, 1000],
                                                     "voxel_offset": [0, 0, 0], "chunk_sizes": [[16, 16, 16]], "encoding": "raw"}]}))
    _write_unsharded(em, "s0", vol, (16, 16, 16), (0, 0, 0))
    # A sphere of radius 10 µm about (24.5, 24.5, 24.5) µm: voxel 24's centre (voxel centres at i + 0.5 µm).
    tris_nm = (_sphere(30).astype(np.float64) * 10 + 24.5) * 1000
    _write_legacy_mesh_segmentation(tmp_path / "seg", 7, tris_nm)
    m = MeshSource(f"precomputed://{tmp_path / 'seg'}").mesh(7)
    assert m is not None and len(m.faces) == len(tris_nm)

    srv = server.RenderServer(0, "tok", [tmp_path], 0, tmp_path / "renders")
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{srv.server_port}"

    def call(method, path, body=None):
        r = urllib.request.Request(base + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                   headers={"X-NGP-Service-Token": "tok", "Content-Type": "application/json"})
        with urllib.request.urlopen(r, timeout=60) as f:
            return json.loads(f.read() or b"null")

    s = call("POST", "/sessions", {"volume": {"url": f"precomputed://{em}"},
                                   "objects": {"url": f"precomputed://{tmp_path / 'seg'}", "ids": ["7"], "budget": 10**7}})
    for _ in range(400):
        info = call("GET", f"/sessions/{s['id']}")
        if info["status"] != "loading":
            break
        time.sleep(0.05)
    assert info["status"] == "ready", info
    assert info["objects"]["ids"] == ["7"] and info["objects"]["bricks"] > 0
    lo, hi = np.zeros(3), np.full(3, 0.048)
    cam = orbit((lo + hi) / 2, framing_radius(lo, hi, 30), 0, 0)
    view = {"inv_view_projection": np.linalg.inv(cam.view_projection(64, 64)).T.ravel().tolist(), "width": 64, "height": 64,
            "max_samples": 8, "preset": "HiP-CT brain", "overrides": {"density": 3000.0}, "objects": {"surface": 0.0, "image": True}}
    call("PUT", f"/sessions/{s['id']}/view", view)
    with urllib.request.urlopen(urllib.request.Request(base + f"/sessions/{s['id']}/frame?after=0&timeout=20", headers={"X-NGP-Service-Token": "tok"}), timeout=60) as f:
        assert int(f.headers["X-Samples"]) >= 1
    with urllib.request.urlopen(urllib.request.Request(base + f"/sessions/{s['id']}/depth", headers={"X-NGP-Service-Token": "tok"}), timeout=60) as f:
        import zlib

        depth = np.frombuffer(zlib.decompress(f.read()), np.float16).reshape(int(f.headers["X-Height"]), int(f.headers["X-Width"]))
    # The sphere in the middle, nothing at the corners (the volume fills the box, but only the sphere is drawn).
    assert depth[32, 32] < 1 and depth[0, 0] == 1 and depth[32, 2] == 1
    # A still of the view draws the objects too: the tissue in the middle, the background (flattened) at the corners.
    j = call("POST", f"/sessions/{s['id']}/stills", {"view": view, "width": 64, "height": 64, "samples": 16, "background": [0, 0, 0, 0]})
    for _ in range(600):
        info = call("GET", f"/stills/{j['id']}")
        if info["status"] in ("done", "failed", "cancelled"):
            break
        time.sleep(0.1)
    assert info["status"] == "done", info
    from PIL import Image

    still = np.asarray(Image.open(info["file"]).convert("RGBA"))
    assert still[32, 32, :3].mean() > 60 and still[0, 0, :3].max() == 0, (still[32, 32], still[0, 0])
    srv.shutdown()
