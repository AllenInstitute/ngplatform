"""The MNI152NLin2009aAsym T1w template, brain only, as a uint8 OME-Zarr 0.5
image (zarr v3, zstd) with a 1 mm and a 2 mm level, for the volume view.
How the site's data/MNI152NLin2009aAsym_T1w_brain.ome.zarr was made.

    B=https://templateflow.s3.amazonaws.com/tpl-MNI152NLin2009aAsym
    curl -O $B/tpl-MNI152NLin2009aAsym_res-1_T1w.nii.gz \
         -O $B/tpl-MNI152NLin2009aAsym_res-1_desc-brain_mask.nii.gz -O $B/LICENSE
    python3 tools/mni_template_to_omezarr.py tpl-MNI152NLin2009aAsym_res-1_T1w.nii.gz \
        tpl-MNI152NLin2009aAsym_res-1_desc-brain_mask.nii.gz LICENSE \
        MNI152NLin2009aAsym_T1w_brain.ome.zarr

Needs nibabel, numpy, scipy and zarr 3.
"""
import json
import pathlib
import shutil
import sys

import nibabel as nib
import numpy as np
from scipy.ndimage import gaussian_filter
import zarr
from zarr.codecs import ZstdCodec

t1_path, mask_path, licence_path, out = sys.argv[1:5]
t1 = nib.load(t1_path)
mask = nib.load(mask_path)
assert nib.aff2axcodes(t1.affine) == ("R", "A", "S"), nib.aff2axcodes(t1.affine)
assert np.allclose(t1.affine, mask.affine)
affine = t1.affine
assert np.allclose(affine[:3, :3], np.eye(3)), affine

a = np.asarray(t1.dataobj, dtype=np.float32)
inside = np.asarray(mask.dataobj) > 0.5
top = np.percentile(a[inside], 99.9)
# The mask's edge softened over about a millimetre, so the brain's surface
# is not the mask's 1 mm voxel steps; 0 well outside the brain.
soft = np.clip(gaussian_filter(inside.astype(np.float32), sigma=1.0), 0, 1)
level0 = np.round(soft * (1 + np.clip(a, 0, top) / top * 254)).astype(np.uint8)


def halve(v: np.ndarray) -> np.ndarray:
    """Means of 2 x 2 x 2 blocks (edges padded by repetition)."""
    pad = [(0, s % 2) for s in v.shape]
    v = np.pad(v.astype(np.float32), pad, mode="edge")
    x, y, z = (s // 2 for s in v.shape)
    return np.round(v.reshape(x, 2, y, 2, z, 2).mean(axis=(1, 3, 5))).astype(np.uint8)


levels = [level0, halve(level0)]
licence = pathlib.Path(licence_path).read_text().strip()
origin = affine[:3, 3]  # x, y, z of voxel (0, 0, 0)'s centre

root = pathlib.Path(out)
if root.exists():
    shutil.rmtree(root)
group = zarr.open_group(str(root), mode="w", zarr_format=3)
datasets = []
for i, level in enumerate(levels):
    step = 2.0**i
    zyx = np.ascontiguousarray(level.transpose(2, 1, 0))
    arr = group.create_array(
        str(i),
        shape=zyx.shape,
        chunks=(64, 64, 64),
        dtype="uint8",
        fill_value=0,
        compressors=ZstdCodec(level=19),
        dimension_names=["z", "y", "x"],
    )
    arr[...] = zyx
    # A coarse voxel's centre is the mean of the fine voxels it covers.
    shift = (step - 1) / 2
    datasets.append(
        {
            "path": str(i),
            "coordinateTransformations": [
                {"type": "scale", "scale": [step, step, step]},
                {"type": "translation", "translation": [float(origin[2] + shift), float(origin[1] + shift), float(origin[0] + shift)]},
            ],
        }
    )
group.attrs["ome"] = {
    "version": "0.5",
    "multiscales": [
        {
            "name": "MNI152NLin2009aAsym T1w, brain",
            "axes": [{"name": n, "type": "space", "unit": "millimeter"} for n in ("z", "y", "x")],
            "datasets": datasets,
            "metadata": {
                "description": (
                    "ICBM 152 Nonlinear Asymmetrical template version 2009a (Fonov et al., NeuroImage 2011), "
                    "T1w masked by its brain mask (edge softened, sigma 1 mm), as distributed by TemplateFlow (tpl-MNI152NLin2009aAsym, res-1). "
                    "Scaled to 1-255 inside the brain by the 99.9th percentile. " + licence
                ),
                "source": "https://templateflow.s3.amazonaws.com/tpl-MNI152NLin2009aAsym/",
            },
        }
    ],
}
(root / "LICENSE").write_text(licence + "\n")
print(json.dumps({"shapes": [list(l.shape) for l in levels], "top": float(top), "origin": origin.tolist()}))
print("histogram inside (0..255, 16 bins):", np.histogram(level0[inside], bins=16, range=(0, 256))[0].tolist())
