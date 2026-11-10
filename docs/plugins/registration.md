# Registration

![Registration: rotating a template by hand, and the saved image overlaid](../images/plugins/registration.png)

**Kind:** tool · **Off by default** (offered when you open two images; or turn it on in the Plugins panel) · the
**Registration** panel in the Tools dock ·
[Source and developer README](https://github.com/AllenInstitute/ngplatform/tree/main/plugins/registration)

Places a moving layer onto the others: by hand, as Freeview's Transform
Volume tool; from landmark pairs; or from a transform file. Then saves the
transform, or the moved image.

Only 3-D layers can be moved. A 2-D section, an image with channels or a
time series is not offered; the panel names the layers it leaves out and
why ("“movie” is 4-D").

## Using it

- **Moving layer:** until you choose one, the image added last (with two
  images or more: a scan opened onto a template opened first, say). The
  first change you make keeps it chosen. The file formats you pick for
  saving are remembered in this browser.
- **By hand:** the Rotate, Translate, Scale and Flip tabs, along X (L-R),
  Y (P-A) and Z (I-S), each a slider and a typed value. The layer moves as
  you drag. Rotate about the volume's centre or the cursor (the views' centre); **Move centre to
  cursor**; **Restore to original**. **Apply to all visible volumes** moves
  every other visible image and segmentation with it (clear it to put them
  back).
- **Straighten** (as Freeview's landmarks): mark four points at the
  views' centre (**#1 here** to **#4 here**), choose where the two lines
  go, then **Straighten**: the line #1 → #2 is turned onto an axis (the AC
  to the PC onto P → A, say) and #3 → #4 as near another as it can, about
  the volume's centre.
- **Landmarks:** ++alt+f++ places a fixed point and ++alt+m++ the matching
  moving point. Fit as translation, rigid, similarity or affine, with the
  residual of each pair; with **Live** the layer moves with each pair,
  otherwise **Apply**. Each pair has a button that goes to it, and a point
  dragged in the *landmarks (fixed)* or *landmarks (moving)* layer moves
  its pair.
- **Warp through the pairs:** a new layer of the moving image bent so each
  fixed point lands exactly on its pair and smoothly between (a thin-plate
  spline; four pairs or more, not all in one plane). It is computed as you
  view it, nothing written, and its link carries the pairs. The moving
  layer stays as it was.
- **Transform files:** save or import FreeSurfer `.lta` (RAS to RAS with
  both volumes' geometry; if a volume's geometry cannot be read, it asks
  before saving without it), ITK / ANTs `.txt`, or a plain 4 × 4 matrix;
  import MNI `.xfm` (FreeSurfer's `talairach.xfm`), ANTs' binary `.mat`
  (`0GenericAffine.mat`), FreeSurfer `register.dat` (tkregister,
  bbregister) and FSL FLIRT `.mat` too. The last two are relative to both
  images' voxel grids: choose the fixed image under *Onto the grid of*
  before importing.
- **Save image:** NIfTI, FreeSurfer `.mgz`/`.mgh` or OME-Zarr, resampled
  (nearest, trilinear or cubic; onto its own grid, its own grid enlarged to
  hold all of the moved image, or another image's) or with the voxels
  unchanged and the new placement in the header. Saved into a file or
  folder you choose (Chrome, Edge), the image is made at full resolution
  however large: NIfTI and FreeSurfer files slab by slab, gzipped as they
  are written, and OME-Zarr block by block, each part reading only the
  source it needs. Downloaded instead, it is made from the finest level
  whose save fits in 512 MB of memory (cubic needs more than trilinear);
  one that would need more than 2 GB is refused, saying what to do
  instead. **Cancel** stops a save and removes the OME-Zarr folder it had
  started.

Checked against FreeSurfer 7: `lta_convert` reads the transforms, and
`mri_vol2vol` resamples to the same image.

## Notes from users

*Add your tips, workflows and problems here (edit this page on GitHub).*
