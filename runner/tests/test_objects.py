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
    assert objects.page_dims((32e-6, 32e-6, 40e-6)) == (32, 32, 32)
    assert objects.page_dims((1, 1, 1)) == (32, 32, 32)


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
    assert ob.page == (32, 32, 32)
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
