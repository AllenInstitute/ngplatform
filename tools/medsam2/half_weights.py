"""Each ONNX graph with its float weights stored as float16 (a Cast to float32 after each): half the download,
the arithmetic still in float32. onnx/ -> onnx16/, with manifest.json: each file and its size, and a version (a
hash of the files) under which the app keeps them, so a new export is downloaded afresh.

The app looks for them at models/medsam2/ beside itself (copy onnx16/ to public/models/medsam2/ for `npm run
dev`), or where localStorage ngplatform.medsam2.url says."""
import hashlib
import json
import shutil
from pathlib import Path
import numpy as np
import onnx
from onnx import helper, numpy_helper, TensorProto

src, dst = Path("onnx"), Path("onnx16")
dst.mkdir(exist_ok=True)
for f in ["encoder", "heads", "memory_encoder", "memory_attention"]:
    m = onnx.load(src / f"{f}.onnx")
    g = m.graph
    keep, casts = [], []
    for init in g.initializer:
        a = numpy_helper.to_array(init)
        if a.dtype == np.float32 and a.size >= 1024:
            half = numpy_helper.from_array(a.astype(np.float16), init.name + "__f16")
            keep.append(half)
            casts.append(helper.make_node("Cast", [half.name], [init.name], to=TensorProto.FLOAT, name=init.name + "__cast"))
        else:
            keep.append(init)
    del g.initializer[:]
    g.initializer.extend(keep)
    nodes = list(g.node)
    del g.node[:]
    g.node.extend(casts + nodes)
    onnx.save(m, dst / f"{f}.onnx")
    print(f, f"{(src / f'{f}.onnx').stat().st_size / 1e6:.1f} MB -> {(dst / f'{f}.onnx').stat().st_size / 1e6:.1f} MB")
shutil.copy(src / "constants.json", dst / "constants.json")

names = {"encoder": "encoder.onnx", "attention": "memory_attention.onnx", "heads": "heads.onnx", "memoryEncoder": "memory_encoder.onnx", "constants": "constants.json"}
digest = hashlib.sha256()
for n in names.values():
    digest.update((dst / n).read_bytes())
manifest = {"version": digest.hexdigest()[:16], "files": {k: {"name": n, "bytes": (dst / n).stat().st_size} for k, n in names.items()}}
(dst / "manifest.json").write_text(json.dumps(manifest, indent=1) + "\n")
print("manifest.json:", manifest["version"], sum(f["bytes"] for f in manifest["files"].values()) / 1e6, "MB")
