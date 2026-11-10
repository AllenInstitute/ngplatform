# SDK reference

A plugin reaches the platform only through `@ngplatform/sdk`: the root
module and the modules under it, one file each in
[`src/sdk/`](https://github.com/AllenInstitute/ngplatform/tree/main/src/sdk).
This page lists them and their main exports. How to write a plugin, and
how to put a panel together from these parts, is in the
[plugin guide](https://github.com/AllenInstitute/ngplatform/blob/main/plugins/README.md)
and its section
[Building a panel](https://github.com/AllenInstitute/ngplatform/blob/main/plugins/README.md#building-a-panel).

```ts
import { card, field, slider, type PlatformContext } from "@ngplatform/sdk";
import { csv } from "@ngplatform/sdk/format";
```

## `@ngplatform/sdk`

The types, the manifest check and the parts a panel is built from.

| Export | What |
|---|---|
| `PluginModule` | What a tool plugin's `plugin.ts` exports: `activate(ctx)`, and `deactivate()` if it needs one. |
| `Manifest` | What the platform shows before loading a plugin: id, name, kind, `contributes` (commands, panels, scene kinds, state), `guide`. |
| `PlatformContext` | The `ctx` a tool plugin is given: `commands`, `ui`, `workspace`, `viewer`, `state`, `settings`, `context`, `jobs`, `runner`, `hosts`, `services`, `open`, `log`, `auth` and `subscriptions`. |
| `WorkspaceApi`, `ViewerApi` | Scenes, datasets and layers; the views, positions, layers' specs and drawing in the 3-D view. |
| `RunnerApi`, `HostsApi` | Jobs on this computer, and the computers paired in Settings › Compute. |
| `AuthProvider`, `AuthService`, `SourceSignIn` | A sign-in method of a plugin's own, listed in Settings › Sign-in. |
| `VirtualFormat` | A kind of file a data type plugin reads in place. |
| `Disposer`, `Json`, `DockSlot` | Small shared types. |
| `checkManifest`, `MANIFEST_SCHEMA` | Checks a manifest (the tests run it on every plugin). |
| `PLATFORM_CONTEXT_KEYS` | The names on `ctx`, for checks. |
| `card`, `field`, `slider`, `toggle`, `checkbox`, `info`, `emptyState`, `statusLine`, `region`, `roving`, `icon`, `iconButton`, `el` | The parts of a panel, also in `@ngplatform/sdk/dom` (below). |

## `@ngplatform/sdk/dom`

Elements, the parts of a panel and files to save. The rules the parts keep
are in [Building a panel](https://github.com/AllenInstitute/ngplatform/blob/main/plugins/README.md#building-a-panel).

| Export | What |
|---|---|
| `el`, `svgEl`, `append`, `clear` | Make an element with attributes and children; add or replace children. |
| `card` | A group of a panel's controls that folds away and remembers whether it is open. |
| `field` | A control with its label (and an optional info control). |
| `button`, `iconButton` | A button; an icon button with an accessible name. |
| `select`, `numberInput` | The one select and the one number box. |
| `slider`, `stepText` | The one slider, with its number beside it. |
| `toggle`, `checkbox` | A switch turns a feature on; a checkbox picks items or options. |
| `info` | An explanation behind a small (i) that keyboard and touch reach. |
| `emptyState` | One line and its action, for a panel with nothing to show. |
| `statusLine` | Progress and errors, an error with its action (Retry, say). |
| `region` | Part of a panel drawn again only when what it shows changes. |
| `roving` | Arrow keys, Home, End (and a letter, in menus) within a group of items: a list of tabs, a menu, a picker. |
| `icon` | One of the app's icons by name (`IconName`). |
| `downloadBlob`, `safeFileName` | Save a file the browser downloads; a file name made safe. |

## `@ngplatform/sdk/testing`

| Export | What |
|---|---|
| `fakeDocument` | A stand-in document for panel tests in Node: build a panel, read its text, click and type as a person would. |
| `FakeElement`, `FakeEvent`, `FakeDom` | Its parts and type. |

## `@ngplatform/sdk/workers`, `/worker_rpc` and `/virtual`

| Module | Export | What |
|---|---|---|
| `workers` | `asyncComputationWorker` | A worker for Neuroglancer's chunk decoders (zstd, blosc, gzip…), for a plugin's own worker that reads chunks. |
| `worker_rpc` | `WorkerRpc` | Requests to a worker as promises, with progress and cancelling; a worker that dies fails its requests, or is started again if asked. |
| `virtual` | `serveVirtualStores` | Serves a format's virtual stores from its worker: a function that opens one from a file answers each key. |

## Data and formats

| Module | Main exports | What |
|---|---|---|
| `format` | `csv`, `csvField`, `ticks`, `mmText`, `bytesText`, `parseBytes` | Numbers, sizes and tables as text. |
| `mat4` | `Mat4`, `Vec3`, `identity4`, `multiply4`, `apply4`, `invert4` | 4 × 4 matrices. |
| `ome` | `summariseOme`, `describeTransform` | OME-Zarr metadata and transforms in words. |
| `sources` | `precomputedUrl`, `layerSourceUrl` | A layer's source as a URL. |
| `precomputed` | `readInfo`, `PrecomputedScale`, `ShardedReader`, `httpRead`, `httpJson` | Neuroglancer precomputed volumes read in a plugin's worker: scales, chunks, sharding. |
| `precomputed_annotations` | `PrecomputedAnnotations`, `readAnnotationInfo`, `decodeSpatialChunk` | Precomputed annotations that meet a box, by their spatial index. |
| `lookup` | `parseLookupTable`, `hexColour`, `LookupTable` | Label lookup tables (FreeSurfer, ITK-SNAP, FSL, Allen and plain lists). |
| `volume_out` | `niftiFile`, `mghFile`, `omeZarrFiles`, `zipFiles`, `pyramidGrids` | Writing images to NIfTI, MGH, OME-Zarr and zip. |
| `filters` | `FilterSpec`, `filterName`, `parseFilterName` | The filters computed on the fly (Filters' steps). |
| `tensors` | `eigenSym3` | The eigen-decomposition of a symmetric 3 × 3 tensor. |
