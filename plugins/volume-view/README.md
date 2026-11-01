# Volume view

In place of Neuroglancer's 3-D panel: a solid brain ray-marched in WebGL2
from an OME-Zarr pyramid, with the octant facing the camera cut away at the
current position, sections from finer levels on the cut faces, and the
visible track groups drawn through the cut. Volumes: BigBrain (in MNI) or
the MNI ICBM152 2009a template, or any uint8 OME-Zarr 0.4 to 0.6 (zarr v3).

| File | What |
|---|---|
| `manifest.ts` | The Volume tab, commands and state slice |
| `plugin.ts` | The tab, the view (mounted with `ctx.ui.view`), camera, presets |
| `renderer.ts` | WebGL2: the solid, the cut, the sections, the tracts |
| `ome.ts` | OME-Zarr multiscales to voxel-to-RAS transforms |
| `volume_reader.ts`, `volume_client.ts`, `volume_worker.ts` | Reading levels and sections in a worker |
| `tools/mni_template_to_omezarr.py` | How the hosted MNI template was made |
| `tests/` | `npm test` runs them |
