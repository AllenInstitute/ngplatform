# ngplatform as a local app

`pip install ngplatform`, then `ngplatform` in a terminal, as FreeView is
started: a window opens on this computer with the data named on the
command line, nothing sent to or loaded from the internet, and the
rendering done by this computer's GPU. Asked for on 2026-11-18.

## What the user does

```
pip install "ngplatform[gpu]"          # the app, the runner, the CUDA renderer
ngplatform                              # an empty workspace
ngplatform t1.nii.gz aseg.nii.gz:seg    # FreeView-style: files as layers
ngplatform ~/data/brain.ome.zarr tracts.trk
ngplatform --workspace study.json       # a saved workspace
```

A window opens (an app window, no browser tabs or address bar). Closing it
stops the app. Files named on the command line open as layers. Their
folders become the runner's roots, so the app may read them and the files
next to them, and nothing else. Settings › Compute shows "This computer",
already paired. Path-traced rendering, movies, splats and the runner's jobs
work as on a render computer, on this one.

`pip install ngplatform` without `[gpu]` installs the app and the runner
alone: the viewer, browser rendering and jobs, no CUDA renderer.

## Most of it exists already

| Part | Today | For the local app |
|---|---|---|
| The app | A static site (`dist/`, 48 MB), served from GitHub Pages | The same build, inside the wheel, served by the runner |
| The runner | `pip install ./runner` (`ngplatform-runner`, standard library only); serves files under its roots, runs jobs, starts services (`--service NAME=COMMAND`, reached at `/svc/NAME/`) | Also serves the app, from the same address, so the app and the runner share one origin: no pairing, no CORS |
| The CUDA renderer | `ngplatform_render`, the runner's `render` extra (CuPy, zarr 3, DracoPy) | Started as a service by `ngplatform` when the extra is installed and a CUDA GPU is found |
| Local files | Served by the runner under its roots; NIfTI read natively (`src/virtual/images/nifti.ts`), `.trk` by the runner's jobs | Named on the command line, they become layers |
| Browser rendering | WebGL2 (Neuroglancer, the live object) and WebGPU (the local path tracer) on this computer's GPU | Unchanged, in the app window |

So the work is mainly packaging, a launcher and an offline build. None of
it is new rendering.

## Design

### One process, one origin

`ngplatform` starts the runner on a free port on 127.0.0.1 with a fresh
token, then opens the app at that address. The runner serves `dist/` at
`/` and its API where it does now. The app, seeing it is served by a
runner (a `/runner.json` next to `index.html`), pairs with it at once
under the token the page was given. The token is passed in the URL
fragment, which the browser never sends, so other local processes cannot
use the runner without it.

### The window

Its order of preference:

1. **Chrome or Chromium in app mode** (`--app=http://127.0.0.1:PORT/…`,
   its own `--user-data-dir` under `~/.ngplatform/browser`): a plain
   window, the GPU flags the app needs (WebGPU on Linux:
   `--enable-unsafe-webgpu --enable-features=Vulkan`), and closed when
   the app stops. This is the best WebGL2 and WebGPU on every platform.
2. **Edge** in app mode on Windows (Chromium too).
3. **The default browser**, in a tab, when neither is found. It says so in
   the terminal, with the WebGPU caveat.

A packaged Chromium (Electron, or Qt WebEngine through PySide6) was
considered and left out: it adds 100–200 MB to the install and a second
release cycle. The pywebview library was also left out, since its Linux
backend, WebKitGTK, has no WebGPU. These can be added later if a system
browser proves unreliable.

### Fully offline

The build loads three things from a CDN at run time. Each goes into
`dist/` instead, behind a build flag (`OFFLINE=1`), so the hosted site
keeps the CDN:

| Fetched now | From | For |
|---|---|---|
| Draco decoder | `cdn.jsdelivr.net/gh/google/draco` | Precomputed meshes |
| onnxruntime-web | `cdn.jsdelivr.net/npm/onnxruntime-web` | The ML plugins' models |
| Pyodide | `cdn.jsdelivr.net/pyodide/v0.28.3` | Python in the page |

Pyodide is the large one, at about 30 MB for its core. It could become an
optional download the first time it is used, cached under
`~/.ngplatform`. Fonts and icons are already bundled. Remote datasets
(MICrONS, GCS stores) still work when online; they are data, not the
app's own files.

### The GPU

Two renderers use the GPU, and the app picks between them as it does now
in Settings › Compute:

- **In the window (WebGL2 and WebGPU).** Neuroglancer's 2-D and 3-D views
  and the browser path tracer. This needs no CUDA and works on any GPU.
- **The CUDA renderer** (the `[gpu]` extra, NVIDIA only). Path tracing
  of large images (whole HiP-CT organs, out-of-core detail), movies and
  splats, as a render computer does, at local speed: the app reaches it
  through the runner at `/svc/render/`. With both on one computer, the
  app should prefer it for the path-traced picture of large scenes.

**Before this ships, the browser path tracer must not hang the GPU.** On
2026-11-18, on an RTX A2000 that also drives the display, path-tracing
MICrONS cells in the browser ran single GPU passes for several seconds.
The NVIDIA driver reset the GPU (Xid 109, CTX SWITCH TIMEOUT), losing the
page's context and freezing the desktop.
[browser-geometry.md](browser-geometry.md) tracks the fix. Measured so
far: the surface traversal alone is fast (512² rays over 500,000
triangles in about 15 ms); one path-tracing pass of the live object costs
about a thousand times more than its traversal, even for a 5,000-triangle
scene. A local app makes this more pressing, because it is always on the
GPU that drives the screen.

### The command line

```
ngplatform [FILE[:OPTIONS] ...] [--workspace FILE] [--root DIR ...]
           [--port N] [--browser PATH] [--no-gpu] [--no-window]
```

- `FILE`: NIfTI (`.nii`, `.nii.gz`), MGH and MGZ (FreeSurfer; a reader
  to add), OME-Zarr, Zarr Vectors, precomputed, `.trk`, `.tck`, meshes
  (`.ply`, `.obj`, `.stl`, FreeSurfer surfaces: readers to check). The
  type comes from the extension, or the contents where that is ambiguous.
- `:OPTIONS` (FreeView's spelling where there is one): `:seg` (or
  `:colormap=lut`) for a segmentation, `:colormap=heat`, `:opacity=0.5`,
  `:name=…`, `:visible=0`.
- `--no-window`: serve only and print the address, for a remote machine
  reached by SSH tunnel. The runner already handles tunnels
  (`--public-url`).

The command line becomes a workspace (the app's own JSON), so anything
started this way can be saved and reopened with `--workspace`.

### Versions and updates

The wheel carries the app built from the same commit as the runner, so
the two never mismatch. `ngplatform --version` prints both. Updates come
through `pip install -U ngplatform`, not live as on the hosted site.
Links shared from a local app point to the hosted site (Share menu),
with a warning when the scene's layers are local files the recipient
cannot reach.

## Work plan

| Step | What | Size |
|---|---|---|
| 0 | **The browser path tracer stops hanging the GPU** (the passes measured and kept short; see [browser-geometry.md](browser-geometry.md)). Needed first: a local app always runs on the display's GPU | 2–4 days |
| 1 | **A wheel with the app inside**: a build step copies `dist/` into the runner package; the runner serves it at `/` (cached, with correct types, `index.html` for the root); same-origin pairing (`/runner.json`); one package named `ngplatform` (the runner renamed or re-exported); extras `gpu` (render), `jobs`, `splat` | 2 days |
| 2 | **The `ngplatform` command**: start the runner and the CUDA service when available, find Chrome, Chromium or Edge, open the app window with its own profile and GPU flags, stop everything when the window closes (or on Ctrl-C) | 2 days |
| 3 | **Offline build**: Draco and onnxruntime-web vendored; Pyodide fetched once and cached; a test that the app starts with the network off (Playwright, offline mode) | 2 days |
| 4 | **Files on the command line**: paths to layers in a workspace, FreeView-style options, roots from the files' folders; an MGH/MGZ reader (FreeSurfer volumes) | 3 days |
| 5 | **CI and release**: wheels for Linux, macOS and Windows (pure Python plus the built app, so one universal wheel); a smoke test of `pip install` then `ngplatform --no-window` in CI; `docs/guide/local-app.md` | 2 days |
| 6 | **Polish**: an icon and window title; a desktop entry (`ngplatform --install-desktop` on Linux); a check of the GPU at start that says when WebGPU or CUDA is missing and what still works | 1–2 days |

About three weeks in all, step 0 the least certain.

## Progress

**2026-11-18, steps 1 and 2 begun (step 0 not done):**

- **Serving:** the runner serves an app folder at `/app/` (`RunnerServer(app_dir=…)`: no token, nothing outside the folder or hidden, assets cached as immutable), and reports `runnerApi` in `/status`.
- **The command:** `ngplatform_local` (`ngplatform`, `ngplatform update`, `--no-window`, `--offline`, `--channel`, `--root`, `--browser`, `--no-gpu`, `--version`). It starts the runner (state in `~/.ngplatform/runner`, port 8766 so the browser's storage for the app stays), adds the CUDA render service when `ngplatform_render` and CuPy import, opens Chrome, Chromium or Edge with `--app` and a profile in `~/.ngplatform/browser`, and stops everything when the window closes. A browser that hands the page to one already open is waited for with Ctrl-C.
- **Pairing and files:** the link carries `runner`, `token` and an `open` for each file. The app pairs without asking when the runner is the page's own origin (`servedBy`), then opens each file through `openRunnerPath`.
- **Kept level with the site:** each build writes `build.json` (BuildInfo and `runnerApi`) and `files.json` (each file's size and SHA-256, maps left out). `app_source.choose` serves the newest build here (bundled, or downloaded into `~/.ngplatform/app/<commit>/`) that this runner meets. `app_source.update` downloads a newer deployed build, checking every file, keeping two. At each start this runs in the background unless `--offline`. A deployed build needing a newer `RUNNER_API` is not taken: the user is told to upgrade.
- **Packaging:** `runner/pyproject.toml` is now the `ngplatform` package, versioned from `ngplatform_runner.__version__` (kept equal to package.json's). `npm run build:local` copies `dist/` into `ngplatform_local/app/`; `npm run package:local` makes a universal wheel (4.9 MB). The Deploy workflow builds the wheel from the deployed build, as an artifact; publishing to PyPI waits on the name.
- **Checked:** `runner/tests/test_local.py`: serving, updating from a site served from a folder (newer build taken, a changed file or a path outside the app refused, a build needing a newer runner left, two kept), and `ngplatform --no-window` end to end. The wheel was installed in a fresh venv: `ngplatform --version`, `--no-window` serving the bundled app, and `ngplatform update` against the live site. That last check gave 404, because the live site was deployed before `build.json` existed; it works from the next deploy. No window was opened in testing (the workstation's GPU drives its display).

## Risks

- **The GPU that drives the display.** A long GPU pass freezes the whole
  desktop, not one tab (step 0). The CUDA renderer runs compute kernels
  on the same GPU. Its passes must also stay short: the golden test ran
  them without a reset, but large scenes were not checked.
- **CuPy and CUDA versions.** `cupy-cuda12x` needs a CUDA 12 driver.
  Users with CUDA 11, or none, get the app without the CUDA renderer, and
  the app must say so plainly, not fail.
- **Chrome not installed.** The fallback is a browser tab, where WebGPU
  may be off (Firefox on Linux). Browser rendering then uses WebGL2 only.
- **Large local files.** The runner serves byte ranges, so large NIfTI
  and Zarr files are read in parts. A `.nii.gz` cannot be range-read
  inside its compression, so a large one is read whole. Today's browser
  limit applies (`src/virtual/images/nifti.ts`).
- **Two copies of the truth.** The hosted site and the wheel must come
  from the same commit at release. Step 5 ties them together.

## Open questions

- **The package name `ngplatform` on PyPI:** is it free, and does the
  Allen Institute want it published there or on its own index?
- **Windows and macOS:** must the first version support them, or Linux
  only (where the CUDA renderer is tested)?
- **The hosted site's remote features** (signing in, shared workspaces,
  collections in the cloud): on in the local app when online, or off?
- **Electron or a bundled Chromium later**, for a window that does not
  depend on the installed browser?
