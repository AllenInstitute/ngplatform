"""Splats: the capture cameras agree with the renderer's rays, and the files read back (no GPU, no torch)."""

import numpy as np

from ngplatform_render.renderer import look_at
from ngplatform_render.splat import export as E
from ngplatform_render.splat import views as V


def _view(eye=(0.0, -100.0, 20.0), target=(0.0, 0.0, 0.0), up=(0.0, 0.0, 1.0), w=320, h=200):
    vp = look_at(np.array(eye), np.array(target), np.array(up), 30.0, w / h, 5.0, 400.0)
    return {"inv_view_projection": np.linalg.inv(vp).T.ravel().tolist(), "width": w, "height": h, "orbit_center": list(target),
            "light": {"direction": [0.0, 0.0, 1.0], "camera_space": True}}


def test_directions_cover_a_cap_evenly():
    d = V.directions(500, (0, 0, 1), 90)
    assert np.allclose(np.linalg.norm(d, axis=1), 1)
    assert d[:, 2].min() >= -1e-9  # a half sphere about +z
    assert abs(d[:, 2].mean() - 0.5) < 0.02  # even in area: mean height of a hemisphere is 1/2


def test_cameras_the_first_the_views_own_and_all_looking_at_the_centre():
    view = _view()
    cams, near, far, centre = V.capture_cameras(view, 33, 180, closer=0.25)
    assert len(cams) == 33
    assert np.allclose(cams[0].eye, [0, -100, 20], atol=1e-6)
    d0 = np.linalg.norm(cams[0].eye - centre)
    dists = sorted(np.linalg.norm(c.eye - centre) for c in cams)
    assert np.isclose(dists[0], d0 * 0.6) and np.isclose(dists[-1], d0)
    assert near < far


def test_opencv_camera_projects_as_the_renderer_draws():
    """A pixel's ray, as the renderer makes it, lands on that pixel through K and the camera."""
    view = _view()
    cam = V.capture_cameras(view, 9, 180)[0][3]
    W, H = 320, 200
    v = V.capture_view(view, cam, W, H, 5.0, 400.0, view["light"])
    o, d = V.rays(v["inv_view_projection"], W, H)
    c2w, K = V.opencv(cam, W, H)
    assert np.isclose(np.linalg.det(c2w[:3, :3]), 1.0)
    w2c = np.linalg.inv(c2w)
    for x, y in ((0, 0), (W - 1, 0), (17, 150), (W // 2, H // 2)):
        p = o[y, x] + d[y, x] * 37.0
        pc = w2c[:3, :3] @ p + w2c[:3, 3]
        assert pc[2] > 0
        uv = (K @ (pc / pc[2]))[:2]
        assert np.allclose(uv, [x + 0.5, y + 0.5], atol=1e-6)


def test_light_held_where_it_is_in_world_space():
    view = _view()
    light = V.world_light(view)
    assert light["camera_space"] is False
    # "back" in camera space: towards the camera from the target.
    back = np.array([0, -100, 20]) / np.linalg.norm([0, -100, 20])
    assert np.allclose(light["direction"], back, atol=1e-6)


def test_seed_points_are_where_the_rays_meet_tissue(tmp_path):
    view = _view()
    W, H = 320, 200
    dist = np.full((H, W), -1.0, np.float32)
    dist[50:150, 100:200] = 80.0
    rgb = np.full((H, W, 3), 200, np.uint8)
    alpha = np.where(dist >= 0, 255, 0).astype(np.uint8)
    p, c = V.seed_points(view["inv_view_projection"], dist, rgb, alpha, 500, np.random.default_rng(1))
    assert len(p) == 500 and np.allclose(c, 200 / 255)
    o, d = V.rays(view["inv_view_projection"], W, H)
    assert np.allclose(np.linalg.norm(p - o[100, 150], axis=1).max() < 200, True)
    V.write_points(tmp_path / "points.ply", p, c)
    p2, c2 = V.read_points(tmp_path / "points.ply")
    assert np.allclose(p, p2) and np.allclose(c, c2, atol=1 / 255)


def test_splat_and_ply_files(tmp_path):
    n = 5
    rng = np.random.default_rng(0)
    means = rng.normal(size=(n, 3)).astype(np.float32)
    scales = np.log(np.full((n, 3), 0.1, np.float32))
    quats = np.tile([1.0, 0, 0, 0], (n, 1)).astype(np.float32)
    op = np.zeros(n, np.float32)
    sh = np.zeros((n, 16, 3), np.float32)
    b = E.splat_bytes(means, scales, quats, op, sh)
    assert len(b) == 32 * n
    rec = np.frombuffer(b, dtype=[("p", "<f4", 3), ("s", "<f4", 3), ("c", "u1", 4), ("q", "u1", 4)])
    assert np.allclose(rec["s"], 0.1) and (rec["c"][:, 3] == 127).all() and (rec["q"][:, 0] == 255).all()
    E.write_ply(tmp_path / "s.ply", means, scales, quats, op, sh)
    head = (tmp_path / "s.ply").read_bytes().split(b"end_header\n")[0].decode()
    assert "property float f_rest_44" in head and "property float rot_3" in head


def test_cameras_files(tmp_path):
    view = _view()
    cams, near, far, centre = V.capture_cameras(view, 4, 180)
    recs = [V.camera_record(f"images/{i:05d}.png", c, 64, 40) for i, c in enumerate(cams)]
    V.write_cameras(tmp_path, recs, centre, {})
    import json

    t = json.loads((tmp_path / "transforms.json").read_text())
    # nerfstudio's camera looks down its -z.
    m = np.asarray(t["frames"][0]["transform_matrix"])
    fwd = -m[:3, 2]
    assert np.allclose(fwd, (centre - cams[0].eye) / np.linalg.norm(centre - cams[0].eye), atol=1e-6)
