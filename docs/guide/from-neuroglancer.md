# Coming from Neuroglancer

Everything you know about Neuroglancer still applies: the views, the mouse
and keyboard, layer types, sources and shaders are Neuroglancer's own.
ngplatform moves the controls around the views and adds a workspace.

| In Neuroglancer | In ngplatform |
|---|---|
| The layer bar along the top | the **Layers** panel in the left dock: one row per dataset |
| The layer side panel | the selected layer's controls, below the list in the **Layers** panel (Neuroglancer's own Display, Source and other tabs) |
| The state in the URL | still in the URL, now holding every scene; **Share** copies a plain Neuroglancer link to one scene |
| One state per tab | several **scenes** in one workspace, as tabs in the top bar |
| Settings, screenshot, help | the gear (**Settings**), camera (**Capture**) and **?** icons in the top bar |
| Keyboard shortcuts | the same, plus a command palette (++ctrl+k++) |

**Going back is always one click:** the **Neuroglancer** button opens the
current scene in Google's Neuroglancer. Datasets plain Neuroglancer cannot
read (Zarr Vectors, files on your computer) are flagged when you do; this
site's own `neuroglancer.html` reads Zarr Vectors.

What the workspace adds: datasets shared between scenes, files from your
computer read in place, undo across the whole workspace, plugins, and a
Python console (the **Python** panel in the Activity dock).
