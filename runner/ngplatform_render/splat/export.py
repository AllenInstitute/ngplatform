"""Fitted Gaussians as files: the usual 3-D Gaussian splatting `.ply` and the web viewers' `.splat`.

The Gaussians come as numpy arrays as `fit` keeps them: means (N, 3),
log scales (N, 3), rotations as quaternions w, x, y, z (N, 4, not
necessarily unit), opacities before the sigmoid (N,), and spherical
harmonics coefficients (N, K, 3), the first the colour's DC term.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np

C0 = 0.28209479177387814  # the degree-0 spherical harmonic


def sigmoid(x: np.ndarray) -> np.ndarray:
    return 1 / (1 + np.exp(-x))


def write_ply(path: Path, means, log_scales, quats, opacity_logits, sh) -> None:
    """The layout 3-D Gaussian splatting tools read: x y z, normals, f_dc (3), f_rest (channel-major),
    opacity (logit), scale (log) and rot (w x y z)."""
    n, k, _ = sh.shape
    rest = np.ascontiguousarray(sh[:, 1:, :].transpose(0, 2, 1)).reshape(n, -1)  # f_rest: all of red, then green, then blue
    names = ["x", "y", "z", "nx", "ny", "nz", "f_dc_0", "f_dc_1", "f_dc_2"] + [f"f_rest_{i}" for i in range(rest.shape[1])] + ["opacity", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"]
    cols = np.concatenate([means, np.zeros((n, 3)), sh[:, 0, :], rest, opacity_logits.reshape(n, 1), log_scales, quats], 1).astype("<f4")
    assert cols.shape[1] == len(names)
    head = "ply\nformat binary_little_endian 1.0\n" + f"element vertex {n}\n" + "".join(f"property float {c}\n" for c in names) + "end_header\n"
    with open(path, "wb") as f:
        f.write(head.encode())
        f.write(cols.tobytes())


def splat_bytes(means, log_scales, quats, opacity_logits, sh) -> bytes:
    """The `.splat` layout (32 bytes a Gaussian): position (3 float32), scale (3 float32), colour and
    opacity (4 uint8), rotation w, x, y, z (4 uint8, (q + 1) * 128); the largest and most opaque first."""
    n = len(means)
    scales = np.exp(log_scales)
    alpha = sigmoid(opacity_logits.reshape(n))
    order = np.argsort(-(scales.prod(1) * alpha))
    q = quats / np.maximum(np.linalg.norm(quats, axis=1, keepdims=True), 1e-12)
    rgb = 0.5 + C0 * sh[:, 0, :]
    rec = np.zeros(n, dtype=[("p", "<f4", 3), ("s", "<f4", 3), ("c", "u1", 4), ("q", "u1", 4)])
    rec["p"] = means[order]
    rec["s"] = scales[order]
    rec["c"][:, :3] = np.clip(rgb[order] * 255, 0, 255).astype(np.uint8)
    rec["c"][:, 3] = np.clip(alpha[order] * 255, 0, 255).astype(np.uint8)
    rec["q"] = np.clip(q[order] * 128 + 128, 0, 255).astype(np.uint8)
    return rec.tobytes()


def write_splat(path: Path, means, log_scales, quats, opacity_logits, sh) -> None:
    Path(path).write_bytes(splat_bytes(means, log_scales, quats, opacity_logits, sh))
