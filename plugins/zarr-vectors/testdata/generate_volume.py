"""Writes the volume-mesh fixtures (volume_tets1/2.zarrvectors, volume_tets.json): needs zarr-vectors-py with volume
elements (format 0.10; AllenInstitute/zarr-vectors-py#61).

    python generate_volume.py . 3

A cube of tetrahedra (Kuhn: 6 per hexahedral cell) written with element='tetra', in one chunk and in 2x2x2."""
import json, sys
from pathlib import Path
import numpy as np
import zarr_vectors as zv
from zarr_vectors.building import boundary_faces, signed_volumes

out = Path(sys.argv[1]); n = int(sys.argv[2]) if len(sys.argv) > 2 else 3
g = np.stack(np.meshgrid(*[np.arange(n + 1)] * 3, indexing="ij"), -1).reshape(-1, 3).astype(np.float32) * (8.0 / n) + 2.0
idx = lambda i, j, k: (i * (n + 1) + j) * (n + 1) + k
# Kuhn's six tetrahedra of a cube, each along the main diagonal 0 -> 7.
K = [(0, 1, 3, 7), (0, 1, 5, 7), (0, 2, 3, 7), (0, 2, 6, 7), (0, 4, 5, 7), (0, 4, 6, 7)]
cells = []
for i in range(n):
    for j in range(n):
        for k in range(n):
            c = [idx(i + (b >> 2 & 1), j + (b >> 1 & 1), k + (b & 1)) for b in range(8)]
            for t in K:
                cells.append([c[t[0]], c[t[1]], c[t[2]], c[t[3]]])
cells = np.array(cells, np.int64)
# VTK order: positive volume.
neg = signed_volumes(g, cells, "tetra") < 0
cells[neg] = cells[neg][:, [0, 2, 1, 3]]
assert (signed_volumes(g, cells, "tetra") > 0).all()
for cellsz in (1, 2):
    schema = zv.Schema(bounds=([0.0] * 3, [12.0] * 3), kind="mesh", layout=zv.Layout(cells=cellsz), axes=[zv.Axis(a, "millimeter") for a in "xyz"])
    ds = zv.create(str(out / f"volume_tets{cellsz}.zarrvectors"), schema=schema)
    ds.add_mesh(g, cells, element="tetra")
b = boundary_faces(cells, "tetra")
json.dump({"vertices": g.tolist(), "cells": cells.tolist(), "boundary": [x.tolist() for x in b]}, open(out / "volume_tets.json", "w"))
print("cells", len(cells), "boundary faces", [len(x) for x in b])
