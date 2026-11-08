"""Cameras for renders made outside the viewer (stills, movies): orbits around a volume and
keyframes between them.

A camera is eye, target, up and a vertical field of view, in world
coordinates; `view_projection` makes the matrix the renderer takes.
Keyframes interpolate the camera by the orbit around the target
(azimuth, elevation and distance, smoothly), and numbers of the look
(presets' opacities, a clip plane's offset) linearly.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .renderer import look_at


@dataclass
class Camera:
    eye: np.ndarray
    target: np.ndarray
    up: np.ndarray
    fovy: float = 30.0

    def view_projection(self, width: int, height: int, near: float | None = None, far: float | None = None) -> np.ndarray:
        d = float(np.linalg.norm(self.eye - self.target))
        near = near if near is not None else d * 0.05
        far = far if far is not None else d * 4.0
        return look_at(self.eye, self.target, self.up, self.fovy, width / height, near, far)


def bounds(world_from_voxel: np.ndarray, shape_zyx) -> tuple[np.ndarray, np.ndarray]:
    nz, ny, nx = shape_zyx
    corners = np.array([[x, y, z, 1.0] for x in (-0.5, nx - 0.5) for y in (-0.5, ny - 0.5) for z in (-0.5, nz - 0.5)])
    w = (world_from_voxel @ corners.T).T[:, :3]
    return w.min(axis=0), w.max(axis=0)


def orbit(center, radius: float, azimuth_deg: float, elevation_deg: float, up=(0, 0, 1), fovy: float = 30.0,
          front=(0, -1, 0)) -> Camera:
    """A camera on a sphere around `center`: azimuth about `up` from `front` (the direction the
    camera looks from at azimuth 0), elevation above the plane normal to `up`."""
    up = np.asarray(up, np.float64)
    up /= np.linalg.norm(up)
    f = np.asarray(front, np.float64)
    f -= up * (f @ up)
    f /= np.linalg.norm(f)
    s = np.cross(up, f)
    a, e = np.radians(azimuth_deg), np.radians(elevation_deg)
    d = (np.cos(a) * f + np.sin(a) * s) * np.cos(e) + up * np.sin(e)
    center = np.asarray(center, np.float64)
    return Camera(center + d * radius, center, up, fovy)


def framing_radius(lo, hi, fovy: float, margin: float = 1.15) -> float:
    r = float(np.linalg.norm(np.asarray(hi) - np.asarray(lo))) / 2
    return margin * r / np.sin(np.radians(fovy) / 2)


def _smooth(u: float) -> float:
    return u * u * (3 - 2 * u)


def interpolate_cameras(a: Camera, b: Camera, u: float) -> Camera:
    """Between two cameras: the target and up linearly, the eye along the orbit around the target
    (direction by spherical interpolation, distance geometrically), eased in and out."""
    u = _smooth(min(max(u, 0.0), 1.0))
    ta, tb = a.target, b.target
    target = ta + (tb - ta) * u
    va, vb = a.eye - ta, b.eye - tb
    ra, rb = np.linalg.norm(va), np.linalg.norm(vb)
    da, db = va / ra, vb / rb
    c = float(np.clip(da @ db, -1.0, 1.0))
    om = np.arccos(c)
    if om < 1e-6:
        d = da
    else:
        d = (np.sin((1 - u) * om) * da + np.sin(u * om) * db) / np.sin(om)
    r = ra * (rb / ra) ** u
    up = a.up + (b.up - a.up) * u
    up /= np.linalg.norm(up)
    return Camera(target + d * r, target, up, a.fovy + (b.fovy - a.fovy) * u)
