# ngplatform runner

A small HTTP server on your own computer that runs long Python jobs for
ngplatform: converting a tractogram to Zarr Vectors, filtering a whole
tractogram by regions into a new `.trk` or store, density maps. The web app
starts the jobs, shows each one's process id, progress and log, cancels
them, and opens their results as layers. It also serves files under its
folders to the viewer, so a tractogram too large for the browser can be
opened through it.

In the app, **Settings › Compute** pairs it and shows what each computer
has (**This computer**, and others reached over SSH); the **Activity** dock
at the bottom lists each computer's jobs, with **Convert a tractogram…** and
**Open a file…**.

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
| `--public-url URL` | The address the browser reaches the runner at through an SSH tunnel, such as `http://localhost:7000`. The runner then answers requests addressed to it too, prints it, and hands back addresses (of served files) made from it. See [below](#using-a-gpu-on-another-machine-over-ssh). |
| `--service NAME=COMMAND` | A program to run beside the runner, which the app reaches at `/svc/NAME/`. Repeat for more. See [Services](#services). |
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
  name this computer at the runner's port (or the `--public-url`), which
  stops DNS-rebinding pages.
- Jobs are of **known kinds only** (below), with checked arguments. There is
  no way to run a shell command or arbitrary code through it. Services run
  only the commands given with `--service` when the runner was started.
- Every path is resolved (links followed, `..` removed) and must be under a
  **root**: inputs to read, outputs to write, folders to list, files to
  serve. An output that exists is refused unless the request says
  `overwrite`.
- Files it serves to the viewer (`/stores/<id>/…`) do not need the token,
  since Neuroglancer cannot send one. Each served path gets a random id of
  128 bits, which only the app that asked for it learns. Stop serving one
  with `DELETE /serve/<id>` (in the app: **Stop**, in the Activity dock).

## Jobs

Each job is a process of its own: `python -m ngplatform_runner.child`, which
runs the kind's module in that same process (so the PID shown is the work's
own). It is started in a new process group, and cancelling it ends the group
(SIGTERM, then SIGKILL after 5 s), including processes it started. A
filter job that is cancelled deletes the `.trk` it was writing. Its
output goes to `<state-dir>/jobs/<id>/log.txt`, from which the runner reads
progress; when it ends it writes `result.json` with its exit code. The job
list is `<state-dir>/state.json`.

| Kind | Arguments | Writes |
|---|---|---|
| `convert` | `input` (.trk, .tck, .trx), `output` (a `.zarr` folder to make), `levels` (coarser levels, each half the streamlines of the one below; default 3), `chunk_shape` (mm; default chosen from a .trk, 32 mm otherwise), `ras` (default true: a .trk's points stored in RAS+ mm, `--apply-affine`, so the store lines up with the file as the viewer shows it), `overwrite` | A Zarr Vectors store (`zvtools convert`) |
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
  convert`, in the input's coordinates (RAS+ mm for a file, with
  `--apply-affine`; a store's own space for a store), so it lines up with
  the input in the viewer. A `density` output counts each passing streamline once in every
  voxel it passes through, on a grid around them.

Progress comes from lines `[progress] <0..1> <message>` that the runner's
own tasks print, and from `zvtools convert`'s phases.

## API

JSON over HTTP on `http://127.0.0.1:<port>`; every request but preflights
and `/stores/` needs the token.

| Request | Answer |
|---|---|
| `GET /status`, `GET /info` | Version, PID, `address` (the one this request reached), `publicUrl`, roots, the jobs' Python and its zarr-vectors-tools version, the job kinds; the computer's `hostname` and `platform`; `gpus` (`[{index, name, memoryTotal, memoryUsed, memoryFree, busId, ok, problem?}]`, memory in MiB, from `nvidia-smi`, at most 10 s old; empty without it; a card that "requires reset" or does not answer has `ok: false`); `services` (`{name: {ready, error, pid}}`) |
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
| `GET, POST, PUT, DELETE /svc/<name>/<rest>` | Passed to the service (below) as `/<rest>?<query>`; its answer streamed back |

Preflights (`OPTIONS`) answer CORS for the allowed origins and
`Access-Control-Allow-Private-Network: true` when Chrome asks (Private
Network Access: an https page calling http://127.0.0.1).

## Services

`--service NAME=COMMAND` runs a program of its own beside the runner, for
work that needs a long-lived process (a renderer on the GPU, say), and
passes the app's requests to it. COMMAND is split as a shell would split it
but run without one, in the runner's working folder, with this package
importable. It gets:

| Variable | What |
|---|---|
| `NGP_SERVICE_PORT` | A free port on 127.0.0.1 to listen on |
| `NGP_SERVICE_TOKEN` | A random token. Every request the runner passes on carries it as `X-NGP-Service-Token`; refuse requests without it (other programs on the computer can reach the port) |
| `NGP_ROOTS` | The runner's roots, a JSON list of paths |
| `NGP_STATE_DIR` | A folder of its own, `<state-dir>/services/<name>/` |

It prints a line containing `ready http://127.0.0.1:<port>` once it
answers there; until then requests to it get 503 with `Retry-After`. Its
output goes to `<state-dir>/services/<name>.log`. If it ends, it is started
again (after 1 s, 2 s, 4 s … up to 30 s); after 5 ends in a row each within
30 s of starting, the runner stops trying and `/info` shows the error with
the log's last lines. It is stopped (SIGTERM, then SIGKILL after 5 s) when
the runner stops.

`/svc/<name>/<rest>?<query>` needs the pairing token and an allowed origin,
like the rest of the API, and goes to `http://127.0.0.1:<port>/<rest>?<query>`
with the same method (GET, HEAD, POST, PUT, DELETE; preflights are answered
by the runner), a body of up to 64 MB, `X-*` headers and the usual request
headers (`Content-Type`, `Accept`, `Range`, …), but not the runner's own
`Authorization`. The answer is streamed back as it comes (chunked when the
service gives no length), with its status, `Content-Type` and the like, and
its `X-*` headers, which pages may read. A service may take up to 300 s
between parts of an answer, so long polls work.

`python -m ngplatform_runner.echo_service` is a small one for trying it:

```
python -m ngplatform_runner --root ~/data --service echo="python -m ngplatform_runner.echo_service"
curl -H "Authorization: Bearer $(cat ~/.ngplatform-runner/token)" "http://127.0.0.1:8765/svc/echo/stream?n=3"
```

### The render service

`ngplatform_render` (beside the runner here) is a service that path-traces
OME-Zarr images on an NVIDIA GPU for the Anatomical rendering plugin. It
needs `pip install ./runner[render]` (numpy, zarr 3, fsspec, aiohttp,
pillow, CuPy) in the Python it runs with:

```
python -m ngplatform_runner --root ~/data \
  --service render="/path/to/env/bin/python -m ngplatform_render.server"
```

It uses the first GPU CUDA sees (set `CUDA_VISIBLE_DEVICES` to choose), keeps
levels it makes in `<its state dir>/render-cache` and stills, movies and
splats in `<its state dir>/renders` (or a folder under the roots the app
names), each in a new folder of its own. Movies need `ffmpeg` on the `PATH`;
`/info` says whether it was found. To read remote stores only from certain
places, add `--allow-source <url>` (more than once for several, or
`NGP_RENDER_SOURCES`, space-separated) to the service's command: a store
must then be under one of them. Its API is in
[plugins/anatomical-rendering/README.md](../plugins/anatomical-rendering/README.md).

**GPU memory.** Every session and job draws on one budget: by default 0.8
of the GPU memory free when the service starts, or `--gpu-budget` (`24G`,
`12000M`, or a part of the free memory such as `0.6`; also
`NGP_RENDER_GPU_BUDGET`). A new session is let in only when what it will
hold fits beside the others (its volume, labels, finer detail and its
frame), else `POST /sessions` answers 503 with `Retry-After` and says why;
a view larger than the session's frame so far asks for more the same way
(`PUT /sessions/<id>/view`, 503). Sessions and jobs on the same image, level,
channel and time point share one upload of it (and one read), counted once,
which goes when the last of them closes. `/info` lists the budget
(`budget`: `total_mb`, `used_mb`, `free_mb`, what holds it, the uploads and
how many use each).

**Jobs.** Stills, movies and splats run one at a time, in the order asked
for. While one waits its answer has `status: "queued"`, `queue_position`
(1: next to start) and `jobs_ahead` (those before it, the one running
included); a 429 with `Retry-After` refuses one when 8 wait already. A job
that could never fit the budget is a 400. At its turn a job waits (up to
ten minutes) for the GPU memory its frame needs, saying so in `message`.
`/info` has the queue (`queue`: `running`, `waiting`, `max_waiting`).

**Disk.** A job is refused (507, with the space free and needed) when it
would leave less than 1 GB free where it writes. A movie's frames are
deleted once its MP4 is made. Levels the service makes are cached by the
store, the level, the channel and time point and a stamp of the level's
metadata (its file's time, or the server's ETag or Last-Modified), so a
store written again is read again; the cache keeps within
`NGP_RENDER_CACHE_GB` (20 by default), least recently used out first.
Downloads (`/stills/<id>/file`, `/movies/<id>/file`,
`/splats/<id>/file/<name>`) are streamed and take a `Range`.

**Channels and time points.** An image with channel or time axes is shown
at channel 0 and time point 0 unless the session asks for others:
`POST /sessions {volume: {url, channel, time}}` (whole numbers from 0, else
a 400; out of the image's range, the session fails saying how many it
has). A loaded session's `volume` says which it shows and how many there
are: `channel`, `time`, `channels`, `times`, `axes`. Images need x, y and z
axes; 2-D images are not rendered.

**Splats.** Fitting needs a Python of its own with torch (with CUDA) and
gsplat 1.4.0 (`pip install "./runner[splat]"`), given with `--splat-python`;
`/info` says whether it is ready and warns of another gsplat. The fit runs on
the service's GPU (`--device`), keeps the views on the CPU (reading them from
their files as needed) and ends with the service.

A venv beside a Python that already has torch keeps torch and numpy as they
are (gsplat 1.4.0 works with torch 2.12 and CUDA 12.6):

```sh
/path/to/torch-env/bin/python -m venv --system-site-packages /path/to/splat-venv
/path/to/splat-venv/bin/pip install gsplat==1.4.0
```

gsplat builds its CUDA kernels the first time it fits (about 4 minutes on 32
cores; they are kept in `~/.cache/torch_extensions` after that). The build
needs nvcc of the CUDA torch was built for and ninja: the service puts the
splat Python's own folder (where pip put ninja) first on the fit's PATH, and
nvcc is found from `CUDA_HOME` or the PATH, so start the service with, for
example, `CUDA_HOME=/usr/local/cuda-12.6 PATH=/usr/local/cuda-12.6/bin:$PATH`.
A splat of the 100 um SRB template (64 views of 384 px at 64 samples, 3000
steps, about 100 000 Gaussians) takes 1.5 minutes for the views and a
minute for the fit on an RTX A6000, with 1.6 GB of GPU memory for the fit
(`gpu_peak_mb` in its `fit.json`).

## Using a GPU on another machine over SSH

The browser on one computer (a laptop) can use a runner on another (a
workstation with a GPU, a node of a cluster) through an SSH tunnel. The
runner still listens on 127.0.0.1 only, on its own computer; the tunnel
carries the browser's requests to it.

On the computer the browser is on, with this package (`pip install
./runner`, or from `runner/`):

```
python -m ngplatform_runner tunnel me@workstation --start-remote '/path/to/env/bin/python -m ngplatform_runner --root /data'
```

It

1. opens `ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -L
   7000:127.0.0.1:8765 me@workstation`, and opens it again when it drops;
2. checks whether a runner answers through it, and if not, with
   `--start-remote`, starts one there in the background (`nohup … >
   ~/.ngplatform-runner/remote.log 2>&1 &`, adding `--public-url
   http://localhost:7000`, `--port` and `--state-dir` when the command does
   not give them), then waits for it;
3. reads the runner's token there (`ssh me@workstation cat
   ~/.ngplatform-runner/token`);
4. asks the runner for `/info` through the tunnel and prints the computer,
   its GPUs and services;
5. prints a link that pairs the app with it as a computer of its own name
   (`…#runner=http%3A%2F%2Flocalhost%3A7000&token=…&name=workstation`),
   and the same steps as commands to run by hand.

It keeps the tunnel open until Ctrl-C; the runner on the other computer
keeps running.

| Option | What |
|---|---|
| `[user@]HOST` | The computer the runner is on, as you would give it to ssh (a name from `~/.ssh/config` works) |
| `--jump J`, `-J J` | Reach HOST through J (`ssh -J`), such as a cluster's login node |
| `--remote-port N` | The runner's port on HOST (default 8765) |
| `--local-port N` | The port on this computer the browser uses (default 7000) |
| `--start-remote 'COMMAND'` | Start the runner on HOST with this command when nothing answers. Give the full path of the Python that has the runner (a login shell may not have your environment); `cd ~/ngplatform/runner && python -m ngplatform_runner …` works too |
| `--state-dir DIR` | The runner's `--state-dir` on HOST, where its token is (default `~/.ngplatform-runner`) |
| `--name NAME` | The name the app shows (default HOST) |
| `--app URL` | The app's address, for the link |
| `--ssh PROGRAM`, `-o OPTION` | The ssh program, and `-o` options for it |

Each step is an ssh login of its own (the tunnel, starting the runner,
reading the token), so a login that asks for a password or a second factor
asks up to three times.

### By hand

On the other computer:

```
python -m ngplatform_runner --root /data --public-url http://localhost:7000 --service render="/path/to/env/bin/python -m ngplatform_render.server"
```

It prints a link with `&name=<its hostname>`. On the browser's computer:

```
ssh -N -L 7000:127.0.0.1:8765 me@workstation
```

then open the link (or the app's Settings › Compute, **Add a computer (SSH)…**, with the
address `http://localhost:7000` and the token).

### On a cluster

Start an interactive job, and in it start the runner as above (on the node,
127.0.0.1 is the node's own). Then from the browser's computer, through the
login node:

```
ssh -N -J me@login.cluster -L 7000:127.0.0.1:8765 node123
```

or `python -m ngplatform_runner tunnel node123 --jump me@login.cluster`. The
node must accept ssh from the login node, as most clusters allow while you
have a job on it.

### What the browser sees

The runner is at `http://localhost:7000`, an address of the browser's own
computer, so the app treats it as it treats This computer: the same
pairing, the same Private Network Access checks in Chrome. Files it serves
have addresses at `http://localhost:7000/stores/…`, which the viewer reads
through the tunnel; they stop loading when the tunnel closes. Several
computers can be paired at once, each on its own local port
(`--local-port 7001` for the second).

## Tests

```
cd runner/tests
python -m unittest -v      # or, from the repository: python -m pytest runner/tests -q
```

They start runners on free ports with temporary folders. The tests of the
tunnel use a fake ssh (`tests/fake_ssh.py`) whose forward is a TCP
forwarder on this computer (`tests/forwarder.py`), since they cannot log in
anywhere. The tests of real jobs (filtering, converting, serving a `.trk`)
run when zarr-vectors-tools can be imported, and use the tractograms in
`plugins/zarr-vectors/testdata/tractograms`.

The render service's tests that render need CuPy and a CUDA GPU, and are
skipped without them; the movie's encoding needs `ffmpeg`. The splat fit's
tests run when `NGP_TEST_TORCH_PYTHON` names a Python with torch (gsplat is
stood in for), for example
`NGP_TEST_TORCH_PYTHON=/path/to/torch-env/bin/python python -m pytest runner/tests -q`;
the real fit's test runs when `NGP_TEST_SPLAT_PYTHON` names a splat Python
(torch with CUDA and gsplat, as above) and a GPU is there.
