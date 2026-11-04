# Jobs on this computer

Some work is too large for a browser tab: filtering a 20 GB tractogram into
a new `.trk`, converting it to Zarr Vectors, a density map of millions of
streamlines. The **runner** does that work as Python processes on your own
computer. The app starts the jobs and shows them in the **Jobs** tab, under
**This computer**: each one's process id (PID), progress, log, a Cancel
button, and its output files with **Open**, which adds them as layers.

The runner is in this repository's `runner/` folder (a Python package,
`ngplatform_runner`). It uses
[zarr-vectors-tools](https://github.com/AllenInstitute/zarr-vectors-tools)
for the work. Its reference: [runner/README.md](https://github.com/AllenInstitute/ngplatform/blob/main/runner/README.md).

## Starting it

In a terminal, in the Python environment that has zarr-vectors-tools:

```
cd ngplatform/runner
python -m ngplatform_runner --root ~/data
```

`--root` names a folder the runner may use: jobs read their inputs and
write their outputs only under the roots, and the app can list only them.
Give one `--root` for each folder you want to use. The runner prints its
address (`http://127.0.0.1:8765`), a token, and a link.

## Pairing the app with it

Do one of these, once per browser:

- Open the link the runner printed. The app asks whether to pair with the
  runner at that address; choose **Pair**.
- Or, in the **Jobs** tab under **This computer**, enter the address and
  the token, then **Pair**.

The address and token are kept in this browser (not in links you share).
The section then shows the runner's version, its folders and the
zarr-vectors-tools version jobs run with. **Unpair** forgets the pairing.
If the runner is stopped, the section says it does not answer; start it
again and choose **Try again**.

## What it does

| From | What |
|---|---|
| Track filtering: **Run on this computer** (by each group's Save .trk) | Sends the group's regions (spheres, boxes, disks, masks, with "either end" and "both ends") and attribute ranges as a filter job over the whole tractogram. You choose the folder and name, and which outputs: a `.trk`, a Zarr Vectors store with coarser levels, a density map. The group shows the job's progress; when it is done, the outputs are added as layers. |
| Jobs tab: **Convert a tractogram…** | A `.trk`, `.tck` or `.trx` becomes a Zarr Vectors store with three coarser levels, which the viewer and Track filtering read a chunk at a time however large the file. |
| Jobs tab: **Open a file…** | Adds a store, tractogram, mesh, SWC, point table or NIfTI image under the runner's folders as a layer. |
| Dropping a tractogram over 2 GB | The browser cannot read it (it reads a tractogram whole), so the app offers the runner instead: **Serve it** (a process reads the file once and serves it to the viewer as a store; it needs memory for the whole file) or **Convert it** (a job writes a store next to it, then opens it). The browser does not tell the page where a dropped file is, so the app looks for a file of that name and size under the runner's folders, or asks you to choose it. |

Each job in the Jobs tab shows its title, state (queued, running, done,
failed, cancelled), PID, time, progress and last message. **Log** shows
the end of its output. **Cancel** ends its process and any it started; a
cancelled filter job deletes the `.trk` it was writing. **Open** adds an
output as a layer. Files the runner serves to the viewer appear as
"Serve …" jobs while they are served; **Stop** ends one. Two jobs run at
once (`--max-jobs`); more wait in a queue.

Jobs carry on if you close the tab or stop the runner. When the runner
starts again it lists them, still running or finished, with their logs.

### Where results are

Results are written where you choose, under the runner's folders. A filter
job's outputs are in the coordinates the viewer showed its input in (RAS+
millimetres for a tractogram file; a store's own space for a store), so
they line up with it. A density map is a NIfTI image of float32 counts:
each passing streamline counts once in each voxel it passes through.

### How long it takes

The filter job reads a `.trk` without loading it into memory, about
50 000 streamlines at a time, and tests each batch with zarr-vectors-tools'
reference engine: on a laptop about 45 MB of file a second for a sphere,
so a 20 GB tractogram takes some minutes. Writing a store adds a
conversion of the streamlines that pass.

## What it cannot do

- It runs only the kinds of job listed above. It cannot run a command or
  code you send it.
- It reads and writes only under its roots. A file elsewhere cannot be an
  input; move it, or start the runner with its folder as another `--root`.
- It reads data on this computer only, not from a bucket or a web server.
  For a dataset opened from a URL, Run on this computer asks for a copy of
  it under the runner's folders.
- Track filtering groups that choose by tags (stored groups) cannot run
  there yet; regions and attribute ranges can.
- A store as a filter input is read whole into memory (level 0); a `.trk`
  is not. Serving a tractogram file as it is also reads it whole; convert a
  very large one instead.

## Safety

- The runner listens on 127.0.0.1 only, so other computers cannot reach it.
- Every request to its API needs the token. A page asking must also be
  this app's site (or `localhost`, for development; `--allow-origin` adds
  another), and the request must be addressed to this computer, which stops
  other sites reaching it through DNS tricks.
- The token is printed when it starts and kept in `~/.ngplatform-runner/token`,
  readable by you only. `--new-token` replaces it; browsers paired before
  must then pair again.
- Every path is checked against the roots after links are followed, and an
  output that exists is not overwritten (the app never asks to; choose
  another name). An output cannot be the job's input.
- Files it serves to the viewer are at addresses with a random part (128
  bits). They need no token, because the viewer cannot send one, but a web
  page can read them only from the origins the runner allows (this app's),
  so a shared link does not let another site read them. A file served by a
  process has a **Stop** in the Jobs tab, which also keeps it from being
  served again when the runner restarts. Folders and NIfTI files served as
  they are have no row; they stop being served when the runner stops.
- Chrome asks before a site may reach your computer's own network
  addresses: allow it for this app. The runner answers the checks Chrome
  makes (Private Network Access).
