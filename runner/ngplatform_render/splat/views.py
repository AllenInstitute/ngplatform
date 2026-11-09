"""The cameras a splat is fitted from, and the views of the scene they see.

Cameras look at the view's orbit centre from points spread evenly over a
sphere (a Fibonacci lattice), or over a cap of it about the direction the
view looks from, at the view's distance, and some of them closer (finer
detail where the viewer goes near).  Each is written in OpenCV's convention
(x right, y down, z forward; `c2w` takes camera to world coordinates,
`K` pixels from camera coordinates), which gsplat takes, and in
nerfstudio's `transforms.json` (OpenGL's: y up, z back) for other trainers.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import numpy as np

from ..camera import Camera
from ..movie import camera_from_inverse
from ..renderer import _camera_axes, look_at

GOLDEN = np.pi * (3 - np.sqrt(5))


def directions(n: int, axis, cap_deg: float = 180.0) -> np.ndarray:
    """`n` unit vectors spread evenly over the cap of half-angle `cap_deg` about `axis` (180: the whole sphere)."""
    axis = np.asarray(axis, np.float64)
    axis = axis / np.linalg.norm(axis)
    zmin = np.cos(np.radians(min(max(cap_deg, 1.0), 180.0)))
    i = np.arange(n) + 0.5
    z = 1 - i / n * (1 - zmin)  # even in z: even in area on the sphere
    r = np.sqrt(np.maximum(0.0, 1 - z * z))
    phi = i * GOLDEN
    local = np.stack([r * np.cos(phi), r * np.sin(phi), z], 1)
    # The lattice's pole on the axis.
    a = np.array([1.0, 0, 0]) if abs(axis[0]) < 0.9 else np.array([0, 1.0, 0])
    u = np.cross(axis, a)
    u /= np.linalg.norm(u)
    v = np.cross(axis, u)
    return local[:, :1] * u + local[:, 1:2] * v + local[:, 2:3] * axis


def capture_cameras(view: dict[str, Any], n: int, cap_deg: float = 180.0, closer: float = 0.25, closer_by: float = 0.6) -> tuple[list[Camera], float, float, np.ndarray]:
    """The cameras, the near and far planes, and the centre: about the view's orbit centre, the first
    camera the view's own, `closer` of the rest `closer_by` of its distance away."""
    cam, _, near, far = camera_from_inverse(view["inv_view_projection"], view.get("orbit_center"))
    centre = np.asarray(view.get("orbit_center") or cam.target, np.float64)
    off = cam.eye - centre
    dist = float(np.linalg.norm(off))
    if dist <= 0:
        raise ValueError("the camera is at the point it turns about")
    up0 = cam.up / np.linalg.norm(cam.up)
    n_close = int(round((n - 1) * min(max(closer, 0.0), 0.9)))
    n_far = n - 1 - n_close
    cams = [Camera(cam.eye.copy(), centre.copy(), up0.copy(), cam.fovy)]
    for k, (m, d) in enumerate(((n_far, dist), (n_close, dist * closer_by))):
        if m <= 0:
            continue
        dirs = directions(m, off, cap_deg)
        if k == 1:
            dirs = dirs[::-1]  # the closer ones from the far side of the lattice first: both sets cover the cap
        for w in dirs:
            # The view's up, unless the camera looks along it.
            up = up0 - w * (up0 @ w)
            if np.linalg.norm(up) < 1e-3:
                up = np.cross(w, np.array([1.0, 0, 0]) if abs(w[0]) < 0.9 else np.array([0, 1.0, 0]))
            up /= np.linalg.norm(up)
            cams.append(Camera(centre + w * d, centre.copy(), up, cam.fovy))
    # Near and far: as the view's, about the nearer cameras' distance too.
    near = min(near, dist * closer_by * 0.05) if n_close else near
    far = max(far, dist * 2.5)
    return cams, near, far, centre


def opencv(cam: Camera, width: int, height: int) -> tuple[np.ndarray, np.ndarray]:
    """Camera to world (4x4, OpenCV axes) and the intrinsics (3x3) of a camera as the renderer draws it:
    pixel (x, y) from the top left, its centre at (x + 0.5, y + 0.5)."""
    f = cam.target - cam.eye
    f /= np.linalg.norm(f)
    s = np.cross(f, cam.up)
    s /= np.linalg.norm(s)
    u = np.cross(s, f)
    c2w = np.eye(4)
    c2w[:3, 0], c2w[:3, 1], c2w[:3, 2], c2w[:3, 3] = s, -u, f, cam.eye
    fy = (height / 2) / np.tan(np.radians(cam.fovy) / 2)
    K = np.array([[fy, 0, width / 2], [0, fy, height / 2], [0, 0, 1.0]])
    return c2w, K


def world_light(view: dict[str, Any]) -> dict[str, Any]:
    """The view's light in world space, where it is in the view now (a light that follows the camera
    would light each image differently)."""
    light = dict(view.get("light") or {})
    if light.get("camera_space", True):
        inv = np.asarray(view["inv_view_projection"], np.float64).reshape(4, 4).T
        right, up, back = _camera_axes(inv)
        d = np.asarray(light.get("direction", (0.4, 0.7, 0.6)), np.float64)
        w = d[0] * right + d[1] * up + d[2] * back
        light["direction"] = (w / np.linalg.norm(w)).tolist()
        light["camera_space"] = False
    return light


def capture_view(view: dict[str, Any], cam: Camera, width: int, height: int, near: float, far: float, light: dict[str, Any]) -> dict[str, Any]:
    """The page's view seen from `cam`, at full size, with nothing that changes from view to view."""
    v = dict(view)
    vp = look_at(cam.eye, cam.target, cam.up, cam.fovy, width / height, near, far)
    v["inv_view_projection"] = np.linalg.inv(vp).T.ravel().tolist()
    v.update(width=width, height=height, scale=1.0, light=light, aperture=0.0, denoise=False, background=(0, 0, 0, 0))
    return v


def rays(inv_cm, width: int, height: int) -> tuple[np.ndarray, np.ndarray]:
    """Origins (on the near plane) and unit directions of the rays through the pixels' centres, (H, W, 3),
    as the renderer's `ray` makes them: the distances it reports are along these."""
    inv = np.asarray(inv_cm, np.float64).reshape(4, 4).T
    x = (np.arange(width) + 0.5) / width * 2 - 1
    y = 1 - (np.arange(height) + 0.5) / height * 2
    X, Y = np.meshgrid(x, y)

    def un(z):
        p = np.stack([X, Y, np.full_like(X, z), np.ones_like(X)], -1) @ inv.T
        return p[..., :3] / p[..., 3:4]

    n, f = un(-1.0), un(1.0)
    d = f - n
    return n, d / np.linalg.norm(d, axis=-1, keepdims=True)


def seed_points(inv_cm, distance: np.ndarray, rgb: np.ndarray, alpha: np.ndarray, count: int, rng: np.random.Generator) -> tuple[np.ndarray, np.ndarray]:
    """Up to `count` points where the view's rays first meet tissue (distance >= 0, mostly opaque), with their colours (0..1)."""
    H, W = distance.shape
    ok = np.flatnonzero((distance.ravel() >= 0) & (alpha.ravel() > 127))
    if ok.size == 0 or count <= 0:
        return np.zeros((0, 3), np.float32), np.zeros((0, 3), np.float32)
    pick = rng.choice(ok, size=min(count, ok.size), replace=False)
    o, d = rays(inv_cm, W, H)
    o, d = o.reshape(-1, 3)[pick], d.reshape(-1, 3)[pick]
    p = o + d * distance.ravel()[pick, None]
    return p.astype(np.float32), (rgb.reshape(-1, 3)[pick] / 255.0).astype(np.float32)


def camera_record(name: str, cam: Camera, width: int, height: int) -> dict[str, Any]:
    c2w, K = opencv(cam, width, height)
    return {"file": name, "width": width, "height": height, "c2w": c2w.tolist(), "K": K.tolist(), "fovy": cam.fovy}


def write_cameras(folder: Path, records: list[dict[str, Any]], centre, meta: dict[str, Any]) -> None:
    """`cameras.json` (OpenCV axes, for `fit`) and `transforms.json` (nerfstudio's, OpenGL axes)."""
    folder = Path(folder)
    radius = max(float(np.linalg.norm(np.asarray(r["c2w"])[:3, 3] - centre)) for r in records)
    (folder / "cameras.json").write_text(json.dumps({"convention": "opencv", "centre": list(map(float, centre)), "radius": radius, "frames": records, **meta}, indent=1))
    flip = np.diag([1.0, -1.0, -1.0, 1.0])
    frames = []
    for r in records:
        K = r["K"]
        frames.append({"file_path": r["file"], "transform_matrix": (np.asarray(r["c2w"]) @ flip).tolist(),
                       "fl_x": K[0][0], "fl_y": K[1][1], "cx": K[0][2], "cy": K[1][2], "w": r["width"], "h": r["height"]})
    (folder / "transforms.json").write_text(json.dumps({"camera_model": "OPENCV", "ply_file_path": "points.ply", "frames": frames}, indent=1))


def write_points(path: Path, xyz: np.ndarray, rgb: np.ndarray) -> None:
    """A binary point cloud (x, y, z float; red, green, blue uchar)."""
    n = len(xyz)
    head = ("ply\nformat binary_little_endian 1.0\n"
            f"element vertex {n}\nproperty float x\nproperty float y\nproperty float z\n"
            "property uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n")
    rec = np.zeros(n, dtype=[("p", "<f4", 3), ("c", "u1", 3)])
    rec["p"] = xyz
    rec["c"] = np.clip(np.round(rgb * 255), 0, 255).astype(np.uint8)
    with open(path, "wb") as f:
        f.write(head.encode())
        f.write(rec.tobytes())


def read_points(path: Path) -> tuple[np.ndarray, np.ndarray]:
    data = Path(path).read_bytes()
    end = data.index(b"end_header\n") + len(b"end_header\n")
    n = int(next(line.split()[2] for line in data[:end].decode().splitlines() if line.startswith("element vertex")))
    rec = np.frombuffer(data[end:], dtype=[("p", "<f4", 3), ("c", "u1", 3)], count=n)
    return rec["p"].copy(), rec["c"].astype(np.float32) / 255.0
