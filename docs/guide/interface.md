# The window, tab by tab

![The window, numbered as the sections below](../images/interface-numbered.png)

The window has a top bar (1), three docks around Neuroglancer's views: left
(2), right (4) and bottom (5), and the views themselves (3). Docks can be
resized by dragging their edges and collapsed with the icon at their top
right; sizes and open tabs are remembered by your browser.

Almost everything is also a command: **Commands** (++ctrl+k++) searches them
all, and the keyboard icon lists the keyboard and mouse bindings.

## 1. Top bar

| Control | What it does |
|---|---|
| **Open** | Open from device (files or a folder on your computer), a link or a Neuroglancer state, or an example or template. Opening replaces the workspace. |
| **Add** | Add a dataset to the current scene: a URL, data on this computer, or a new annotation layer. |
| **Share** | Copy a link to the whole workspace, copy this scene as a Neuroglancer link or JSON state, or open it in this site's plain Neuroglancer page. |
| **Neuroglancer** | Open this scene in Google's Neuroglancer in a new tab. It says so when the scene holds data plain Neuroglancer cannot read (Zarr Vectors, files on this computer). |
| **Undo / Redo** | Undo any change to the workspace: layers, positions, settings, plugin state. |
| **Scene tabs** | One tab per scene. **+** adds a scene; each tab has a close button (closing the last leaves a blank scene). Rename, duplicate and delete scenes from the command palette. |
| Camera icon | Screenshot of the views, at a chosen size; labels from the Labels plugin are painted in. |
| Gear icon | View settings, reload the scene's layers, or a hard reset that reloads everything fresh. |
| Keyboard icon | The keyboard and mouse reference. |
| **Commands** | The command palette (++ctrl+k++). |

## 2. Left dock

| Tab | What it holds |
|---|---|
| **Datasets** | What the scene shows: one row per dataset with its visibility, load state and source. A dataset shown through several layers (a tractogram and its track groups, say) lists them beneath it. Selecting a row shows its controls in the Layer tab. Datasets that other scenes show are listed below, ready to add. |
| **Filtering** | The Track filtering plugin: TrackVis-style track groups. See [Track filtering](../plugins/track-filtering.md). |
| **Labels** | The Labels plugin: named pins and callouts for figures. See [Labels](../plugins/labels.md). |
| **Registration** | When the Registration plugin is on: move a layer by hand or by landmarks, and save the transform or the moved image. See [Registration](../plugins/registration.md). |
| **Auth** | The services the workspace's data needs a sign-in for (for example a private Google Cloud bucket), with who is signed in. |
| **Plugins** | Every plugin, with a switch, a one-line description and a *Read more* guide. **Add** loads a plugin from your computer or a URL. See [Plugins](../plugins/index.md). |

## 3. The views

Neuroglancer's own views, unchanged: cross-sections and the 3-D view, in
whichever layout the scene uses. The position (in the scene's units) is at
the top left; click it to type a position. Each panel has buttons to make
it fill the view or to open it in a new window, and the 3-D panel has
switches along its bottom: **Sections**, and **Volume** when the Volume
rendering plugin is on.

Neuroglancer's mouse controls apply: drag to pan, scroll to move through
sections, ++ctrl++ + scroll to zoom, drag in 3-D to rotate, and
++shift++ + drag to rotate a cross-section to any angle.

## 4. Right dock: Layer

The selected dataset's controls, as Neuroglancer's own layer tabs at full
height. A header names the dataset and, when it is shown through several
layers, lets you pick which one.

| Tab | What it holds |
|---|---|
| **Source** | Where the data comes from, its parts (subsources), and its **transform**: the matrix that places it in the scene, editable. |
| **Render** | How it is drawn: resolution, opacity, blending, and for images the shader (colormap and contrast, with a histogram). |
| **Segments** | For segmentations: search segments by id, label or property, show and hide them, colours. |
| **Annotations** | For annotation layers: the tools that draw points, lines, boxes, ellipsoids and polylines, and the list of annotations. |
| **Schema** | For annotation layers: the properties each annotation carries. |

## 5. Bottom dock

| Tab | What it holds |
|---|---|
| **Activity** | A log of what the workspace did, newest first: datasets added, plugins started, errors. |
| **Jobs** | Long tasks from plugins (filters, statistics, saving), with progress and a cancel button. |
| **Chunk statistics** | Neuroglancer's chunk statistics: what is being downloaded, from where, and how fast. |
| **Python** | A Python console running in the page (Pyodide). `ngp` drives the workspace; `await ngp.show(array, voxel_size=…)` shows a numpy array as a layer. |
