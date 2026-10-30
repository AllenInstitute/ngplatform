"""Build public/examples/ha1-excerpt.zarrvectors/: a few thousand streamlines of a store.

    python scripts/make_excerpt.py STORE [--count 2000] [--max-mb 14.5]

Streamlines are drawn from every bundle (``label_id``) in proportion to its
size, at full level-0 resolution, and written as a single-level zarr-vectors
store in RAS millimetres.  It is kept as plain files rather than a zip, so
any static host serves it: reading a zip needs HTTP range requests, which
not every host honours.  The store must stay under --max-mb (an artifact
host's limit is 15 MB a file); --count shrinks by a fifth until it does.

Needs zarr-vectors-py and zarr-vectors-tools.
"""

from __future__ import annotations

import argparse
import shutil
import tempfile
from pathlib import Path

import numpy as np
from zarr_vectors.types.polylines import write_polylines

from zarr_vectors_tools.filtering import load_tractogram

OUT = Path(__file__).resolve().parents[1] / "public" / "examples" / "ha1-excerpt.zarrvectors"


def pick(labels: np.ndarray, count: int, seed: int = 0) -> np.ndarray:
    rng = np.random.default_rng(seed)
    chosen = []
    values, sizes = np.unique(labels, return_counts=True)
    for value, size in zip(values, sizes):
        rows = np.flatnonzero(labels == value)
        take = min(size, max(3, int(round(count * size / len(labels)))))
        chosen.append(rng.choice(rows, take, replace=False))
    return np.sort(np.concatenate(chosen))


def build(tracts, rows: np.ndarray, where: Path) -> Path:
    store = where / "store"
    lines = [tracts.polyline(int(r)).astype(np.float32) for r in rows]
    labels = tracts.columns["label_id"][rows].astype(np.float32)
    write_polylines(
        # Few, large chunks: the whole excerpt is a handful of files, which
        # suits hosts that limit how many a site may hold.
        str(store), lines, chunk_shape=(64.0, 64.0, 64.0), geometry_type="streamline",
        object_attributes={"label_id": labels},
    )
    return store


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("store")
    parser.add_argument("--count", type=int, default=2000)
    parser.add_argument("--max-mb", type=float, default=14.5)
    args = parser.parse_args()
    tracts = load_tractogram(args.store, columns=["label_id"])
    count = args.count
    while True:
        rows = pick(np.asarray(tracts.columns["label_id"]), count)
        with tempfile.TemporaryDirectory() as tmp:
            store = build(tracts, rows, Path(tmp))
            files = [p for p in store.rglob("*") if p.is_file()]
            mb = sum(p.stat().st_size for p in files) / 1e6
            vertices = int(tracts.columns["n_vertices"][rows].sum())
            print(f"{len(rows)} streamlines, {vertices:,} vertices: {mb:.1f} MB in {len(files)} files")
            if mb <= args.max_mb:
                shutil.rmtree(OUT, ignore_errors=True)
                OUT.parent.mkdir(parents=True, exist_ok=True)
                shutil.copytree(store, OUT)
                print(f"wrote {OUT}")
                return
        count = int(count * 0.8)


if __name__ == "__main__":
    main()
