"""SAM-Med3D-turbo's model code, as export_onnx.py imports it: MedIM's models/sam_med3d.py (its builder takes the
turbo checkpoint's 128 cube and single-mask decoder; the SAM-Med3D repository's own builder does not), from the
MedIM wheel, with MedIM's registry and weight-loading imports stubbed out.

  python3 -m pip download medim==0.1.2 --no-deps -d wheel && python prepare_model.py wheel/medim-*.whl
"""
import re
import sys
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
with zipfile.ZipFile(sys.argv[1]) as z:
    name = next(n for n in z.namelist() if n.endswith("models/sam_med3d.py"))
    src = z.read(name).decode()
stub = "def register_model(name):\n    return lambda f: f\nload_pretrained_weights = None\n"
lines = []
for line in src.splitlines():
    # MedIM's own imports (relative or medim.*): replaced by the stub.
    if re.match(r"\s*from\s+(\.|medim)", line) or re.match(r"\s*import\s+medim", line):
        continue
    lines.append(line)
text = "\n".join(lines)
first = text.find("\n\n")
(HERE / "sam_med3d_model.py").write_text(text[:first] + "\n" + stub + text[first:] + "\n")
print("sam_med3d_model.py written from", name)
