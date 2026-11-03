"""
A real example for the orientations plugin: DIPY's Stanford HARDI sample
(2 mm, 150 directions at b = 2000; downloaded by DIPY, about 90 MB) fitted
with constrained spherical deconvolution (order 8, DIPY's legacy
descoteaux07 basis) and with a tensor model, each written as a multiscale
OME-Zarr 0.5 image with a channel axis of components:

    stanford_hardi_csd.ome.zarr      45 SH coefficients per voxel
    stanford_hardi_dti.ome.zarr      6 tensor components (DIPY's order)

Each coarser level is the mean of 2 x 2 x 2 boxes of the finer one, over
the voxels inside the brain mask; for spherical harmonics that is the mean
ODF of the box.  Tensors are averaged log-Euclidean (the mean of their
matrix logarithms, exponentiated; tensors that are not positive definite
left out), which keeps their determinants where a plain mean would swell
them.  The stores say what they hold in `attributes.orientations`.

Needs dipy and zarr (v3):

    python3 -m venv dipy-env && dipy-env/bin/pip install dipy zarr
    dipy-env/bin/python make_dipy_example.py OUT_FOLDER [--slab]

`--slab` fits only 24 axial slices around the corpus callosum (a minute
instead of several).
"""
import argparse
import os
import time

import numpy as np
import zarr
from dipy.core.gradients import gradient_table
from dipy.data import get_fnames
from dipy.io.gradients import read_bvals_bvecs
from dipy.io.image import load_nifti
from dipy.reconst.csdeconv import ConstrainedSphericalDeconvModel, auto_response_ssst
from dipy.reconst.dti import TensorModel, lower_triangular
from dipy.segment.mask import median_otsu


def coarsen(data, mask, dtype=np.float32):
    """The mean of each 2 x 2 x 2 box over the voxels in the mask, and the coarser mask."""
    nx, ny, nz = data.shape[:3]
    px, py, pz = (-nx) % 2, (-ny) % 2, (-nz) % 2
    d = np.pad(data * mask[..., None], ((0, px), (0, py), (0, pz), (0, 0)))
    m = np.pad(mask.astype(np.float32), ((0, px), (0, py), (0, pz)))
    sx, sy, sz = d.shape[0] // 2, d.shape[1] // 2, d.shape[2] // 2
    total = d.reshape(sx, 2, sy, 2, sz, 2, -1).sum(axis=(1, 3, 5))
    count = m.reshape(sx, 2, sy, 2, sz, 2).sum(axis=(1, 3, 5))
    out = np.where(count[..., None] > 0, total / np.maximum(count, 1)[..., None], 0)
    return out.astype(dtype), count > 0


def tensor_matrices(t):
    """DIPY's lower_triangular order (Dxx Dxy Dyy Dxz Dyz Dzz) to 3 x 3 matrices."""
    xx, xy, yy, xz, yz, zz = np.moveaxis(t, -1, 0)
    return np.stack([np.stack([xx, xy, xz], -1), np.stack([xy, yy, yz], -1), np.stack([xz, yz, zz], -1)], -2)


def tensor_components(m):
    """3 x 3 matrices to DIPY's lower_triangular order."""
    return np.stack([m[..., 0, 0], m[..., 0, 1], m[..., 1, 1], m[..., 0, 2], m[..., 1, 2], m[..., 2, 2]], -1)


def apply_to_eigenvalues(t, f):
    """V f(L) V^T of each symmetric tensor (DIPY's order)."""
    w, v = np.linalg.eigh(tensor_matrices(t.astype(np.float64)))
    return tensor_components((v * f(w)[..., None, :]) @ np.swapaxes(v, -1, -2))


def coarsen_tensors(data, mask):
    """
    The log-Euclidean mean of each 2 x 2 x 2 box: the mean of the matrix
    logarithms of the box's tensors in the mask that are positive definite,
    exponentiated (zeros where there are none); and the coarser mask.
    """
    w = np.linalg.eigvalsh(tensor_matrices(data.astype(np.float64)))
    valid = mask & (w[..., 0] > 0) & np.isfinite(w).all(axis=-1)
    logs = apply_to_eigenvalues(np.where(valid[..., None], data, 0), lambda w: np.log(np.where(w > 0, w, 1)))
    means, coarse = coarsen(logs, valid, np.float64)
    out = apply_to_eigenvalues(means, np.exp) * coarse[..., None]
    return out.astype(np.float32), coarse


def write(path, data, mask, affine, name, orientations, levels=4, coarsen=coarsen):
    """An OME-Zarr 0.5 pyramid (axes c, z, y, x) of `data` (x, y, z, c), placed by a diagonal affine."""
    voxel = np.abs(np.diag(affine)[:3])
    if not np.allclose(affine[:3, :3], np.diag(np.diag(affine)[:3])):
        raise SystemExit("this writer takes a diagonal affine only")
    # Axes that run backwards in the file are turned round, so OME's scales stay positive.
    origin = affine[:3, 3].copy()
    # Directions are in the voxel frame, so they turn round with their axis.
    kind = orientations.get("type")
    for k in range(3):
        if affine[k, k] < 0:
            data = np.flip(data, axis=k)
            mask = np.flip(mask, axis=k)
            origin[k] += affine[k, k] * (data.shape[k] - 1)
            if kind == "tensor":
                # DIPY's order Dxx Dxy Dyy Dxz Dyz Dzz: the off-diagonal terms with axis k change sign.
                data = data.copy()
                for c in {0: (1, 3), 1: (1, 4), 2: (3, 4)}[k]:
                    data[..., c] = -data[..., c]
            elif kind != "scalar":
                raise SystemExit(f"axis {k} runs backwards in the file: this writer turns directions round for tensors only, not {kind}")
    root = zarr.open_group(path, mode="w", zarr_format=3)
    datasets = []
    for level in range(levels):
        if level > 0:
            data, mask = coarsen(data, mask)
        f = 2**level
        scale = voxel * f
        shift = origin + (f - 1) / 2 * voxel
        arr = np.ascontiguousarray(np.transpose(data, (3, 2, 1, 0)))  # c, z, y, x
        root.create_array(
            str(level),
            data=arr,
            chunks=(arr.shape[0], 32, 32, 32),
            dimension_names=["c", "z", "y", "x"],
            compressors=zarr.codecs.ZstdCodec(level=5),
        )
        datasets.append(
            {
                "path": str(level),
                "coordinateTransformations": [
                    {"type": "scale", "scale": [1.0, *[float(s) for s in scale[::-1]]]},
                    {"type": "translation", "translation": [0.0, *[float(t) for t in shift[::-1]]]},
                ],
            }
        )
    root.attrs.update(
        {
            "ome": {
                "version": "0.5",
                "multiscales": [
                    {
                        "name": name,
                        "axes": [
                            {"name": "c", "type": "channel"},
                            {"name": "z", "type": "space", "unit": "millimeter"},
                            {"name": "y", "type": "space", "unit": "millimeter"},
                            {"name": "x", "type": "space", "unit": "millimeter"},
                        ],
                        "datasets": datasets,
                        "metadata": {"description": "DIPY's Stanford HARDI sample (Rokem et al.), fitted with DIPY"},
                    }
                ],
            },
            "orientations": orientations,
        }
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("out")
    parser.add_argument("--slab", action="store_true", help="fit 24 axial slices only")
    args = parser.parse_args()
    os.makedirs(args.out, exist_ok=True)

    fdwi, fbval, fbvec = get_fnames(name="stanford_hardi")
    data, affine = load_nifti(fdwi)
    bvals, bvecs = read_bvals_bvecs(fbval, fbvec)
    gtab = gradient_table(bvals, bvecs=bvecs)
    if args.slab:
        data = data[:, :, 28:52]
        affine = affine.copy()
        affine[:3, 3] += affine[:3, 2] * 28
    _, mask = median_otsu(data, vol_idx=range(10, 50), median_radius=3, numpass=1, dilate=2)
    print("data", data.shape, "mask voxels", int(mask.sum()), "affine\n", affine)

    started = time.time()
    tensors = TensorModel(gtab).fit(data, mask=mask)
    dti = lower_triangular(tensors.quadratic_form).astype(np.float32)  # Dxx Dxy Dyy Dxz Dyz Dzz
    dti[~mask] = 0
    write(
        os.path.join(args.out, "stanford_hardi_dti.ome.zarr"),
        dti,
        mask,
        affine,
        "Stanford HARDI, DTI",
        {"type": "tensor", "order": "dipy", "frame": "voxel", "software": "DIPY TensorModel"},
        coarsen=coarsen_tensors,
    )
    print(f"tensors in {time.time() - started:.0f} s")

    started = time.time()
    response, ratio = auto_response_ssst(gtab, data, roi_radii=10, fa_thr=0.7)
    csd = ConstrainedSphericalDeconvModel(gtab, response, sh_order_max=8)
    fit = csd.fit(data, mask=mask)
    sh = fit.shm_coeff.astype(np.float32)
    sh[~mask] = 0
    write(
        os.path.join(args.out, "stanford_hardi_csd.ome.zarr"),
        sh,
        mask,
        affine,
        "Stanford HARDI, CSD fODF",
        {"type": "sh", "basis": "descoteaux07", "legacy": True, "lmax": 8, "frame": "voxel", "software": "DIPY ConstrainedSphericalDeconvModel"},
    )
    print(f"CSD in {time.time() - started:.0f} s; response {response}, ratio {ratio:.3f}")


if __name__ == "__main__":
    main()
