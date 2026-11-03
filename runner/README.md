# ngplatform runner

A small HTTP server on your own computer that runs long Python jobs for
ngplatform: converting a tractogram to Zarr Vectors, filtering a whole
tractogram by regions into a new `.trk` or store, density maps. The web app
starts the jobs, shows each one's process id, progress and log, cancels
them, and opens their results as layers. It also serves files under its
folders to the viewer, so a tractogram too large for the browser can be
opened through it.

The user guide's page is [docs/guide/local-jobs.md](../docs/guide/local-jobs.md).

## Starting it

The runner needs only Python's standard library (3.10 or later). Its jobs
need [zarr-vectors-tools](https://github.com/AllenInstitute/zarr-vectors-tools)
and numpy, in the Python they run with: by default the runner's own, so
start it in that environment.

```
cd ngplatform/runner
python -m ngplatform_runner --root ~/data
```

or install it (`pip install ./runner`) and run `ngplatform-runner --root ~/data`.

It prints its address, a pairing token and a link that pairs the app with
it:

```
ngplatform runner 0.1.0 listening on http://127.0.0.1:8765 (PID 41213)
  roots:  /home/me/data
  jobs:   /home/me/.conda/envs/zarr-vectors/bin/python (zarr-vectors-tools 0.2.0)
  ...
Pair the app with it: open this link (it pairs this browser once)
  https://alleninstitute.github.io/ngplatform/#runner=http%3A%2F%2F127.0.0.1%3A8765&token=…
```

| Option | What |
|---|---|
| `--root FOLDER` | A folder jobs may read and write and the app may list. Required; repeat for more. |
| `--port N` | The port on 127.0.0.1 (default 8765; 0 picks a free one). |
| `--state-dir DIR` | Where the job list, logs and token are kept (default `~/.ngplatform-runner`). |
| `--python PATH` | The Python jobs run with (default: the runner's). It needs zarr-vectors-tools. |
| `--max-jobs N` | Jobs run at once (default 2); more wait in a queue. Serving a file does not count. |
| `--allow-origin URL` | Another site the app is served from. ngplatform's site and `localhost` are allowed already. |
| `--app URL` | The app's address, for the pairing link. |
| `--new-token` | A new pairing token; browsers paired before must pair again. |

Ctrl-C stops the runner. Jobs still running carry on; when the runner
starts again it shows them, still running or finished. Files it served
through a process of their own (see `/serve`) stop with it and are served
again when it starts.

## Safety

- It listens on **127.0.0.1 only**: nothing on the network can reach it.
- Every API request needs the **pairing token** (`Authorization: Bearer
  <token>`), which is printed at start and kept in `<state-dir>/token`
  (readable by you only). A request from a web page must also come from an
  **allowed origin** (ngplatform's site, `http://localhost:*`,
  `http://127.0.0.1:*`, and any `--allow-origin`), and the `Host` header must
  name this computer, which stops DNS-rebinding pages.
- Jobs are of **known kinds only** (below), with checked arguments. There is
  no way to run a shell command or arbitrary code through it.
- Every path is resolved (links followed, `..` removed) and must be under a
  **root**: inputs to read, outputs to write, folders to list, files to
  serve. An output that exists is refused unless the request says
  `overwrite`.
- Files it serves to the viewer (`/stores/<id>/…`) do not need the token,
  since Neuroglancer cannot send one. Each served path gets a random id of
  128 bits, which only the app that asked for it learns. Stop serving one
  with `DELETE /serve/<id>` (in the app: Stop, in the Jobs tab).

## Jobs

Each job is a process of its own: `python -m ngplatform_runner.child`, which
runs the kind's module in that same process (so the PID shown is the work's
own). It is started in a new process group, and cancelling it ends the group
(SIGTERM, then SIGKILL after 5 s), including processes it started. Its
output goes to `<state-dir>/jobs/<id>/log.txt`, from which the runner reads
progress; when it ends it writes `result.json` with its exit code. The job
list is `<state-dir>/state.json`.

| Kind | Arguments | Writes |
|---|---|---|
| `convert` | `input` (.trk, .tck, .trx), `output` (a `.zarr` folder to make), `levels` (coarser levels, each half the streamlines of the one below; default 3), `chunk_shape` (mm; default chosen from a .trk, 32 mm otherwise), `overwrite` | A Zarr Vectors store (`zvtools convert`) |
| `filter` | `input` (a tractogram or a Zarr Vectors store), `filter` (a zvf-predicate document), and one or more of `trk`, `store` (with `levels`), `density` (with `voxel`, mm); `name`, `overwrite` | The streamlines that pass, as a `.trk`, a store, a density map (NIfTI) |
| `density` | `input`, `filter`, `output` (.nii or .nii.gz), `voxel` | A density map |

A `filter` document is zarr-vectors-tools' filter tree
(`zarr_vectors_tools.filtering.predicates`): regions (sphere, box, slab,
disk, mask) tested by path, either end or both ends, attribute comparisons,
and `and`, `or`, `not`. It is evaluated with zarr-vectors-tools' reference
engine (`filtering.oracle`), a batch of streamlines at a time. Coordinates
are those the viewer shows the input in: RAS+ millimetres for a tractogram
file (computed as zarr-vectors-tools' virtual stores and the browser's own
reader compute them), the stored positions for a store.

- A `.trk` input is memory-mapped and read 50 000 streamlines at a time, so
  its size is limited by disk, not memory. The streamlines that pass are
  copied to the new `.trk` unchanged (header, scalars and properties kept).
- A `.tck` or `.trx` input is read by zarr-vectors-tools' readers; the
  `.trk` written is in RAS+ mm.
- A store input is read whole (level 0) into memory, then written with
  zarr-vectors-tools' `export_trk`.
- A `store` output is the passing streamlines converted with `zvtools
  convert`. A `density` output counts each passing streamline once in every
  voxel it passes through, on a grid around them.

Progress comes from lines `[progress] <0..1> <message>` that the runner's
own tasks print, and from `zvtools convert`'s phases.

## API

JSON over HTTP on `http://127.0.0.1:<port>`; every request but preflights
and `/stores/` needs the token.

| Request | Answer |
|---|---|
| `GET /status` | Version, PID, roots, the jobs' Python and its zarr-vectors-tools version, the job kinds |
| `GET /jobs` | `{jobs: [...]}`, newest first: `id, kind, title, args, pid, state` (queued, running, done, failed, cancelled), `created, started, finished` (seconds since 1970), `progress` (0–1 or null), `message, outputs` (`[{path, type}]`), `returncode` |
| `POST /jobs` `{kind, args}` | The job, started or queued (201). An `input` that is a URL this runner serves is read as its file. |
| `GET /jobs/<id>` | One job |
| `GET /jobs/<id>/log?tail=N` | The last N bytes of its log |
| `POST /jobs/<id>/cancel` | Ends it (and what it started) |
| `DELETE /jobs/<id>` | Takes a finished job off the list (its files stay) |
| `GET /files?path=` | A folder's entries under a root (`type` file, dir or store); no path: the roots |
| `GET /find?name=` | Files of that name under the roots (a bounded search) |
| `POST /serve` `{path}` | Serves a Zarr store, a NIfTI image, or a file `zvtools virtual serve` reads (tractograms, meshes, SWC, point tables) by a process of its own: `{id, url, source, ready}`. `source` is the layer source. |
| `GET /serve`, `DELETE /serve/<id>` | What is served; stop serving one |
| `GET /resolve?url=` | The path behind a URL this runner serves |
| `GET /stores/<id>/…` | The served files, with byte ranges and folder listings (no token) |

Preflights (`OPTIONS`) answer CORS for the allowed origins and
`Access-Control-Allow-Private-Network: true` when Chrome asks (Private
Network Access: an https page calling http://127.0.0.1).

## Tests

```
cd runner/tests
python -m unittest -v
```

They start runners on free ports with temporary folders. The tests of real
jobs (filtering, converting, serving a `.trk`) run when zarr-vectors-tools
can be imported, and use the tractograms in
`plugins/zarr-vectors/testdata/tractograms`.
