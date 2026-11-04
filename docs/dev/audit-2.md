# Audit, part 2: annotations to capture

*2026-11-04.* An audit of the second half of the app before it is shared
with other teams: Annotations, Segmentation, Registration, Collections,
Time series, the Auth tab, Jobs → This computer, the Python panel and the
starter plugins, and Capture. (Part 1, the platform tabs and the other
plugins, is [audit.md](audit.md).)

Each area was read against its README and docs page, its code was read for
bugs (unhandled errors, listeners left behind, races, units, state that
should be per scene), and its controls were used in headless Chrome. Bugs
found were fixed, with a test where one could be written; panel text that
explained too much was cut to a line, the rest moved to tooltips and the
docs. One commit per area.

**Complete** is a judgement of how much of what the area sets out to do
works as a user would expect: 100 % is "nothing known missing".
**Left** lists what is not done, with an estimate in hours.

## Summary

| Area | Complete | Bugs fixed | Left (hours) |
|---|---|---|---|
| Annotations | 90 % | 11 | 5.5 |
| Segmentation | 80 % | 10 | 13 |
| Registration | 85 % | 6 | 6 |
| Collections | 70 % | 4 | 8 |
| Time series | 85 % | 4 | 2.5 |
| Auth tab | 85 % | 3 | 4 |
| Jobs → This computer | 80 % | 7 | 5 |
| Python panel and starters | 75 % | 3 | 5 |
| Capture | 90 % | 4 | 2 |

## Annotations

**What it does.** The Annotations tab: Annotate (local annotation layers,
point/line/box/ellipsoid/polyline tools, nested groups shown, hidden and
coloured, fields: lists, numbers, text, ontology terms), Labels (pinned
names for figures), Measure (lengths, areas, volumes, a line profile) and
Statistics (an image's values in a region); the annotation table in the
bottom dock (search, sort, edit, comments, CSV out and in).

**Complete: 90 %.**

**Bugs found and fixed**

- An edit made while an annotation was being drawn (a delete, say) was
  queued; when drawing ended it treated every annotation it did not hold as
  newly drawn, so **deleted annotations came back**. Comments added during
  the wait were lost, and a queued edit could land on a same-named layer in
  another scene.
- **New annotations go to → No group** did nothing (a default parameter kept
  the old group).
- **Open CSV…** copied track filtering's region rows into the user's layer,
  and threw (silently) when the table was filtered to the regions layer.
  Test added.
- A comment of several lines came back from CSV as several comments. Test
  added.
- The voxel reader's worker had no error handler: a worker out of memory
  left Statistics and the line profile on "Reading…" for ever. The memory
  budget also counted 4 bytes a voxel where the worker holds 8 (20 for an
  atlas label).
- Labels pinned to a polyline never showed; labels on annotations ignored
  the layer's transform.
- A field could be renamed to another field's name; colouring by a number
  used `Math.min(...values)`, which overflows the stack on a large layer.
- Comment times were shown in UTC without saying so; they are local now
  (UTC on hover).
- Turning hidden groups or colours off deleted a shader of the user's own
  (only Undo brought it back); it is now kept and put back. Test added.

**UI.** The hints under the tools, groups, fields, labels and table are
one line each; the per-tool instructions were already in the tools'
tooltips.

**Left**

| What | Hours |
|---|---|
| Labels and Statistics keep the first service object they were given: switching Track filtering or Segmentation off and on leaves a dead one | 1 |
| Every state change (panning) rebuilds the table and the measurement list; slow past a few thousand annotations | 2 |
| Statistics results and the line profile are shared by all scenes | 1 |
| Lengths, areas and volumes are 0 in a space without physical units, with no word why | 1 |
| Profile sampling: two samples a voxel when trilinear, capped at 4096 (the docs say about one a voxel) | 0.5 |

## Segmentation

**What it does.** The Segmentation tab and its tool bar over the views:
label volumes on an image's grid (or a copy of a segmentation's labels),
brush, eraser, lasso, fill, interpolation, pick, quick select (threshold or
MobileSAM in the page), segments and segment groups, undo shared with the
workspace, editing a segmentation of any size in place (copy-on-write),
saving NIfTI or OME-Zarr (the edits alone, or the whole volume as a job).

**Complete: 80 %.**

**Bugs found and fixed**

- Quick select and Spread ran on the stroke queue and could not be stopped
  while the model downloaded or a worker call ran: **every tool stopped
  working** until it ended (for ever if the download stalled). Escape and
  Stop now end the wait at once. A mask worked out for a volume no longer
  shown is dropped.
- **Undoing Delete or Merge** brought the voxels back but not the segment's
  name and colour. Test added (the stroke's undo hooks).
- Two saves could run at once (two whole-volume jobs into one folder); a
  save set "nothing unsaved" even when strokes were made during it; a file
  picker's failure was thrown away unhandled.
- The browser copy was written 1.5 s after the last change and the timer
  restarted on each change: a reload during or just after drawing lost the
  last strokes. It is now written on leaving the page, and at least every
  5 s while drawing.
- **Only within the range** painted everywhere when the image's values
  could not be read (the image layer removed, renamed or not loaded). It now
  paints nothing and says why.
- Changing the brush unit kept the number (5 voxels became 5 mm).
- **Create** could be pressed twice while a copy was made, making two layers.
- Renaming the label layer broke the session ("has not loaded yet" on every
  click); it now follows its store. The range limit ticked with no image
  chosen painted everywhere; it now paints nothing and says why.

**UI.** The edit-in-place paragraph (eight lines) is one line with the
details in its tooltip; save hints, the quick select hint and the empty
state are a line each; "Too large for one NIfTI" is shown as an error.

**Left**

| What | Hours |
|---|---|
| Delete, Merge, Go to and Interpolate on a volume edited in place read every edited chunk into memory at once: work in batches | 3 |
| A 2-D fill by image range on an ordinary volume reads the whole section at full resolution: cap it as in-place volumes are | 1 |
| A label layer removed with Neuroglancer's own controls stays in memory (volume, 512 MB of undo, served store) for the visit | 2 |
| Strokes and workspace changes do not fully share one redo stack (undo a stroke, hide a layer, redo: the stroke comes back) | 2 |
| Enter during Spread paints the first section only; undoing a group's colour leaves its segments recoloured | 2 |
| Open edits… reads names and colours but not segment groups | 1 |
| Cached image values are not dropped when a layer moves; number inputs are redrawn while typed in | 2 |

## Registration

**What it does.** Moving a layer by hand (rotate, translate, scale, flip;
about the volume's centre or the views' centre), straightening by four
landmarks, landmark pairs fitted as translation, rigid, similarity or
affine, a thin-plate-spline warp through the pairs, transform files in and
out (LTA, ITK/ANTs, plain, MNI .xfm, register.dat, FSL), and saving the
moved image (NIfTI, MGH, OME-Zarr; resampled or header only).

**Complete: 85 %.**

**Bugs found and fixed**

- Saving at full resolution read 32-bit labels and 64-bit floats as 32-bit
  floats: **labels above 2^24 were rounded** in the saved file.
- The state's change notice comes for every plugin's state; a slider drag
  (kept in memory until it ends) was read over by any other plugin's change
  and applied twice.
- A file picker's failure was an unhandled rejection; **Warp through the
  pairs** did nothing, silently, for a layer without a source address;
  straighten marks and notes stayed when another moving layer was chosen.

**UI.** The panel was one long page; its five sections now fold (as the
Annotations tab's do) and stay as the user left them. The straighten and
landmark hints are one line. The guide now lists .mgz/.mgh and full
resolution saving.

**Left**

| What | Hours |
|---|---|
| Apply to all visible volumes resets each follower to its file's placement, losing its own registration | 2 |
| Chosen grid, notes and the last fit are shared by all scenes (the saved state is per scene) | 1 |
| A test that saves a uint32 label image above 2^24 through the block writer | 1 |
| The landmark pairs table and Model/Live/Apply could be one compact block; Save image needs its own button row | 2 |

## Collections

**What it does.** OME-NGFF collections (RFC-8, draft): a Collections tab
beside the scenes showing a collection's images, each placed in the
coordinate system chosen in a graph, images behind a displacement field
resampled as they are viewed, and collections found above the workspace's
images.

**Complete: 70 %.** The RFC is a draft; the plugin reads what it can.

**Bugs found and fixed**

- Opening a collection, or choosing a system, awaited many steps without
  checking that the Collections tab was still shown: switching scene during
  it could **empty the user's own scene** and fill it with the members. Each
  step now stops when the scene changed or something newer was asked for.
- An image with channels or time was polled for 20 s, then left shown and
  unplaced (and held up the members after it). It is now hidden, and the
  Activity tab says why.
- The error line used a class that does not exist (it was not red); the
  address box was unstyled, Enter did nothing, typed text was lost on a
  redraw, and an empty address read "" as a URL.
- The README said coordinate maps are not applied; they are.

**Left**

| What | Hours |
|---|---|
| A member whose unit differs from the system's (µm into mm) is scaled wrongly: only the system's unit is used | 2 |
| Axes indexed by the output system where the input's are meant: systems with different axis orders (zyx vs xyz) swap axes | 3 |
| Images with channels or time placed on their x, y, z | 2 |
| `root`, `warped` and `hidden` are shared, so only one Collections tab works | 1 |

## Time series

**What it does.** The Time series tab (bottom dock): the time course of the
voxel under the mouse in a 4-D NIfTI or an OME-Zarr image with t, pinned
voxels and region means, playing through time, CSV; on a surface with a
CIFTI time series, the vertex under the mouse, pinned vertices and a
parcel's mean and SD.

**Complete: 85 %.**

**Bugs found and fixed**

- **% change** of a series with a negative mean was drawn upside down
  (divided by the signed mean, while its SD band used the mean's size).
  Test added.
- Pin (Alt+P) pinned the last voxel read, 80 ms behind the mouse, not the
  voxel under it.
- A surface time point asked for while another surface's was being sent was
  never sent.
- A layer whose source is a list was not offered as an image.

**UI.** With no image with a time axis, the tab shows one line instead of
an empty plot (axes 0 to 1) and disabled transport controls.

**Left**

| What | Hours |
|---|---|
| A region pin is not read again when the image layer moves (only the annotation layer's transform is watched) | 1 |
| Parcellation and region choice are shared by all scenes | 1 |
| Playback rate and loop are per browser, not per scene (decide which is wanted) | 0.5 |

## Auth tab

**What it does.** Google accounts (several, one the default), other
sign-ins (middleauth for CAVE/CATMAID, ngauth, plugins'), rules giving data
under an address a sign-in, each layer's sign-in, and the Google OAuth
client ID.

**Complete: 85 %.**

**Bugs found and fixed**

- Errors from the tab's buttons went only to the Activity tab (which nothing
  else shows), so a blocked popup, a bad rule or server address, or "Google
  is still loading" looked like a dead button. They are now toasts too.
- A middleauth server that could not be reached once was taken for the rest
  of the visit as "not an app", so Sign in opened a 404.
- **Add** took "not a url" as a server (Chrome's URL parser accepts it as
  the host `not%20a%20url`). Addresses with spaces or a host that is not
  one are refused. Test added.

**UI.** Six paragraphs of explanation are one line each (details in
tooltips and the Signing in guide); "Google sign-in setup" folds away once
a client ID is set.

**Left** (fixed in E1: the service worker asks the open tabs for the Google tokens again after the browser restarts it, or on a 401)

| What | Hours |
|---|---|
| The service worker and the main path can choose different Google accounts when a rule names none (the worker's table drops such rules) | 1.5 |
| "Reload to apply" note: apply the new sign-in without a reload | 0.5 |

## Jobs → This computer

**What it does.** Pairing with the runner (`python -m ngplatform_runner`),
its jobs with PID, progress, log, Cancel and Open, converting a tractogram,
opening a file through the runner, and files served to the viewer.

**Complete: 80 %.**

**Bugs found and fixed**

- **Stop** on a served file cancelled its process but kept its record, so
  the runner served it again on its next start; folders and NIfTI files
  served as they are had no row and no way to stop. Stop now stops the
  serve, and **Served…** lists everything served, each with Stop.
- Served stores answered `Access-Control-Allow-Origin: *`: any site that
  learned a store's address (it travels in shared links) could read it while
  the runner ran. They now answer the allowed origins only. Tests changed to
  match.
- Waiting for a job never ended when the runner was unpaired or the job was
  forgotten, could run its end twice, and ignored an abort given before it
  began; pairing again during a fetch could stop polling.
- A filter's output could be its own input (the `.trk` truncated while
  read); `?tail=abc` was a 500; the token file was briefly readable by
  others.

**UI.** The pairing note is two lines.

**Left**

| What | Hours |
|---|---|
| Running a job again to an output that exists fails ("exists already"); offer Open or Overwrite | 2 |
| The finished-jobs list of the page keeps 50: a running job can drop off it and cannot be cancelled there | 1 |
| Tests for `RunnerService.wait` ending on unpair and on a job gone | 1 |
| The page's own jobs ("In this page") and the runner's could share one list | 1 |

## Python panel and starter plugins

**What it does.** A Python console (Pyodide) in the bottom dock, with
`ngp`, the workspace (state, layers, `show` for numpy arrays, points,
lines, meshes, annotations, commands and tabs from Python); the starter
plugins to copy: `plugins/starter_ts` (TypeScript, built in; and the same as
one `.mjs`) and `plugins/starter_py` (Python, loaded from the Plugins tab).

**Complete: 75 %.**

**Bugs found and fixed**

- What Python printed went to the Python tab only while it had been opened;
  a command's `print` (the Python starter's "say hello") went to the
  browser's console. It now goes to the Activity tab when the Python tab is
  not open.
- Every Python plugin's commands had ids `python.<function>`: a second
  plugin, or the console, defining `hello` failed to load. Plugins' default
  ids are now `python.<plugin>.<function>`.
- If Pyodide did not load, the tab said "reopen this tab", which did
  nothing; it now has **Try again**.

**UI.** The greeting lists no API (it was a line of 300 characters); it
says `help(ngp)`.

**Left**

| What | Hours |
|---|---|
| Python runs on the page's main thread and cannot be interrupted: a long loop freezes the app, an `await` that never ends leaves the input off. Run it in a worker, or add a Stop and say so | 3 (worker: more) |
| A Python plugin's code runs in the console's globals (names can clash) | 1 |
| The Python starter has no counter in the scene's state, as the TypeScript one has | 1 |

## Capture

**What it does.** The camera icon: a picture of the views (magnified,
trimmed), a movie sweeping a dimension (slices or time) or turning the 3-D
view, as GIF, WebM, MP4 or PNG frames.

**Complete: 90 %.**

**Bugs found and fixed**

- Two captures could run at once, both moving the view, mixing frames.
- GIF delays were rounded per frame: 30 frames a second played at 33.3,
  24 at 25. The rounding is now carried (3, 4, 3, …). Test added.
- MP4's decoder description was read from its whole buffer, not its own
  bytes.
- The frame count did not follow a change of dimension.

**UI.** Labels carry their units (Magnification (×), Margin after trimming
(px), Max wait per frame (s), Angle (°), From/To in the dimension's unit);
the footnote is a field hint.

**Left**

| What | Hours |
|---|---|
| WebM is recorded in real time: a background tab or slow decoding stretches its timing. Say so, or prefer MP4 | 1 |
| A capture's job could disable the camera menu while it runs | 1 |

## How it was checked

- `npx vitest run`, `npm test`, `npm run typecheck`, `npm run build`, and the
  runner's Python tests.
- Headless Chrome (SwiftShader), with the plugins switched on through
  `localStorage`: the existing flows for each area (annotations, the table,
  scenes; segmentation tools, groups, quick select, undo; collections; time
  series on a 4-D NIfTI; Python `show`; the starters; the runner end to end)
  before and after, and two new ones: a tour of every panel, and the
  controls changed here (Registration's sections, a bad server address in
  Auth, Capture's count, Collections' empty address, `help(ngp)` and a
  command's print).
