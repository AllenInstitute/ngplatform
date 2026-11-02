# Plugins

Everything in ngplatform beyond viewing is a plugin: a folder in
[`plugins/`](https://github.com/AllenInstitute/ngplatform/tree/main/plugins)
with a manifest (what the platform shows before loading any code) and its
code. The **Plugins** tab lists them, with a switch, a one-line description
and a *Read more* guide each.

## Two kinds

- **Data types** teach Neuroglancer a new format. They run inside
  Neuroglancer's workers and add a source prefix (for example
  `|zarr-vectors:`). They can also declare files they read in place from
  your computer, as virtual stores.
- **Tools** add tabs, commands, overlays and views around Neuroglancer: track
  filtering, labels, registration, volume rendering. They work through the
  platform's SDK (`@ngplatform/sdk`): the workspace, the viewer, the docks,
  jobs, storage and sign-in.

## The plugins

| Plugin | Kind | On by default | What it does |
|---|---|---|---|
| [Zarr Vectors](zarr-vectors.md) | data type | yes | Points, streamlines, skeletons, graphs and meshes from Zarr Vectors stores, and local tractograms, meshes, neurons and point tables as virtual stores. |
| [Track filtering](track-filtering.md) | tool | yes | TrackVis-style groups of the objects that pass through regions. |
| [Labels](labels.md) | tool | yes | Labels on the views for figures, in screenshots too. |
| [Registration](registration.md) | tool | no | Move a layer by hand (as Freeview) or by landmarks; save the transform or the moved image. |
| [Volume rendering](volume-rendering.md) | tool | no | An image drawn as a solid in the 3-D view, cut open at the position. |
| [Collections](collections.md) | tool | no | OME-Zarr collections (RFC-8, draft): members, coordinate systems, transforms, and a scene of them. |

## Switching, adding and writing plugins

- **Switch** a plugin on or off in the Plugins tab; the choice is remembered.
- **Try** a plugin without building the app: Plugins → **Add** loads a
  JavaScript module or a Python file from your computer, and reloads it
  after each edit. A plugin from a URL shows its manifest and asks before
  any of its code runs.
- **Write** one: copy the folder of the plugin closest to what you need, give
  it a unique id, and add one line to `plugins/index.ts`. The full guide,
  with the manifest, the SDK and examples, is
  [`plugins/README.md`](https://github.com/AllenInstitute/ngplatform/blob/main/plugins/README.md).

## Plugin pages

Each plugin has a page here, written for users: what it is for, how to use
it, and a **Notes from users** section at the end. Anyone can add tips,
workflows, problems and figures there; the edit (pencil) icon at the top
of each page opens it on GitHub. New plugins start from the
[page template](template.md). For what might come next, see
[Ideas for new plugins](ideas.md).
