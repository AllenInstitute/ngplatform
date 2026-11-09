# Starter (Python)

A plugin in Python, to copy: [`starter.py`](starter.py). It runs in the
page's own Python (Pyodide), with nothing to install or build.

To try it: the app's Plugins panel, **Add**, choose `starter.py`. Its
panel (*Starter (Python)*, in the Tools dock under *Python*) and its two
commands (in the command palette, Ctrl+K) appear; edit the file and press **Reload** to run it again. In
Chrome and Edge the file is remembered between visits.

What a Python plugin has:

| | |
|---|---|
| `ngp` | The workspace: `ngp.state()` and `ngp.txn()` (the scene's Neuroglancer state), `ngp.layers()`, `ngp.position`, `await ngp.invoke(command)`; `help(ngp)` lists it all |
| `@ngp.command("Title")` | Adds the function below it to the command palette (it may be `async`) |
| `@ngp.panel("Title", group="Python")` | Adds a panel to the Tools dock, listed under `group`, drawn by the function below it, given the panel's element: when the panel is shown and whenever the workspace changes (`slot="bottom"` puts it in the bottom dock instead) |
| `await ngp.show(array)` | Shows a numpy array as an image (or, `labels=True`, a segmentation) |
| `await ngp.show_points(xyz)`, `show_lines(lines)`, `show_mesh(vertices, faces)` | Shows points, streamlines and meshes made in Python as Zarr Vectors layers |
| `ngp.annotate(points=…, lines=…, boxes=…, ellipsoids=…)` | Adds an annotation layer |
| `from js import document` | The page itself (Pyodide's `js` module), for drawing a panel with the app's classes (`empty`, `list`, `row`, `hint`) |

Packages it imports (numpy, scipy, scikit-image, pandas …) load when it
runs. The TypeScript starter, for plugins built into the app, is
[`../starter_ts`](../starter_ts).
