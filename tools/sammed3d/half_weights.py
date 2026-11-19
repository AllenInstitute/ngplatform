"""SAM-Med3D's graphs with their float weights stored as float16 (a Cast to float32 after each), into onnx16/ with
manifest.json (each file, its size, a version: a hash of the files). Copy onnx16/ to models/sammed3d/ for `npm run
dev`, or host it and set localStorage ngplatform.sammed3d.url."""
import hashlib, json, shutil, sys
from pathlib import Path
import numpy as np
import onnx
from onnx import helper, numpy_helper, TensorProto

src = Path(sys.argv[1] if len(sys.argv) > 1 else "onnx")
dst = Path(sys.argv[2] if len(sys.argv) > 2 else "onnx16")
dst.mkdir(exist_ok=True)
for f in ["encoder", "decoder"]:
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
names = {"encoder": "encoder.onnx", "decoder": "decoder.onnx", "constants": "constants.json"}
digest = hashlib.sha256()
for n in names.values():
    digest.update((dst / n).read_bytes())
manifest = {"version": digest.hexdigest()[:16], "files": {k: {"name": n, "bytes": (dst / n).stat().st_size} for k, n in names.items()}}
(dst / "manifest.json").write_text(json.dumps(manifest, indent=1) + "\n")
print("manifest", manifest["version"], round(sum(f["bytes"] for f in manifest["files"].values()) / 1e6, 1), "MB")
