"""Writes a small FreeSurfer subject (an icosahedron as lh.white, lh.pial and
lh.inflated) with values on its vertices in every format the platform reads,
and expected.json: each file's values (and labels) as nibabel reads them.

    surf/   lh.white lh.pial lh.inflated  surfaces
            lh.thickness lh.sulc          morphometry (FreeSurfer's new curv format)
            lh.avg_curv                   morphometry in the old format (int16 hundredths)
            lh.w-g.pct.mgh                an overlay as MGH (12 x 1 x 1)
            lh.overlay.mgz                an overlay as MGZ, int32
            lh.thickness.shape.gii        GIFTI shape
            lh.aparc.label.gii            GIFTI labels with a label table
    label/  lh.aparc.annot                a parcellation (new colour table)
            lh.old.annot                  a parcellation (old colour table, written by hand)
            lh.V1.label lh.cortex.label   labels

    python generate.py
"""
import json
import os
import struct

import nibabel as nib
import numpy as np
from nibabel.freesurfer import read_annot, read_label, read_morph_data, write_annot, write_geometry, write_morph_data
from nibabel.gifti import GiftiDataArray, GiftiImage, GiftiLabel, GiftiLabelTable, GiftiMetaData

HERE = os.path.dirname(os.path.abspath(__file__))
SURF = os.path.join(HERE, "surf")
LABEL = os.path.join(HERE, "label")
os.makedirs(SURF, exist_ok=True)
os.makedirs(LABEL, exist_ok=True)

t = (1 + 5 ** 0.5) / 2
verts = np.array([[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]], np.float32) * 20
faces = np.array([[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]], np.int32)
n = len(verts)
info = {"head": [2, 0, 20], "valid": "1  # volume info valid", "filename": "orig.mgz", "volume": [256, 256, 256],
        "voxelsize": [1.0, 1.0, 1.0], "xras": [-1.0, 0.0, 0.0], "yras": [0.0, 0.0, -1.0], "zras": [0.0, 1.0, 0.0], "cras": [1.5, -17.25, 20.0]}
write_geometry(os.path.join(SURF, "lh.white"), verts, faces, volume_info=info)
write_geometry(os.path.join(SURF, "lh.pial"), verts * 1.1, faces, volume_info=info)
write_geometry(os.path.join(SURF, "lh.inflated"), verts * 1.5, faces, volume_info=info)

expected = {}
rng = np.random.default_rng(7)

thickness = rng.uniform(1, 4, n).astype(np.float32)
write_morph_data(os.path.join(SURF, "lh.thickness"), thickness)
sulc = rng.normal(0, 5, n).astype(np.float32)
write_morph_data(os.path.join(SURF, "lh.sulc"), sulc)
for name in ["lh.thickness", "lh.sulc"]:
    expected[f"surf/{name}"] = {"values": read_morph_data(os.path.join(SURF, name)).tolist()}

# The old format, which nibabel reads but does not write: 3-byte vertex and
# face counts, then int16 hundredths.
avg = np.round(rng.normal(0, 0.3, n) * 100).astype(">i2")
with open(os.path.join(SURF, "lh.avg_curv"), "wb") as f:
    f.write(n.to_bytes(3, "big") + len(faces).to_bytes(3, "big") + avg.tobytes())
expected["surf/lh.avg_curv"] = {"values": read_morph_data(os.path.join(SURF, "lh.avg_curv")).tolist()}

pct = rng.uniform(-20, 20, n).astype(np.float32)
nib.save(nib.MGHImage(pct.reshape(n, 1, 1), np.eye(4)), os.path.join(SURF, "lh.w-g.pct.mgh"))
expected["surf/lh.w-g.pct.mgh"] = {"values": np.asarray(nib.load(os.path.join(SURF, "lh.w-g.pct.mgh")).get_fdata()).ravel().tolist()}
ints = rng.integers(-100, 100, n).astype(np.int32)
nib.save(nib.MGHImage(ints.reshape(n, 1, 1), np.eye(4)), os.path.join(SURF, "lh.overlay.mgz"))
expected["surf/lh.overlay.mgz"] = {"values": np.asarray(nib.load(os.path.join(SURF, "lh.overlay.mgz")).get_fdata()).ravel().tolist()}

# GIFTI: a shape array, and labels with a table.
shape = GiftiDataArray(thickness, intent="NIFTI_INTENT_SHAPE", datatype="NIFTI_TYPE_FLOAT32", encoding="GIFTI_ENCODING_B64GZ",
                       meta=GiftiMetaData({"Name": "thickness"}))
nib.save(GiftiImage(darrays=[shape]), os.path.join(SURF, "lh.thickness.shape.gii"))
expected["surf/lh.thickness.shape.gii"] = {"thickness": {"values": nib.load(os.path.join(SURF, "lh.thickness.shape.gii")).darrays[0].data.astype(float).tolist()}}
table = GiftiLabelTable()
for key, (name, rgba) in enumerate([("???", (0, 0, 0, 0)), ("frontal", (0.8, 0.2, 0.2, 1)), ("occipital", (0.2, 0.2, 0.8, 1))]):
    label = GiftiLabel(key=key, red=rgba[0], green=rgba[1], blue=rgba[2], alpha=rgba[3])
    label.label = name
    table.labels.append(label)
codes = (np.arange(n) % 3).astype(np.int32)
labels = GiftiDataArray(codes, intent="NIFTI_INTENT_LABEL", datatype="NIFTI_TYPE_INT32", encoding="GIFTI_ENCODING_B64BIN",
                        meta=GiftiMetaData({"Name": "lobes"}))
nib.save(GiftiImage(darrays=[labels], labeltable=table), os.path.join(SURF, "lh.aparc.label.gii"))
image = nib.load(os.path.join(SURF, "lh.aparc.label.gii"))
expected["surf/lh.aparc.label.gii"] = {"lobes": {
    "values": image.darrays[0].data.astype(float).tolist(),
    "labels": [{"code": lab.key, "name": lab.label, "rgba": [float(c) for c in lab.rgba]} for lab in image.labeltable.labels]}}

# Parcellations.
ctab = np.array([[25, 5, 25, 0, 0], [220, 20, 10, 0, 0], [20, 220, 60, 0, 0], [60, 20, 220, 0, 0]], np.int32)
names = [b"unknown", b"precentral", b"postcentral", b"lingual"]
parcel = rng.integers(0, 4, n).astype(np.int32)
parcel[[2, 5]] = -1
write_annot(os.path.join(LABEL, "lh.aparc.annot"), parcel, ctab, names, fill_ctab=True)


def annot_expected(path):
    codes, table, labelnames = read_annot(path)
    return {"values": codes.astype(float).tolist(),
            "labels": [{"code": i, "name": nm.decode(), "rgba": [table[i, 0] / 255, table[i, 1] / 255, table[i, 2] / 255, 1 - table[i, 3] / 255]}
                       for i, nm in enumerate(labelnames)]}


expected["label/lh.aparc.annot"] = annot_expected(os.path.join(LABEL, "lh.aparc.annot"))


# The old colour table layout, written by hand (nibabel writes the new one).
def i32(v):
    return struct.pack(">i", v)


old = ctab[:3]
packed = old[:, 0] + old[:, 1] * 256 + old[:, 2] * 65536
assign = rng.integers(0, 3, n)
body = i32(n) + b"".join(i32(v) + i32(int(packed[assign[v]])) for v in range(n))
body += i32(1) + i32(len(old)) + i32(8) + b"ctab.txt"
for row, nm in zip(old, names[:3]):
    body += i32(len(nm) + 1) + nm + b"\0" + b"".join(i32(int(c)) for c in row[:4])
with open(os.path.join(LABEL, "lh.old.annot"), "wb") as f:
    f.write(body)
expected["label/lh.old.annot"] = annot_expected(os.path.join(LABEL, "lh.old.annot"))


def write_label(name, vertices):
    with open(os.path.join(LABEL, name), "w") as f:
        f.write(f"#!ascii label  , from subject  vox2ras=TkReg\n{len(vertices)}\n")
        for v in vertices:
            x, y, z = verts[v]
            f.write(f"{v}  {x:.3f}  {y:.3f}  {z:.3f} 0.0000000000\n")
    expected[f"label/{name}"] = {"vertices": read_label(os.path.join(LABEL, name)).tolist()}


write_label("lh.cortex.label", list(range(10)))
write_label("lh.V1.label", [1, 3, 4])

with open(os.path.join(HERE, "expected.json"), "w") as f:
    json.dump(expected, f)
print(sorted(expected))
