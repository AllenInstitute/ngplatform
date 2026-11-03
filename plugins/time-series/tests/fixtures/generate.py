"""Writes tiny.nii.gz: a 4-D NIfTI (6 x 5 x 4 voxels, 12 time points, int16) for the tests.

The voxel (x, y, z) at time point t holds x + 10 y + 100 z + 1000 t; voxels
are 2 x 2 x 3 mm and the time step (pixdim[4]) is 1.5 s.  Run with nibabel:

    python generate.py
"""
from pathlib import Path

import nibabel as nib
import numpy as np

x, y, z, t = np.meshgrid(np.arange(6), np.arange(5), np.arange(4), np.arange(12), indexing="ij")
data = (x + 10 * y + 100 * z + 1000 * t).astype(np.int16)
affine = np.array([[2.0, 0, 0, -6], [0, 2.0, 0, -4], [0, 0, 3.0, 1], [0, 0, 0, 1]])
img = nib.Nifti1Image(data, affine)
img.header.set_xyzt_units("mm", "sec")
img.header["pixdim"][4] = 1.5
img.header.set_sform(affine, code=1)
img.header.set_qform(affine, code=1)
nib.save(img, Path(__file__).with_name("tiny.nii.gz"))
