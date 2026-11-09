# Anatomical rendering

![S-21-46 (HiP-CT, 100 µm) path-traced on a workstation's GPU](../../docs/images/plugins/anatomical-rendering.png)

Path-traced views of an OME-Zarr image in Neuroglancer's 3-D view. The
rendering runs in the runner's render service (`runner/ngplatform_render`,
CUDA through CuPy) on this computer or on one reached over SSH, or in the
page with WebGPU (`local/`). The user page is
[docs/plugins/anatomical-rendering.md](../../docs/plugins/anatomical-rendering.md).

| File | What |
|---|---|
| `manifest.ts` | The Anatomical tool's panel, the toggle command and the state slice |
| `plugin.ts` | The panel (Render switch and status; Remote, Rendering, Lighting, Crops and Output sections); the session with the service for the chosen image (and segmentation); views sent from Neuroglancer's frames (none while the camera moves, unless it goes far from the picture's: then half size; the full size 200 ms after it stops); the frame loop; keyframes, movie previews and movies as jobs |
| `client.ts` | The service's HTTP API: through a paired host (`ctx.hosts`, `/svc/render/…`) or at an address |
| `view.ts` | Pure functions of a frame: physical mm to display coordinates, cut planes, the light's direction, a layer's OME-Zarr source |
| `draw.ts` | The frame in the 3-D view (`draw3d`): colour, and depth where each ray first meets tissue, so other layers are hidden behind it |
| `local/pathtrace.wgsl` | The path tracer in WGSL: the same method and parameters as the CUDA kernels |
| `local/local.ts` | WebGPU in the page: one level of the image (through the volume view's reader), brick bounds, presets, the progressive loop |

The parameter block both renderers read is laid out once, in
`runner/ngplatform_render/params.json`; the presets are
`runner/ngplatform_render/presets/*.json`, read by both.

## The service

`python -m ngplatform_render.server` (started by the runner with
`--service render=…`), 127.0.0.1 only, the service token from the runner:

| Request | What |
|---|---|
| `GET /info` | Its GPU, presets, light maps, whether it can fit splats, and whether it has `ffmpeg` (movies need it) |
| `GET /presets` | The presets in full |
| `POST /sessions` `{volume: {url, budget?, level?}, labels?: {url}}` | Loads the image (and labels) and puts it on the GPU; `GET /sessions/<id>` says how far it is, then the level and its placement |
| `PUT /sessions/<id>/view` | A view: `inv_view_projection` (column-major), `width`, `height`, `scale`, `world_from_physical`, `unit_mm`, `preset`, `overrides`, `light`, `clips`, `labels`, `background`, `max_samples`, `aperture`, `focus`, `orbit_center`. Sides are kept to 8–8192 pixels and `max_samples` to 1–4096 |
| `GET /sessions/<id>/frame?after=N` | The next frame after N (long poll): WebP with alpha, `X-Frame`, `X-Samples`, `X-Version`, `X-Width`, `X-Height`; 410 with the error once the session has failed (out of GPU memory: its memory is let go) |
| `GET /sessions/<id>/depth` | The view's depth (GL 0..1, float16, zlib) |
| `POST /sessions/<id>/stills` `{view, width, height, samples, background?, name?}` | A still as a job: `GET /stills/<id>` for progress, `DELETE` to cancel, `/stills/<id>/file` for the PNG. At most 8192 × 8192 pixels, 4096 samples, and width × height × samples within 8192² × 256 |
| `POST /sessions/<id>/movies` `{keyframes, fps, width, height, samples, crf?}` | A movie (a preview is one at about 384 px, 8 samples, 12 fps); `GET /movies/<id>` for progress, `DELETE` to cancel (ffmpeg too), `/movies/<id>/file` for the MP4. Checked before it starts: fps 1–120, sides made even for H.264, frames and pixels within limits, ffmpeg found. Its passes go to the GPU one at a time (`Renderer.step_beside`), so the live view's wait behind it is one pass, not the frame's |

## Tests

`npm test` runs `tests/view.test.ts`; the service's are
`runner/tests/test_render.py` (levels, made levels, presets, keyframes, and,
with a CUDA GPU, the renderer and the service).

## While the camera moves

A frame comes with the camera it was rendered from and each pixel's
distance to the tissue, so it is drawn as a surface in space
(`draw.ts`, a vertex a pixel) with the camera now: while the view turns,
pans or zooms, the picture stays where the tissue is and moves with it,
and nothing new is rendered. When the camera has been still for 200 ms
the full-size view is rendered again. A camera that goes far from the
picture's (`farFrom`: turned past 20°, twice as near or far, or the
position near the picture's edge) gets quick half-size pictures while it
moves, each placed in space too. "Moving" is Neuroglancer's drag or wheel,
or the camera changing frame after frame (the 3-D view's momentum, keys
held). A frame is never drawn flat (stuck to the screen) in place of one
placed in space: one that comes before the answer to its view waits for
it, and one without its distances fetches them; only a host that gives no
distances is drawn flat. Triangles spanning a jump in distance of more
than 8 % are left out while the camera is away from the picture's (a
brief gap at a fold's edge rather than a stretched skin), and kept at the
picture's own camera. With `localStorage["ngplatform.debug"]` set,
`window.anatomicalRendering.drawer.stats` counts draws placed in space,
flat, and flat while moving.
