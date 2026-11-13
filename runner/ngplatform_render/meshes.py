"""A precomputed segmentation's meshes for chosen segments: Neuroglancer's multi-resolution Draco meshes
(`neuroglancer_multilod_draco`, sharded or not) and legacy meshes (`<id>:0` with fragment files), as
triangles in nanometres (the mesh info's transform applied).

As the browser's reader (plugins/zarr-vectors/src/virtual/precomputed_meshes.ts): a multi-resolution
manifest gives each level of detail's octree nodes and their fragments' sizes; in a shard, a segment's
fragment data sits just before its manifest; a fragment's Draco positions are quantized within its node,
grid_origin + vertex_offsets[lod] + chunk_shape * 2^lod * (position + q / (2^bits - 1)).
"""

from __future__ import annotations

import json
import struct
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass

import numpy as np

from .precomputed import Shards, _get, base_url


@dataclass
class Manifest:
    chunk_shape: np.ndarray  # (3,)
    grid_origin: np.ndarray  # (3,)
    lod_scales: list[float]
    vertex_offsets: np.ndarray  # (lods, 3)
    lods: list[tuple[np.ndarray, np.ndarray]]  # per lod: positions (n, 3) uint32, sizes (n,) uint32
    data_bytes: int


def decode_manifest(b: bytes) -> Manifest:
    if len(b) < 28 or len(b) % 4:
        raise ValueError(f"a mesh manifest of {len(b)} bytes")
    chunk = np.frombuffer(b, "<f4", 3, 0).astype(np.float64)
    origin = np.frombuffer(b, "<f4", 3, 12).astype(np.float64)
    (n,) = struct.unpack_from("<I", b, 24)
    at = 28
    scales = np.frombuffer(b, "<f4", n, at).tolist()
    at += 4 * n
    offsets = np.frombuffer(b, "<f4", 3 * n, at).reshape(n, 3).astype(np.float64)
    at += 12 * n
    counts = np.frombuffer(b, "<u4", n, at)
    at += 4 * n
    lods, total = [], 0
    for c in counts.tolist():
        pos = np.frombuffer(b, "<u4", 3 * c, at).reshape(3, c).T.copy()  # every x, then every y, then every z
        at += 12 * c
        sizes = np.frombuffer(b, "<u4", c, at).copy()
        at += 4 * c
        total += int(sizes.sum())
        lods.append((pos, sizes))
    if at != len(b):
        raise ValueError(f"a mesh manifest of {len(b)} bytes, {at} read")
    return Manifest(chunk, origin, scales, offsets, lods, total)


def _draco(raw: bytes) -> tuple[np.ndarray, np.ndarray]:
    import DracoPy

    m = DracoPy.decode(raw)
    return np.asarray(m.points, np.float64).reshape(-1, 3), np.asarray(m.faces, np.int64).reshape(-1, 3)


@dataclass
class Mesh:
    """Triangles in nanometres: vertices (n, 3) float64, faces (m, 3) int64 into them."""

    vertices: np.ndarray
    faces: np.ndarray


class MeshSource:
    """The meshes of a precomputed segmentation (the volume's URL, as precomputed://… or its directory)."""

    def __init__(self, url: str):
        self.base = base_url(url)
        vinfo = json.loads(_get(f"{self.base}/info") or b"{}")
        mdir = vinfo.get("mesh")
        if not mdir:
            raise ValueError(f"{url}: the segmentation names no meshes")
        self.dir = f"{self.base}/{mdir}"
        info = json.loads(_get(f"{self.dir}/info") or b'{"@type": "neuroglancer_legacy_mesh"}')
        self.kind = info.get("@type", "neuroglancer_legacy_mesh")
        t = info.get("transform") or [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]
        self.transform = np.vstack([np.asarray(t, np.float64).reshape(3, 4), [0, 0, 0, 1]])  # stored -> nm
        self.bits = int(info.get("vertex_quantization_bits", 10))
        self.shards = Shards(self.dir, info["sharding"]) if info.get("sharding") else None

    # ------------------------------------------------------------ multi-resolution
    def manifest(self, sid: int) -> tuple[Manifest, str, int] | None:
        """A segment's manifest, the file its fragment data is in and where that data starts; None without a mesh."""
        if self.shards is not None:
            at = self.shards.locate(sid)
            if at is None:
                return None
            raw = _get(*at)
            if raw is None:
                return None
            if self.shards.sh.get("data_encoding", "raw") == "gzip":
                import gzip

                raw = gzip.decompress(raw)
            m = decode_manifest(raw)
            return m, at[0], at[1] - m.data_bytes
        raw = _get(f"{self.dir}/{sid}.index")
        if raw is None:
            return None
        return decode_manifest(raw), f"{self.dir}/{sid}", 0

    def lods(self, sid: int) -> int:
        got = self.manifest(sid)
        return 0 if got is None else len(got[0].lods)

    def mesh(self, sid: int, lod: int = 0) -> Mesh | None:
        """A segment's mesh at a level of detail (0 the finest; past its coarsest, its coarsest)."""
        if self.kind != "neuroglancer_multilod_draco":
            return self._legacy(sid)
        got = self.manifest(sid)
        if got is None:
            return None
        m, file, start = got
        lod = min(lod, len(m.lods) - 1)
        positions, sizes = m.lods[lod]
        offs = start + sum(int(m.lods[k][1].sum()) for k in range(lod)) + np.concatenate([[0], np.cumsum(sizes)[:-1]]).astype(np.int64)
        top = 2 ** self.bits - 1
        step = m.chunk_shape * 2 ** lod

        def one(i: int):
            if sizes[i] == 0:
                return None
            raw = _get(file, int(offs[i]), int(offs[i] + sizes[i]))
            if raw is None:
                return None
            q, f = _draco(raw)
            v = m.grid_origin + m.vertex_offsets[lod] + step * (positions[i] + q / top)
            return v, f

        with ThreadPoolExecutor(max_workers=16) as ex:
            parts = [p for p in ex.map(one, range(len(sizes))) if p is not None and len(p[1])]
        return self._joined(parts)

    # ------------------------------------------------------------ legacy
    def _legacy(self, sid: int) -> Mesh | None:
        raw = _get(f"{self.dir}/{sid}:0")
        if raw is None:
            return None
        names = json.loads(raw).get("fragments", [])

        def one(name: str):
            b = _get(f"{self.dir}/{name}")
            if b is None or len(b) < 4:
                return None
            (n,) = struct.unpack_from("<I", b, 0)
            v = np.frombuffer(b, "<f4", 3 * n, 4).reshape(n, 3).astype(np.float64)
            f = np.frombuffer(b, "<u4", offset=4 + 12 * n).reshape(-1, 3).astype(np.int64)
            return v, f

        with ThreadPoolExecutor(max_workers=16) as ex:
            parts = [p for p in ex.map(one, names) if p is not None and len(p[1])]
        # Legacy fragments are in nanometres already.
        if not parts:
            return None
        return self._joined(parts, transform=False)

    def _joined(self, parts, transform: bool = True) -> Mesh | None:
        if not parts:
            return None
        verts, faces, n = [], [], 0
        for v, f in parts:
            verts.append(v)
            faces.append(f + n)
            n += len(v)
        V = np.concatenate(verts)
        if transform:
            V = V @ self.transform[:3, :3].T + self.transform[:3, 3]
        return Mesh(V, np.concatenate(faces))
