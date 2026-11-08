"""Keyframes to the views of a movie's frames.

A keyframe is a view, as the page sends it to a session, with a time in
seconds.  Between two keyframes the camera moves along the orbit around
its target (the inverse view-projection is taken apart into eye, target,
up and field of view, interpolated, and put together again), clip planes
and numbers of the look (the preset's overrides, light, aperture) change
linearly, and everything else is the earlier keyframe's.
"""

from __future__ import annotations

from typing import Any

import numpy as np

from .camera import Camera, interpolate_cameras
from .renderer import look_at


def camera_from_inverse(inv_cm: list[float]) -> tuple[Camera, float, float, float]:
    """Eye, target (the point at the middle of the view at the near/far mean), up and vertical field of view,
    and the aspect and near/far, of a perspective inverse view-projection (column-major)."""
    inv = np.asarray(inv_cm, np.float64).reshape(4, 4).T

    def un(x, y, z):
        p = inv @ np.array([x, y, z, 1.0])
        return p[:3] / p[3]

    e = inv @ np.array([0.0, 0.0, 1.0, 0.0])  # the camera centre: clip (0, 0, *, 0)
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
    # The target: where the view's middle meets the volume is not known here; use the far/near geometric mean.
    target = eye + fwd * float(np.sqrt(near * far))
    return Camera(eye, target, up, fovy), half_w / half_h, near, far


def _lerp(a, b, u):
    if isinstance(a, (int, float)) and isinstance(b, (int, float)) and not isinstance(a, bool):
        return a + (b - a) * u
    if isinstance(a, list) and isinstance(b, list) and len(a) == len(b):
        return [_lerp(x, y, u) for x, y in zip(a, b)]
    if isinstance(a, dict) and isinstance(b, dict):
        return {k: (_lerp(a[k], b[k], u) if k in b else a[k]) for k in a}
    return a


def frames_for(keyframes: list[dict[str, Any]], fps: int) -> list[dict[str, Any]]:
    kf = sorted(keyframes, key=lambda k: float(k.get("time", 0)))
    if len(kf) == 1:
        return [kf[0]["view"]]
    t0, t1 = float(kf[0].get("time", 0)), float(kf[-1].get("time", 0))
    n = max(1, int(round((t1 - t0) * fps)) + 1)
    cams = [camera_from_inverse(k["view"]["inv_view_projection"]) for k in kf]
    out = []
    for i in range(n):
        t = t0 + i / fps
        j = max(0, min(len(kf) - 2, int(np.searchsorted([float(k.get("time", 0)) for k in kf], t, side="right")) - 1))
        a, b = kf[j], kf[j + 1]
        ta, tb = float(a.get("time", 0)), float(b.get("time", 0))
        u = 0.0 if tb <= ta else min(1.0, max(0.0, (t - ta) / (tb - ta)))
        (ca, asp, na, fa), (cb, _, nb, fb) = cams[j], cams[j + 1]
        cam = interpolate_cameras(ca, cb, u)
        near = na + (nb - na) * u
        far = fa + (fb - fa) * u
        vp = look_at(cam.eye, cam.target, cam.up, cam.fovy, asp, near, far)
        view = dict(a["view"])
        for k in ("overrides", "light", "aperture", "focus", "clips"):
            if k in a["view"] and k in b["view"]:
                view[k] = _lerp(a["view"][k], b["view"][k], u)
        view["inv_view_projection"] = np.linalg.inv(vp).T.ravel().tolist()
        out.append(view)
    return out
