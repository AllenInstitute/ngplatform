"""SAM-Med3D's own pipeline, for comparison: utils/infer_utils.py validate_paired_img_gt (torchio resampling to
1.5 mm, canonical, a crop centred on the organ's bounding box, z-norm, one click drawn at random from the truth)
with the turbo weights through MedIM's model, organ by organ.

  python official.py IMAGE.nii.gz LABELS.nii.gz OUT.nii.gz     (from tools/sammed3d, with repo/ cloned)
"""
import sys
from pathlib import Path

import nibabel as nib
import numpy as np
import torch

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE / "repo"))
from sam_med3d_model import build_sam3D_vit_b_ori  # noqa: E402
from utils.infer_utils import validate_paired_img_gt  # noqa: E402

image, labels, out = sys.argv[1:4]
model = build_sam3D_vit_b_ori()
model.load_state_dict(torch.load(HERE / "turbo.pth", map_location="cpu", weights_only=True)["model_state_dict"])
model.eval()
validate_paired_img_gt(model, image, labels, out, num_clicks=1)
p = np.asarray(nib.load(out).dataobj).astype(int)
g = np.asarray(nib.load(labels).dataobj).astype(int)
for lab in sorted(int(v) for v in np.unique(g) if v > 0):
    a, b = p == lab, g == lab
    print(f"{lab:2d} Dice {2 * (a & b).sum() / max(1, a.sum() + b.sum()):.3f}")
