"""Light maps: panoramic HDR images of light arriving from every direction (image-based lighting).

The maps that come with the service are in ``lightmaps/`` as small float16
arrays (256 x 128, latitude-longitude, rows from straight up to straight
down), made from CC0 HDR images of Poly Haven (``lightmaps/credits.json``) by
`from_hdr`.  A preset's ``environment`` names one with ``map``, turns it
about the vertical with ``rotation`` (degrees) and scales it with ``scale``;
without ``map`` the sky is the preset's three colours.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np

HERE = Path(__file__).parent / "lightmaps"


def read_rgbe(path: str | Path) -> np.ndarray:
    """A Radiance .hdr (RGBE, run-length encoded or flat) as float32 (rows, columns, 3)."""
    data = Path(path).read_bytes()
    i = 0
    while True:  # the header ends at an empty line
        j = data.index(b"\n", i)
        line = data[i:j]
        i = j + 1
        if line == b"":
            break
    j = data.index(b"\n", i)
    dims = data[i:j].split()
    i = j + 1
    if dims[0] != b"-Y" or dims[2] != b"+X":
        raise ValueError(f"{path}: only -Y H +X W images are read")
    h, w = int(dims[1]), int(dims[3])
    out = np.zeros((h, w, 4), np.uint8)
    buf = memoryview(data)
    for y in range(h):
        if w >= 8 and buf[i] == 2 and buf[i + 1] == 2 and (buf[i + 2] << 8 | buf[i + 3]) == w:
            i += 4
            for c in range(4):
                x = 0
                while x < w:
                    n = buf[i]
                    i += 1
                    if n > 128:
                        n -= 128
                        out[y, x:x + n, c] = buf[i]
                        i += 1
                    else:
                        out[y, x:x + n, c] = np.frombuffer(buf[i:i + n], np.uint8)
                        i += n
                    x += n
        else:
            out[y] = np.frombuffer(buf[i:i + 4 * w], np.uint8).reshape(w, 4)
            i += 4 * w
    e = out[..., 3].astype(np.int32)
    scale = np.where(e > 0, np.ldexp(1.0, e - 136), 0.0).astype(np.float32)
    return out[..., :3].astype(np.float32) * scale[..., None]


def from_hdr(path: str | Path, width: int = 256) -> np.ndarray:
    """A light map from an HDR panorama: the mean of each block, float16 (width / 2, width, 3)."""
    img = read_rgbe(path)
    h, w = img.shape[:2]
    fy, fx = h // (width // 2), w // width
    return img[: fy * (width // 2), : fx * width].reshape(width // 2, fy, width, fx, 3).mean(axis=(1, 3)).astype(np.float16)


def names() -> list[str]:
    return sorted(p.stem for p in HERE.glob("*.npy"))


def load(name: str) -> np.ndarray:
    if name not in names():
        raise ValueError(f"no light map {name!r} (there are {', '.join(names())})")
    return np.load(HERE / f"{name}.npy").astype(np.float32)
