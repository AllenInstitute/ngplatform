"""The scene both path tracers draw for the golden comparison (plugins/anatomical-rendering/tests/golden.mts):
an empty volume (48 mm a side, 1 mm voxels; Neuroglancer precomputed, raw chunks) and a Zarr Vectors mesh in it
(a sphere and a torus, in mm, one level), and the render computer's picture and depth of it for a view.

    python golden_scene.py write DIR             # the scene, in DIR/em and DIR/mesh.zv
    python golden_scene.py render DIR VIEW OUT   # the render computer's depth (OUT.json) and picture (OUT.png) of
                                                 # VIEW (a view spec, JSON), on this computer's CUDA GPU

Needs the runner's render dependencies and the `zarr_vectors` package (zarr 3).
"""

from __future__ import annotations

import json
import sys
import threading
import time
import urllib.request
import zlib
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

SIZE = 48


def mesh() -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """A sphere (radius 9 mm about (16, 24, 24)) and a torus (radii 9 and 3 mm about (33, 24, 24), its axis along
    y): vertices (mm), faces, and each vertex's object (1, 2)."""
    verts, faces, objs = [], [], []

    def grid(f, nu, nv, obj, closed_v):
        base = sum(len(v) for v in verts)
        u = np.linspace(0, 2 * np.pi, nu, endpoint=False)
        v = np.linspace(0, 2 * np.pi if closed_v else np.pi, nv if closed_v else nv + 1, endpoint=not closed_v)
        U, V = np.meshgrid(u, v, indexing="ij")
        p = f(U, V).reshape(-1, 3)
        rows = len(v)
        f_ = []
        for i in range(nu):
            for j in range(rows if closed_v else rows - 1):
                a, b = i * rows + j, ((i + 1) % nu) * rows + j
                c, d = ((i + 1) % nu) * rows + (j + 1) % rows, i * rows + (j + 1) % rows
                f_ += [[a, b, c], [a, c, d]]
        verts.append(p)
        faces.append(np.array(f_) + base)
        objs.append(np.full(len(p), obj))

    grid(lambda U, V: np.stack([16 + 9 * np.sin(V) * np.cos(U), 24 + 9 * np.sin(V) * np.sin(U), 24 + 9 * np.cos(V)], -1), 48, 24, 1, False)
    grid(lambda U, V: np.stack([33 + (9 + 3 * np.cos(V)) * np.cos(U), 24 + 3 * np.sin(V), 24 + (9 + 3 * np.cos(V)) * np.sin(U)], -1), 64, 24, 2, True)
    return np.concatenate(verts).astype("float32"), np.concatenate(faces).astype("int64"), np.concatenate(objs).astype("int64")


def write(root: Path) -> None:
    import zarr_vectors as zv

    em = root / "em"
    (em / "s0").mkdir(parents=True, exist_ok=True)
    (em / "info").write_text(json.dumps({"type": "image", "data_type": "uint8", "num_channels": 1, "scales": [
        {"key": "s0", "size": [SIZE] * 3, "resolution": [1e6] * 3, "voxel_offset": [0, 0, 0], "chunk_sizes": [[16, 16, 16]], "encoding": "raw"}]}))
    for z in range(0, SIZE, 16):
        for y in range(0, SIZE, 16):
            for x in range(0, SIZE, 16):
                (em / "s0" / f"{x}-{x + 16}_{y}-{y + 16}_{z}-{z + 16}").write_bytes(bytes(16 ** 3))
    v, f, o = mesh()
    schema = zv.Schema(bounds=([0.0] * 3, [float(SIZE)] * 3), kind="mesh", layout=zv.Layout(cells=2), axes=[zv.Axis(n, "millimeter") for n in "xyz"])
    ds = zv.create(str(root / "mesh.zv"), schema=schema)
    ds.add_mesh(v, f, object_ids=o)


def render(root: Path, view_path: Path, out: Path) -> None:
    from ngplatform_render import server

    view = json.loads(view_path.read_text())
    srv = server.RenderServer(0, "tok", [root], 0, root / "renders")
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{srv.server_port}"

    def call(method, path, body=None, raw=False):
        r = urllib.request.Request(base + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                   headers={"X-NGP-Service-Token": "tok", "Content-Type": "application/json"})
        with urllib.request.urlopen(r, timeout=120) as f:
            return (f.headers, f.read()) if raw else json.loads(f.read() or b"null")

    s = call("POST", "/sessions", {"volume": {"url": f"precomputed://{root / 'em'}"}, "objects": {"url": str(root / "mesh.zv"), "store": "zarr-vectors"}})
    for _ in range(1200):
        info = call("GET", f"/sessions/{s['id']}")
        if info["status"] != "loading":
            break
        time.sleep(0.05)
    if info["status"] != "ready":
        raise SystemExit(f"the session did not open: {info}")
    # The volume clear (its preset may draw empty tissue): only the mesh met.
    view = {**view, "max_samples": 16, "objects": {"show": True}, "overrides": {**(view.get("overrides") or {}), "density": 0}}
    call("PUT", f"/sessions/{s['id']}/view", view)
    h, png = call("GET", f"/sessions/{s['id']}/frame?after=0&timeout=60", raw=True)
    (out.with_suffix(".png")).write_bytes(png)
    h, dz = call("GET", f"/sessions/{s['id']}/depth", raw=True)
    w, hh = int(h["X-Width"]), int(h["X-Height"])
    depth = np.frombuffer(zlib.decompress(dz), np.float16).reshape(hh, w).astype(np.float32)
    out.with_suffix(".json").write_text(json.dumps({"width": w, "height": hh, "depth": depth.ravel().round(6).tolist(), "objects": info.get("objects")}))
    srv.shutdown()


if __name__ == "__main__":
    if sys.argv[1] == "write":
        write(Path(sys.argv[2]))
    else:
        render(Path(sys.argv[2]), Path(sys.argv[3]), Path(sys.argv[4]))
