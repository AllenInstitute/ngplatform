# Registration

Places a moving layer onto the global (fixed) space by hand (as Freeview's
Transform Volume tool), from landmark pairs, or from a transform file; and
saves the transform, or the moved image as NIfTI or OME-Zarr. After
Freeview (FreeSurfer), the landmark registration of Neuroglancer by Forrest
Collman and Sean Martin (google/neuroglancer pull request 883: pairs
refitted from their raw coordinates after every change) and ngtools by Yaël
Balbastre (transform files, moving-to-fixed RAS mm).

| File | What |
|---|---|
| `manifest.ts` | The Registration tab, Alt+F / Alt+M, the state slice |
| `plugin.ts` | The panel: moving by hand, pairs, fitting and applying, landmark layers, import, saving |
| `manual.ts` | Freeview's translate, rotate, scale and flip, composed as `LayerMRI::DoTransform` does; its slider ranges |
| `fit.ts` | Translation, rigid and similarity (Horn's quaternion method), affine (least squares); residuals |
| `formats.ts` | Plain 4 × 4, ITK / ANTs `.txt`, FreeSurfer `.lta` (RAS to RAS with both volumes' geometry; VOX to VOX read) |
| `volume_io.ts` | Resampling (nearest, trilinear, Catmull-Rom cubic), NIfTI-1 (sform, qform), OME-Zarr 0.5 / 0.6 pyramids, zip |
| `save_worker.ts` | Reads a layer's store (with the volume view's reader) and writes it moved, off the main thread |
| `tests/` | `npm test` runs them |

Neuroglancer keeps a layer transform's linear part as a ratio of physical
lengths and its translation in multiples of the output scales; `physical()`
and `neuroglancer()` in `plugin.ts` convert to and from millimetres.

Checked against FreeSurfer 7: `lta_convert` reads the LTAs written here
(its VOX to VOX and ITK conversions read back to the same matrix), and
`mri_vol2vol --lta` resamples to the same image as Save image (trilinear to
about 1e-6, nearest neighbour identical; FreeSurfer's cubic is a B-spline,
so it differs a little from the Catmull-Rom cubic here).
