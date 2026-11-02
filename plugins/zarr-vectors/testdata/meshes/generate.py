"""Writes small mesh files (a cube of quads and a tetrahedron) as .obj, STL
(binary and ASCII) and PLY (ASCII, binary both endians), and expected.json:
each file's triangles as corner coordinates, per object.

    python generate.py
"""
import json
import os
import struct

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
cube_v = np.array([[x, y, z] for z in (0, 2) for y in (0, 2) for x in (0, 2)], np.float32) + [10.5, -3.25, 7]
cube_quads = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]]
tet_v = np.array([[0, 0, 0], [1.5, 0, 0], [0, 1.5, 0], [0, 0, 1.5]], np.float32) - 4
tet_f = [[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]]


def fan(quads):
    return [[q[0], q[k], q[k + 1]] for q in quads for k in range(1, len(q) - 1)]


cube_t = fan(cube_quads)
corners = lambda v, t: [[v[i].tolist() for i in tri] for tri in t]
expected = {}

with open(os.path.join(HERE, "two.obj"), "w") as f:
    f.write("# a cube of quads and a tetrahedron\no cube\n")
    for v in cube_v:
        f.write("v %r %r %r\n" % tuple(float(x) for x in v))
    for q in cube_quads:
        f.write("f " + " ".join(f"{i + 1}/{i + 1}" for i in q) + "\n")
    f.write("o tetrahedron\n")
    for v in tet_v:
        f.write("v %r %r %r\n" % tuple(float(x) for x in v))
    for t in tet_f:  # negative (relative) indices
        f.write("f " + " ".join(str(i - 4) for i in t) + "\n")
expected["two.obj"] = {"objects": ["cube", "tetrahedron"], "triangles": [corners(cube_v, cube_t), corners(tet_v, tet_f)], "vertices": 12}

with open(os.path.join(HERE, "cube_binary.stl"), "wb") as f:
    f.write(b"binary cube".ljust(80, b" ") + struct.pack("<I", len(cube_t)))
    for t in cube_t:
        f.write(struct.pack("<3f", 0, 0, 0) + b"".join(struct.pack("<3f", *cube_v[i]) for i in t) + b"\0\0")
with open(os.path.join(HERE, "cube_ascii.stl"), "w") as f:
    f.write("solid cube\n")
    for t in cube_t:
        f.write("  facet normal 0 0 0\n    outer loop\n" + "".join("      vertex %r %r %r\n" % tuple(float(x) for x in cube_v[i]) for i in t) + "    endloop\n  endfacet\n")
    f.write("endsolid cube\n")
for name in ["cube_binary.stl", "cube_ascii.stl"]:
    expected[name] = {"objects": [name[:-4]], "triangles": [corners(cube_v, cube_t)], "vertices": 8}


def ply(name, fmt):
    header = f"ply\nformat {fmt} 1.0\ncomment cube\nelement vertex {len(cube_v)}\nproperty float x\nproperty float y\nproperty float z\nproperty uchar red\nelement face {len(cube_quads)}\nproperty list uchar int vertex_indices\nend_header\n"
    with open(os.path.join(HERE, name), "wb") as f:
        f.write(header.encode())
        if fmt == "ascii":
            for v in cube_v:
                f.write(("%r %r %r 7\n" % tuple(float(x) for x in v)).encode())
            for q in cube_quads:
                f.write((f"{len(q)} " + " ".join(map(str, q)) + "\n").encode())
        else:
            e = "<" if fmt == "binary_little_endian" else ">"
            for v in cube_v:
                f.write(struct.pack(e + "3fB", *v, 7))
            for q in cube_quads:
                f.write(struct.pack(e + "B4i", len(q), *q))
    expected[name] = {"objects": [name[:-4]], "triangles": [corners(cube_v, cube_t)], "vertices": 8}


ply("cube_ascii.ply", "ascii")
ply("cube_le.ply", "binary_little_endian")
ply("cube_be.ply", "binary_big_endian")
with open(os.path.join(HERE, "expected.json"), "w") as f:
    json.dump(expected, f)
print(sorted(expected))
