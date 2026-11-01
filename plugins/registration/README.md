# Registration

Places a moving layer onto the global (fixed) space from landmark pairs, and
reads and writes affine transform files. After the landmark registration of
Neuroglancer by Forrest Collman and Sean Martin (google/neuroglancer pull
request 883: pairs refitted from their raw coordinates after every change)
and ngtools by Yaël Balbastre (transform files, moving-to-fixed RAS mm).

| File | What |
|---|---|
| `manifest.ts` | The Registration tab, Alt+F / Alt+M, the state slice |
| `plugin.ts` | Pairs, fitting and applying, landmark layers, import and export |
| `fit.ts` | Translation, rigid and similarity (Horn's quaternion method), affine (least squares); residuals |
| `formats.ts` | Plain 4 × 4, ITK / ANTs `.txt`, FreeSurfer `.lta` (RAS to RAS) |
| `tests/` | `npm test` runs them |

Neuroglancer keeps a layer transform's linear part as a ratio of physical
lengths and its translation in multiples of the output scales; `physical()`
and `neuroglancer()` in `plugin.ts` convert to and from millimetres.
