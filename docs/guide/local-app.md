# ngplatform on your computer

ngplatform can run as an app on your own computer, started from a terminal
as FreeView is:

```
pip install ngplatform                 # the app and its runner
pip install "ngplatform[gpu]"          # …with the CUDA renderer (NVIDIA GPU)

ngplatform                             # the app, in a window of its own
ngplatform t1.nii.gz brain.ome.zarr    # …with these opened as layers
```

The app opens in a window of its own: Chrome, Chromium or Edge in app
mode, with no tabs or address bar. Closing the window stops it. If none of
those browsers is installed, the app opens in your default browser instead,
and Ctrl-C in the terminal stops it.

Until the package is published, install it from a wheel: the Deploy
workflow builds one with each deploy (its `ngplatform-wheel-…` artifact),
or build it from a checkout with `npm run package:local`, which puts it in
`dist-wheel/`.

## What runs where

`ngplatform` starts the [runner](local-jobs.md) on this computer, at
`http://127.0.0.1:8766`. The runner serves the app's files beside its own
API, so the app and the runner share one address. The app pairs with it
without asking, and **Settings › Compute** shows it as This computer. Jobs,
opening large files and the render service work as with a runner started
by hand.

- **Files named on the command line** open as layers. Their folders become
  the runner's roots: the app may open files under them, and nothing else.
  `--root FOLDER` adds another root. With no files and no `--root`, the
  current folder is the root.
- **The CUDA renderer** (`ngplatform[gpu]`, NVIDIA GPUs) starts beside the
  runner when it is installed. Anatomical rendering can then path-trace
  large images, and make stills, movies and splats, on this computer.
  `--no-gpu` leaves it off.
- **Settings** (the app's own, in the window) are kept between runs in
  `~/.ngplatform/browser`. They are tied to the port. If 8766 is taken,
  for instance because `ngplatform` is already running, another port is
  used and that window starts with the default settings.

## Kept level with the site

The app comes in the package, built from the same commit as the release.
After that it follows the deployed site
(`https://alleninstitute.github.io/ngplatform/`):

- **At each start**, `ngplatform` asks the site which build it serves
  (its `build.json`). When the site's build is newer than the one here, it
  is downloaded in the background into `~/.ngplatform/app/`, and the next
  start uses it. Every file is checked against the site's `files.json`
  (size and SHA-256) before the build is used. The two newest downloads
  are kept.
- **`ngplatform update`** does the same now, and says what it did.
- **`--offline`** skips the check. Nothing is sent but the requests for
  those files.
- **`--channel dev`** follows the development build (`/dev/`) instead.

A deployed app may come to need a newer runner than the one installed: the
runner's API version is part of each build. Such a build is not
downloaded. `ngplatform update` says so, and `pip install -U ngplatform`
brings the runner level.

`ngplatform --version` prints the package's version and the app it would
serve: its version, commit, build date, and whether it came in the package
or was downloaded.

## Options

| Option | What it does |
|---|---|
| `FILE …` | Files or folders to open as layers |
| `update` | Brings the app level with the deployed site now |
| `--root FOLDER` | Another folder the app may open files under (repeat for more) |
| `--port N` | The port on 127.0.0.1 (default 8766; keep it the same to keep the app's settings) |
| `--no-window` | Serves the app and prints its address, for example for an SSH tunnel |
| `--browser PATH` | The Chrome, Chromium or Edge to open the window with |
| `--offline` | Does not check the deployed site |
| `--channel stable\|dev` | Which deployed app to follow (default stable) |
| `--no-gpu` | Does not start the CUDA renderer |
| `--version` | Prints the versions |

## A known problem

Path-tracing large meshes in the window can stall a GPU that also drives
your display: on 2026-11-18 it froze a workstation, with the NVIDIA driver
logging Xid 109. Until that is fixed, path-trace large meshes with the
CUDA renderer (`ngplatform[gpu]`), not in the window
([the plan](https://github.com/AllenInstitute/ngplatform/blob/main/plans/browser-geometry.md) tracks it).

## Not yet

These come in later steps of [the plan](https://github.com/AllenInstitute/ngplatform/blob/main/plans/local-app.md):

- **Fully offline:** Pyodide, onnxruntime-web and the Draco decoder still
  load from a CDN when a feature needs them.
- **FreeView-style layer options** (`t1.nii.gz:colormap=heat`).
- **MGH and MGZ volumes.**
- **A desktop icon.**
