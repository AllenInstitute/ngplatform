# Registration

![Registration: rotating a template by hand, and the saved image overlaid](../images/plugins/registration.png)

**Kind:** tool · **Off by default** (switch it on in the Plugins tab) · the
**Registration** tab ·
[Source and developer README](https://github.com/AllenInstitute/ngplatform/tree/main/plugins/registration)

Places a moving layer onto the others: by hand, as Freeview's Transform
Volume tool; from landmark pairs; or from a transform file. Then saves the
transform, or the moved image.

## Using it

- **By hand:** the Rotate, Translate, Scale and Flip tabs, along X (L-R),
  Y (P-A) and Z (I-S), each a slider and a typed value. The layer moves as
  you drag. Rotate about the volume's centre or the cursor; **Move centre to
  cursor**; **Restore to original**.
- **Landmarks:** ++alt+f++ places a fixed point and ++alt+m++ the matching
  moving point. Fit as translation, rigid, similarity or affine, with the
  residual of each pair.
- **Transform files:** save or import FreeSurfer `.lta` (RAS to RAS with
  both volumes' geometry), ITK / ANTs `.txt`, or a plain 4 × 4 matrix.
- **Save image:** NIfTI or OME-Zarr, resampled (nearest, trilinear or cubic;
  onto its own grid or another image's) or with the voxels unchanged and the
  new placement in the header.

Checked against FreeSurfer 7: `lta_convert` reads the transforms, and
`mri_vol2vol` resamples to the same image.

## Notes from users

*Add your tips, workflows and problems here (edit this page on GitHub).*
