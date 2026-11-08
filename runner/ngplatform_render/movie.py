"""Keyframes to the views of a movie's frames.

A keyframe is a view, as the page sends it to a session, with a time in
seconds; its ``orbit_center`` (the viewer's position, which its 3-D view
turns about) is the point the camera moves around.  Between two
keyframes the camera moves along the orbit around its target (the inverse view-projection is taken apart into eye, target,
up and field of view, interpolated, and put together again), clip planes
and numbers of the look (the preset's overrides, light, aperture) change
linearly, and everything else is the earlier keyframe's.
"""

from __future__ import annotations

from typing import Any

import numpy as np

from .camera import Camera, interpolate_cameras
from .renderer import look_at


def camera_from_inverse(inv_cm: list[float], center=None) -> tuple[Camera, float, float, float]:
    """Eye, target (on the view's axis, level with `center` when given), up and vertical field of view,
    and the aspect and near/far, of a perspective inverse view-projection (column-major)."""
    inv = np.asarray(inv_cm, np.float64).reshape(4, 4).T

    def un(x, y, z):
        p = inv @ np.array([x, y, z, 1.0])
        return p[:3] / p[3]

    e = inv @ np.array([0.0, 0.0, 1.0, 0.0])  # the camera centre: clip (0, 0, *, 0)
    if abs(e[3]) < 1e-12 * max(1.0, float(np.abs(e[:3]).max())):
        raise ValueError("movies need the perspective 3-D view (this keyframe is orthographic)")
    eye = e[:3] / e[3]
    n0, f0 = un(0, 0, -1), un(0, 0, 1)
    fwd = f0 - n0
    fwd /= np.linalg.norm(fwd)
    top, right = un(0, 1, -1), un(1, 0, -1)
    near = float(np.linalg.norm(n0 - eye))
    far = float(np.linalg.norm(f0 - eye))
    up = top - n0
    up -= fwd * (up @ fwd)
    half_h = float(np.linalg.norm(up))
    up /= half_h
    half_w = float(np.linalg.norm(right - n0))
    fovy = float(np.degrees(2 * np.arctan(half_h / near)))
    # The target: the point the view orbits (the viewer's position), when given, else the near/far geometric mean.
    if center is not None:
        c = np.asarray(center, np.float64)
        target = eye + fwd * float(max((c - eye) @ fwd, near))
    else:
        target = eye + fwd * float(np.sqrt(near * far))
    return Camera(eye, target, up, fovy), half_w / half_h, near, far


def reshaped(inv_cm: list[float], aspect: float, center=None) -> list[float]:
    """The same camera (eye, target, up, vertical field of view) at another aspect, column-major."""
    cam, _, near, far = camera_from_inverse(inv_cm, center)
    vp = look_at(cam.eye, cam.target, cam.up, cam.fovy, aspect, near, far)
    return np.linalg.inv(vp).T.ravel().tolist()


def rotation_frames(view: dict[str, Any], axis: str, degrees: float, step: float, aspect: float | None = None) -> list[dict[str, Any]]:
    """Views turning about the view's orbit centre, by `step` degrees up to `degrees` (360: a full
    circle, 180: half): about the camera's up axis ("vertical") or its right axis ("horizontal")."""
    if step <= 0 or degrees <= 0:
        raise ValueError("step and degrees must be positive")
    cam, asp, near, far = camera_from_inverse(view["inv_view_projection"], view.get("orbit_center"))
    centre = np.asarray(view.get("orbit_center") or cam.target, np.float64)
    off = cam.eye - centre
    fwd = cam.target - cam.eye
    fwd /= np.linalg.norm(fwd)
    right = np.cross(fwd, cam.up)
    right /= np.linalg.norm(right)
    k = cam.up / np.linalg.norm(cam.up) if axis == "vertical" else right
    n = int(np.floor(degrees / step + 1e-9)) + (0 if abs(degrees - 360) < 1e-9 else 1)
    out = []
    for i in range(n):
        t = np.radians(i * step)
        # Rodrigues' rotation of the eye's offset and the up vector about k.
        rot = lambda v: v * np.cos(t) + np.cross(k, v) * np.sin(t) + k * (k @ v) * (1 - np.cos(t))  # noqa: E731
        eye, up = centre + rot(off), rot(cam.up)
        vp = look_at(eye, centre, up, cam.fovy, aspect or asp, near, far)
        v = dict(view)
        v["inv_view_projection"] = np.linalg.inv(vp).T.ravel().tolist()
        out.append(v)
    return out


def _lerp(a, b, u):
    if isinstance(a, (int, float)) and isinstance(b, (int, float)) and not isinstance(a, bool):
        return a + (b - a) * u
    if isinstance(a, list) and isinstance(b, list) and len(a) == len(b):
        return [_lerp(x, y, u) for x, y in zip(a, b)]
    if isinstance(a, dict) and isinstance(b, dict):
        return {k: (_lerp(a[k], b[k], u) if k in b else a[k]) for k in a}
    return a


def frames_for(keyframes: list[dict[str, Any]], fps: int, easing: str = "smooth", aspect: float | None = None) -> list[dict[str, Any]]:
    """The view of every frame, at `aspect` (the movie's width / height; the keyframes' own by default);
    `easing` "smooth" slows the camera into and out of each keyframe, "linear" does not."""
    kf = sorted(keyframes, key=lambda k: float(k.get("time", 0)))
    if len(kf) == 1:
        return [kf[0]["view"]]
    t0, t1 = float(kf[0].get("time", 0)), float(kf[-1].get("time", 0))
    n = max(1, int(round((t1 - t0) * fps)) + 1)
    cams = [camera_from_inverse(k["view"]["inv_view_projection"], k["view"].get("orbit_center")) for k in kf]
    out = []
    for i in range(n):
        t = t0 + i / fps
        j = max(0, min(len(kf) - 2, int(np.searchsorted([float(k.get("time", 0)) for k in kf], t, side="right")) - 1))
        a, b = kf[j], kf[j + 1]
        ta, tb = float(a.get("time", 0)), float(b.get("time", 0))
        u = 0.0 if tb <= ta else min(1.0, max(0.0, (t - ta) / (tb - ta)))
        (ca, asp, na, fa), (cb, _, nb, fb) = cams[j], cams[j + 1]
        cam = interpolate_cameras(ca, cb, u, ease=easing != "linear")
        near = na + (nb - na) * u
        far = fa + (fb - fa) * u
        vp = look_at(cam.eye, cam.target, cam.up, cam.fovy, aspect or asp, near, far)
        view = dict(a["view"])
        for k in ("overrides", "light", "aperture", "focus", "clips"):
            if k in a["view"] and k in b["view"]:
                view[k] = _lerp(a["view"][k], b["view"][k], u)
        view["inv_view_projection"] = np.linalg.inv(vp).T.ravel().tolist()
        out.append(view)
    return out
