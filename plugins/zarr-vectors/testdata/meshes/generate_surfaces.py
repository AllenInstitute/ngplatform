"""Writes GIFTI and FreeSurfer surface fixtures with nibabel, and
expected_surfaces.json: each surface's triangles as corner coordinates where
zarr-vectors-tools places them (anatomical surfaces moved into scanner RAS:
the GIFTI matrix to a named space, FreeSurfer's c_ras; inflated ones left).

    python generate_surfaces.py
"""
import json
import os

import nibabel as nib
import numpy as np
from nibabel.freesurfer import write_geometry
from nibabel.gifti import GiftiCoordSystem, GiftiDataArray, GiftiImage, GiftiMetaData

HERE = os.path.dirname(os.path.abspath(__file__))
t = (1 + 5 ** 0.5) / 2
verts = np.array([[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]], np.float32) * 20
faces = np.array([[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]], np.int32)
shift = np.array([1.5, -17.25, 20.0])
expected = {}


def corners(v):
    return [[v[i].astype(float).tolist() for i in tri] for tri in faces]


def gifti(name, encoding, geometric, moved):
    xform = np.eye(4)
    xform[:3, 3] = shift
    coords = GiftiDataArray(verts, intent="NIFTI_INTENT_POINTSET", datatype="NIFTI_TYPE_FLOAT32", encoding=encoding,
                            coordsys=GiftiCoordSystem(dataspace=0, xformspace=1, xform=xform),
                            meta=GiftiMetaData({"GeometricType": geometric}))
    tris = GiftiDataArray(faces, intent="NIFTI_INTENT_TRIANGLE", datatype="NIFTI_TYPE_INT32", encoding=encoding)
    nib.save(GiftiImage(darrays=[coords, tris]), os.path.join(HERE, name))
    expected[name] = corners(verts.astype(np.float64) + shift if moved else verts)


gifti("ico.surf.gii", "GIFTI_ENCODING_B64GZ", "Anatomical", True)
gifti("ico_ascii.surf.gii", "GIFTI_ENCODING_ASCII", "Anatomical", True)
gifti("ico_inflated.surf.gii", "GIFTI_ENCODING_B64BIN", "Inflated", False)

info = {"head": [2, 0, 20], "valid": "1  # volume info valid", "filename": "orig.mgz", "volume": [256, 256, 256],
        "voxelsize": [1.0, 1.0, 1.0], "xras": [-1.0, 0.0, 0.0], "yras": [0.0, 0.0, -1.0], "zras": [0.0, 1.0, 0.0], "cras": shift}
write_geometry(os.path.join(HERE, "lh.pial"), verts, faces, volume_info=info)
write_geometry(os.path.join(HERE, "lh.inflated"), verts, faces, volume_info=info)
expected["lh.pial"] = corners(verts.astype(np.float64) + shift)
expected["lh.inflated"] = corners(verts)
with open(os.path.join(HERE, "expected_surfaces.json"), "w") as f:
    json.dump(expected, f)
print(sorted(expected))
