"""The filter job: the streamlines that pass a filter, as a .trk, a store and/or a density map.

``python -m ngplatform_runner.tasks.filter INPUT --filter FILTER.json
[--trk OUT.trk] [--store OUT.zarr --levels N] [--density OUT.nii --voxel MM]``

INPUT is a tractogram (.trk, .tck, .trx) or a Zarr Vectors store.  FILTER
is a zvf-predicate document (zarr-vectors-tools' filter-tree format:
regions with the path or endpoint modes, and, or, not, attribute
comparisons), in the coordinates of :mod:`.tractograms`.  Each batch of
streamlines is tested with zarr-vectors-tools' reference engine
(``filtering.oracle``), so the answer is the one the browser's filters are
tested against.

The tree's ``group`` nodes test a store's own groups, unless the document
carries ``groups`` of its own: sets of rows (object ids of a store,
streamline numbers of a file), each ``{"size": n, "bits": base64}`` with bit
k (most significant first) for row k.  The browser sends a track group's
tags that way, as the objects they choose.

- ``--trk``: from a .trk, the passing records are copied unchanged (header,
  scalars and properties kept); from a .tck or .trx, written in RAS+ mm;
  from a store, exported with zarr-vectors-tools' ``export_trk``.
- ``--store``: the passing streamlines converted with ``zvtools convert``
  (``--levels`` coarser levels, each keeping half the streamlines).
- ``--density``: how many passing streamlines go through each voxel
  (``--voxel`` mm), a float32 NIfTI on a grid around them, in the input's
  coordinates.
"""

from __future__ import annotations

import argparse
import base64
import gzip
import json
import struct
import sys
import time
from pathlib import Path

import numpy as np

from . import progress
from .tractograms import Batch, Source, TrkWriter, open_source

#: Passing points kept in memory for the density map instead of a second pass.
KEEP_POINTS = 30_000_000
#: Largest density grid, in voxels.
MAX_VOXELS = 600 ** 3


def _stored_space(store: Path) -> str:
    """"voxmm" for a store that keeps TrackVis voxel millimetres, else "rasmm"."""
    from zarr_vectors_tools.convert.export._streamlines import stored_space

    space, trk, _ = stored_space(store)
    return "voxmm" if space == "voxmm" and trk is not None else "rasmm"


def document_groups(doc: dict) -> list[np.ndarray] | None:
    """The row sets a filter document carries (see the module), as sorted rows; None when it carries none."""
    groups = doc.get("groups")
    if groups is None:
        return None
    if not isinstance(groups, list):
        raise ValueError("the filter's groups must be a list")
    out = []
    for k, group in enumerate(groups):
        try:
            size = int(group["size"])
            bits = np.frombuffer(base64.b64decode(group["bits"], validate=True), np.uint8)
        except (KeyError, TypeError, ValueError) as e:
            raise ValueError(f"the filter's group {k} is not {{size, bits}}: {e}") from e
        if size < 0 or len(bits) * 8 < size:
            raise ValueError(f"the filter's group {k} has {len(bits) * 8} bits, fewer than its size {size}")
        out.append(np.flatnonzero(np.unpackbits(bits, count=size)).astype(np.int64))
    return out


def batch_groups(groups: list[np.ndarray], first: int, n: int) -> list[np.ndarray]:
    """Each group's rows within a batch of ``n`` rows from ``first``, numbered from the batch's start."""
    return [g[(g >= first) & (g < first + n)] - first for g in groups]


def _tractogram(batch: Batch, groups):
    from zarr_vectors_tools.filtering import Tractogram

    return Tractogram(batch.points, batch.offsets, columns=dict(batch.columns), groups=groups)


def _evaluate(tree, batch: Batch, groups) -> np.ndarray:
    from zarr_vectors_tools.filtering import evaluate

    return evaluate(tree, _tractogram(batch, groups))


def _points_of(batch: Batch, rows: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    counts = batch.offsets[rows + 1] - batch.offsets[rows]
    offsets = np.zeros(len(rows) + 1, np.int64)
    offsets[1:] = np.cumsum(counts)
    total = int(offsets[-1])
    index = np.repeat(batch.offsets[rows] - offsets[:-1], counts) + np.arange(total, dtype=np.int64)
    return batch.points[index], offsets


class Density:
    """Streamlines per voxel, each streamline counted once in each voxel it passes through."""

    def __init__(self, lo: np.ndarray, hi: np.ndarray, voxel: float):
        self.voxel = float(voxel)
        self.origin = np.floor(lo / voxel) * voxel - voxel
        self.shape = tuple(int(s) for s in np.ceil((hi - self.origin) / voxel).astype(int) + 2)
        n = int(np.prod(self.shape, dtype=np.int64))
        if n > MAX_VOXELS:
            raise ValueError(f"a density grid of {' x '.join(map(str, self.shape))} voxels is too large; use larger voxels than {voxel} mm")
        self.counts = np.zeros(n, np.uint32)

    def add(self, points: np.ndarray, offsets: np.ndarray) -> None:
        n = len(offsets) - 1
        if n == 0 or len(points) == 0:
            return
        counts = np.diff(offsets)
        p = points.astype(np.float64)
        # Segments, and points along each at most half a voxel apart.
        per = np.where(counts >= 2, counts - 1, (counts == 1).astype(np.int64))
        total = int(per.sum())
        owner = np.repeat(np.arange(n, dtype=np.int64), per)
        start = np.arange(total, dtype=np.int64) - np.repeat(np.cumsum(per) - per - offsets[:-1], per)
        end = start + np.repeat(counts >= 2, per).astype(np.int64)
        a, b = p[start], p[end]
        steps = np.maximum(1, np.ceil(np.linalg.norm(b - a, axis=1) / (self.voxel / 2)).astype(np.int64))
        sample_owner = np.repeat(owner, steps + 1)
        seg = np.repeat(np.arange(total), steps + 1)
        t = (np.arange(int((steps + 1).sum())) - np.repeat(np.cumsum(steps + 1) - (steps + 1), steps + 1)) / np.repeat(steps, steps + 1)
        samples = a[seg] + (b[seg] - a[seg]) * t[:, None]
        ijk = np.floor((samples - self.origin) / self.voxel).astype(np.int64)
        shape = np.asarray(self.shape)
        ijk = np.clip(ijk, 0, shape - 1)
        flat = ijk[:, 0] + shape[0] * (ijk[:, 1] + shape[1] * ijk[:, 2])
        keys = np.unique(sample_owner * int(np.prod(shape)) + flat)
        np.add.at(self.counts, keys % int(np.prod(shape)), 1)

    def write(self, path: Path) -> None:
        """A NIfTI-1 image, float32, x fastest; the affine maps voxel centres to the input's coordinates."""
        nx, ny, nz = self.shape
        v = self.voxel
        centre = self.origin + v / 2
        header = bytearray(348)
        struct.pack_into("<i", header, 0, 348)
        struct.pack_into("<8h", header, 40, 3, nx, ny, nz, 1, 1, 1, 1)
        struct.pack_into("<h", header, 70, 16)  # datatype: float32
        struct.pack_into("<h", header, 72, 32)  # bits per voxel
        struct.pack_into("<8f", header, 76, 1.0, v, v, v, 1.0, 1.0, 1.0, 1.0)
        struct.pack_into("<f", header, 108, 352.0)  # vox_offset
        struct.pack_into("<f", header, 112, 1.0)  # scl_slope
        struct.pack_into("<f", header, 124, float(self.counts.max(initial=0)))  # cal_max
        header[123] = 10  # xyzt_units: mm, s
        struct.pack_into("<h", header, 252, 0)  # qform_code
        struct.pack_into("<h", header, 254, 1)  # sform_code: scanner
        struct.pack_into("<4f", header, 280, v, 0, 0, centre[0])
        struct.pack_into("<4f", header, 296, 0, v, 0, centre[1])
        struct.pack_into("<4f", header, 312, 0, 0, v, centre[2])
        header[148:148 + 24] = b"streamline density\0".ljust(24, b"\0")
        header[344:348] = b"n+1\0"
        body = bytes(header) + b"\0\0\0\0" + self.counts.astype("<f4").tobytes()
        if path.name.lower().endswith(".gz"):
            with gzip.open(path, "wb", compresslevel=4) as f:
                f.write(body)
        else:
            path.write_bytes(body)


def run(args: argparse.Namespace) -> dict:
    from zarr_vectors_tools.filtering import from_json

    document = json.loads(Path(args.filter).read_text())
    tree = from_json(document)
    carried = document_groups(document)
    source_path = Path(args.input)
    started = time.time()
    progress(0.0, f"Opening {source_path.name}")
    source = open_source(source_path)
    stages = 1 + (args.store is not None) + (args.density is not None)
    share = 1.0 / stages  # of the progress bar for the filtering pass
    temp_trk = None
    trk_path = Path(args.trk) if args.trk else None
    if args.store is not None and trk_path is None:
        store = Path(args.store)
        temp_trk = store.parent / f".{store.name}.filtered.trk"
        trk_path = temp_trk
    writer = None
    if trk_path is not None and source.kind != "store":
        writer = TrkWriter(trk_path, source.header if source.kind == "trk" else None)
    raw = np.memmap(source_path, dtype=np.uint8, mode="r") if source.kind == "trk" else None
    groups = carried if carried is not None else source.groups if source.kind == "store" else []

    passing_rows: list[np.ndarray] = []
    kept: list[tuple[np.ndarray, np.ndarray]] = []
    kept_points = 0
    lo = np.full(3, np.inf)
    hi = np.full(3, -np.inf)
    total = 0
    passed = 0
    try:
        for batch in source.batches():
            n = len(batch.offsets) - 1
            mask = _evaluate(tree, batch, batch_groups(groups, batch.first, n))
            rows = np.flatnonzero(mask)
            total += n
            passed += len(rows)
            passing_rows.append(rows + batch.first)
            if writer is not None and len(rows):
                if raw is not None and batch.spans is not None:
                    writer.copy(raw, batch.spans[rows])
                else:
                    writer.write_ras(batch.points, batch.offsets, rows)
            if args.density is not None and len(rows):
                points, offsets = _points_of(batch, rows)
                if len(points):
                    lo = np.minimum(lo, points.min(axis=0))
                    hi = np.maximum(hi, points.max(axis=0))
                if kept_points + len(points) <= KEEP_POINTS:
                    kept.append((points, offsets))
                    kept_points += len(points)
                else:
                    kept = []
                    kept_points = KEEP_POINTS + 1
            fraction = batch.done_bytes / source.total_bytes if source.total_bytes else 0.0
            progress(share * fraction, f"Tested {total:,} streamlines, {passed:,} pass")
    except BaseException:
        if writer is not None:
            writer.abort()
        raise
    if writer is not None:
        writer.close()
    if source.kind == "store" and trk_path is not None:
        from zarr_vectors_tools.convert.export.trk import export_trk

        progress(share * 0.95, f"Writing {passed:,} streamlines to {trk_path.name}")
        ids = np.concatenate(passing_rows).tolist() if passing_rows else []
        export_trk(source_path, trk_path, object_ids=ids)
    print(f"{passed:,} of {total:,} streamlines pass the filter ({time.time() - started:.1f} s)", flush=True)
    summary = {"streamlines": total, "passed": passed}
    done = share

    if args.store is not None:
        from zarr_vectors_tools.cli import main as zvtools

        progress(done, f"Writing the Zarr Vectors store {Path(args.store).name}")
        argv = ["convert", str(trk_path), str(args.store)]
        # The store keeps the input's coordinates: RAS+ mm for a file (as the
        # viewer reads the file), a store's own space for a store.
        if source.kind != "store" or _stored_space(source_path) != "voxmm":
            argv.append("--apply-affine")
        if args.levels > 0:
            argv += ["--sparsity", ",".join(["2"] * args.levels)]
        if args.overwrite:
            argv.append("--overwrite")
        if passed == 0:
            raise SystemExit("error: no streamline passes the filter, so there is no store to write")
        code = zvtools(argv)
        if temp_trk is not None:
            temp_trk.unlink(missing_ok=True)
        if code != 0:
            raise SystemExit(f"error: zvtools convert ended with exit code {code}")
        done += share

    if args.density is not None:
        if passed == 0 or not np.all(np.isfinite(lo)):
            raise SystemExit("error: no streamline passes the filter, so there is no density map")
        density = Density(lo, hi, args.voxel)
        progress(done, f"Density map on a {' x '.join(map(str, density.shape))} grid")
        if kept_points <= KEEP_POINTS:
            for points, offsets in kept:
                density.add(points, offsets)
        else:
            # Too many to keep: read the input again, taking only the passing rows.
            wanted = np.concatenate(passing_rows)
            for batch in source.batches():
                n = len(batch.offsets) - 1
                rows = wanted[(wanted >= batch.first) & (wanted < batch.first + n)] - batch.first
                if len(rows):
                    density.add(*_points_of(batch, rows))
                fraction = batch.done_bytes / source.total_bytes if source.total_bytes else 0.0
                progress(done + share * fraction, "Counting streamlines per voxel")
        density.write(Path(args.density))
        summary["density_shape"] = list(density.shape)
        summary["density_max"] = int(density.counts.max(initial=0))
    progress(1.0, f"{passed:,} of {total:,} streamlines pass")
    return summary


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="python -m ngplatform_runner.tasks.filter", description=__doc__.split("\n\n")[0])
    p.add_argument("input", help="a .trk, .tck or .trx file, or a Zarr Vectors store")
    p.add_argument("--filter", required=True, help="a zvf-predicate document (JSON file)")
    p.add_argument("--trk", default=None, help="write the passing streamlines to this .trk")
    p.add_argument("--store", default=None, help="write them to this Zarr Vectors store")
    p.add_argument("--levels", type=int, default=3, help="coarser levels in the store (default 3)")
    p.add_argument("--density", default=None, help="write their density map to this .nii or .nii.gz")
    p.add_argument("--voxel", type=float, default=1.0, help="density voxel edge, mm (default 1)")
    p.add_argument("--overwrite", action="store_true", help="replace outputs that exist")
    args = p.parse_args(argv)
    if args.trk is None and args.store is None and args.density is None:
        p.error("give at least one of --trk, --store, --density")
    for out in (args.trk, args.density):
        if out is not None and Path(out).exists() and not args.overwrite:
            p.error(f"{out} exists (use --overwrite)")
    try:
        summary = run(args)
    except (ValueError, OSError, KeyError) as e:
        print(f"error: {type(e).__name__}: {e}", file=sys.stderr)
        return 1
    print("summary: " + json.dumps(summary), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
