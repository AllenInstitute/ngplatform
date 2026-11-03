"""Streamlines read in batches, without loading the file: the filter job's input.

Positions come out in the coordinates the viewer shows the same data in, so
regions drawn in the viewer mean the same thing here:

- a tractogram file (.trk, .tck, .trx): RAS+ millimetres, computed exactly
  as zarr-vectors-tools' virtual stores (and ngplatform's in-browser reader)
  compute them;
- a Zarr Vectors store: its positions as stored (level 0).

A .trk is memory-mapped and walked record by record, so a file of tens of
gigabytes is read in passes of about ``per_batch`` streamlines; each batch
also carries the byte span of every record, so the streamlines that pass a
filter can be copied to a new .trk unchanged.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterator

import numpy as np

TRK_HEADER_SIZE = 1000


@dataclass
class Batch:
    #: (V, 3) float32 positions.
    points: np.ndarray
    #: (N + 1,) int64 offsets into points.
    offsets: np.ndarray
    #: Per-streamline columns (the file's properties, the store's object attributes).
    columns: dict[str, np.ndarray] = field(default_factory=dict)
    #: Row of the first streamline in the whole set.
    first: int = 0
    #: For a .trk: (N, 2) start and end byte of each record in the file.
    spans: np.ndarray | None = None
    #: Bytes of the input read so far, after this batch.
    done_bytes: int = 0


@dataclass
class Source:
    path: Path
    kind: str  # "trk", "tck", "trx" or "store"
    count: int | None
    total_bytes: int
    batches: "callable[[], Iterator[Batch]]"
    #: For a .trk: its header, to copy.
    header: bytes | None = None
    #: For a store: its groups (member rows of each group id).
    groups: list[np.ndarray] = field(default_factory=list)


def _names(raw: bytes, n: int) -> list[str]:
    from zarr_vectors_tools.virtual.tractograms import _names as names

    return names(raw, n)


def open_trk(path: Path, per_batch: int = 50_000) -> Source:
    from zarr_vectors_tools.virtual.tractograms import _apply, trk_to_ras

    with open(path, "rb") as f:
        head = f.read(TRK_HEADER_SIZE)
    if len(head) < TRK_HEADER_SIZE or not head.startswith(b"TRACK"):
        raise ValueError(f"{path}: not a TrackVis .trk file")
    little = struct.unpack("<i", head[996:1000])[0] == TRK_HEADER_SIZE
    e = "<" if little else ">"
    if not little and struct.unpack(">i", head[996:1000])[0] != TRK_HEADER_SIZE:
        raise ValueError(f"{path}: a .trk header whose size is not 1000 bytes")
    dims = struct.unpack(e + "3h", head[6:12])
    voxel_size = [s if s > 0 else 1.0 for s in struct.unpack(e + "3f", head[12:24])]
    n_scalars = struct.unpack(e + "h", head[36:38])[0]
    n_properties = struct.unpack(e + "h", head[238:240])[0]
    vox_to_ras = list(struct.unpack(e + "16f", head[440:504]))
    voxel_order = head[948:952].split(b"\0")[0].decode("latin1").strip()
    count = struct.unpack(e + "i", head[988:992])[0]
    to_ras = trk_to_ras(dims, voxel_size, vox_to_ras, voxel_order)
    property_names = _names(head[240:440], n_properties)
    size = path.stat().st_size
    words_total = (size - TRK_HEADER_SIZE) // 4
    stride = 3 + n_scalars

    def batches() -> Iterator[Batch]:
        if words_total <= 0:
            return
        words = np.memmap(path, dtype=e + "f4", mode="r", offset=TRK_HEADER_SIZE, shape=(words_total,))
        ints = np.memmap(path, dtype=e + "i4", mode="r", offset=TRK_HEADER_SIZE, shape=(words_total,))
        at = 0
        row = 0
        while at < words_total:
            starts: list[int] = []
            counts: list[int] = []
            while at < words_total and len(starts) < per_batch:
                n = int(ints[at])
                end = at + 1 + n * stride + n_properties
                if n < 0 or end > words_total:
                    raise ValueError(f"{path}: a broken streamline record at byte {TRK_HEADER_SIZE + 4 * at}")
                starts.append(at)
                counts.append(n)
                at = end
            n_rows = len(counts)
            offsets = np.zeros(n_rows + 1, np.int64)
            offsets[1:] = np.cumsum(counts)
            first, last = starts[0], at
            block = np.asarray(words[first:last])
            # Each record's points, as rows of `stride` words, gathered from the block.
            rec = np.asarray(starts, np.int64) - first
            lengths = np.asarray(counts, np.int64) * stride
            total = int(lengths.sum())
            point_words = np.repeat(rec + 1 - (np.cumsum(lengths) - lengths), lengths) + np.arange(total, dtype=np.int64)
            raw = block[point_words].reshape(-1, stride)
            points = _apply(raw[:, :3].astype(np.float64), to_ras)
            columns: dict[str, np.ndarray] = {}
            if n_properties:
                prop_at = rec + 1 + np.asarray(counts, np.int64) * stride
                props = block[(prop_at[:, None] + np.arange(n_properties)[None, :]).reshape(-1)].reshape(n_rows, n_properties).astype(np.float32)
                for k, name in enumerate(property_names):
                    columns[name] = props[:, k]
            spans = np.empty((n_rows, 2), np.int64)
            spans[:, 0] = TRK_HEADER_SIZE + 4 * np.asarray(starts, np.int64)
            spans[:-1, 1] = spans[1:, 0]
            spans[-1, 1] = TRK_HEADER_SIZE + 4 * at
            yield Batch(points, offsets, columns, row, spans, TRK_HEADER_SIZE + 4 * at)
            row += n_rows
        del words, ints

    return Source(path, "trk", count, size, batches, header=head)


def open_other(path: Path) -> Source:
    """A .tck or .trx, through zarr-vectors-tools' readers (in RAS+ mm)."""
    from zarr_vectors_tools.virtual.tractograms import open_tck, open_trx

    suffix = path.suffix.lower()
    tractogram = open_tck(path) if suffix == ".tck" else open_trx(path)
    size = path.stat().st_size
    expected = tractogram.expected_count or 0

    def batches() -> Iterator[Batch]:
        row = 0
        for b in tractogram.batches():
            n = len(b.offsets) - 1
            columns = {name: b.properties[:, k].astype(np.float32) for k, name in enumerate(tractogram.property_names)}
            row += n
            done = int(size * min(1.0, row / expected)) if expected else 0
            yield Batch(np.asarray(b.points, np.float32), np.asarray(b.offsets, np.int64), columns, row - n, None, done)

    return Source(path, suffix[1:], expected or None, size, batches)


def open_store(path: Path) -> Source:
    """A Zarr Vectors streamline store's level 0, in its stored coordinates, as one batch."""
    from zarr_vectors.building import (
        get_resolution_level,
        object_count,
        open_store as open_zv,
        read_all_groupings,
        read_object_attribute_present_mask,
        read_object_attributes,
        read_root_metadata,
    )
    from zarr_vectors.constants import OBJECT_ATTRIBUTES
    from zarr_vectors.types.polylines import read_polylines

    root = open_zv(str(path))
    meta = read_root_metadata(root)
    geometry = set(meta.geometry_types or [])
    if not geometry & {"streamline", "polyline"}:
        raise ValueError(f"{path} holds {sorted(geometry) or 'no geometry'}, not streamlines")
    if "additive_levels" in (meta.format_capabilities or []):
        raise ValueError(f"{path} is an additive pyramid, whose level 0 is not every streamline; filter the file it was made from")
    level = get_resolution_level(root, 0)
    n = int(object_count(level))
    groups: list[np.ndarray] = []
    try:
        groups = [np.asarray(list(g), dtype=np.int64) for g in read_all_groupings(level)]
    except Exception:  # noqa: BLE001 - a level without groups
        groups = []
    size = sum(f.stat().st_size for f in path.rglob("*") if f.is_file() and "/0/" in f.as_posix())

    def batches() -> Iterator[Batch]:
        result = read_polylines(str(path), level=0)
        pieces: list[np.ndarray | None] = [None] * n
        count = n
        for oid, segments in zip(result["object_ids"], result["polylines"]):
            oid = int(oid)
            if oid >= count:
                pieces.extend([None] * (oid + 1 - count))
                count = oid + 1
            pieces[oid] = np.concatenate(segments, axis=0).astype(np.float32).reshape(-1, 3)
        empty = np.zeros((0, 3), np.float32)
        arrays = [p if p is not None else empty for p in pieces]
        offsets = np.zeros(count + 1, np.int64)
        offsets[1:] = np.cumsum([len(a) for a in arrays])
        points = np.concatenate(arrays) if arrays else empty
        columns: dict[str, np.ndarray] = {}
        try:
            names = sorted(level[OBJECT_ATTRIBUTES].children())
        except Exception:  # noqa: BLE001 - a level without object attributes
            names = []
        for name in names:
            values = np.asarray(read_object_attributes(level, name))
            if len(values) != count:
                continue
            mask = read_object_attribute_present_mask(level, name)
            if mask is not None and values.dtype.kind == "f":
                values = np.where(np.asarray(mask, bool), values, np.nan)
            columns[name] = values
        yield Batch(points, offsets, columns, 0, None, size)

    return Source(path, "store", n, size, batches, groups=groups)


def open_source(path: Path) -> Source:
    if path.is_dir():
        return open_store(path)
    suffix = path.suffix.lower()
    if suffix == ".trk":
        return open_trk(path)
    if suffix in (".tck", ".trx"):
        return open_other(path)
    raise ValueError(f"{path}: not a tractogram (.trk, .tck, .trx) or a Zarr Vectors store")


# ----------------------------------------------------------------- writing


def trk_header_ras(count: int = 0) -> bytearray:
    """A .trk header for points in RAS+ mm: 1 mm voxels, voxel-to-RAS the identity."""
    head = bytearray(TRK_HEADER_SIZE)
    head[0:6] = b"TRACK\0"
    struct.pack_into("<3h", head, 6, 1, 1, 1)
    struct.pack_into("<3f", head, 12, 1.0, 1.0, 1.0)
    struct.pack_into("<16f", head, 440, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)
    head[948:952] = b"RAS\0"
    struct.pack_into("<i", head, 988, count)
    struct.pack_into("<i", head, 992, 2)
    struct.pack_into("<i", head, 996, TRK_HEADER_SIZE)
    return head


class TrkWriter:
    """A .trk written as streamlines pass: records copied from a .trk, or RAS points."""

    def __init__(self, path: Path, header: bytes | None):
        self.path = path
        self.little = True
        if header is not None:
            self.header = bytearray(header)
            self.little = struct.unpack("<i", bytes(self.header[996:1000]))[0] == TRK_HEADER_SIZE
        else:
            self.header = trk_header_ras()
        self.count = 0
        self.file = open(path, "wb")
        self.file.write(self.header)

    def copy(self, source, spans: np.ndarray) -> None:
        """Copies records (byte spans of the source .trk) unchanged."""
        parts = [source[s:e] for s, e in spans]
        if parts:
            self.file.write(b"".join(bytes(p) for p in parts))
        self.count += len(spans)

    def write_ras(self, points: np.ndarray, offsets: np.ndarray, rows: np.ndarray) -> None:
        """Streamlines in RAS+ mm, for the RAS header (voxmm = RAS + 0.5)."""
        out = []
        for r in rows:
            p = np.asarray(points[offsets[r]:offsets[r + 1]], np.float32) + np.float32(0.5)
            out.append(struct.pack("<i", len(p)))
            out.append(p.astype("<f4").tobytes())
        self.file.write(b"".join(out))
        self.count += len(rows)

    def close(self) -> None:
        self.file.seek(988)
        self.file.write(struct.pack("<i" if self.little else ">i", self.count))
        self.file.close()

    def abort(self) -> None:
        self.file.close()
        self.path.unlink(missing_ok=True)
