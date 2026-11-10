"""A starter plugin in Python (see README.md beside it): load it in the app
with Plugins -> Add (no build needed), edit it, and press Reload.  It runs
in the page's Python (Pyodide), where `ngp` is the workspace: its state,
layers, position and commands, numpy arrays and points shown as layers
(help(ngp) lists it all).
Packages it imports (numpy, scipy, scikit-image ...) load when it runs.

    @ngp.command("Title")   adds a function to the command palette
    @ngp.panel("Title")     adds a panel to the Tools dock (under "Python", or
                            group="..."), drawn by a function given the
                            panel's element, when shown and whenever the
                            workspace changes (the page's DOM is reachable
                            through `js`)
"""
from js import document


@ngp.command("Starter (Python): say hello")
def hello():
    print(f"Hello from Python: {len(ngp.layers())} layers in this scene, at {ngp.position}.")


@ngp.command("Starter (Python): show a random point cloud")
async def points():
    import numpy as np
    xyz = np.random.default_rng(0).normal(0, 20, (500, 3))
    await ngp.show_points(xyz, name="random points", values={"distance": np.linalg.norm(xyz, axis=1)})


@ngp.panel("Starter (Python)", group="Python")
def draw(host):
    layers = ngp.layers()
    if not layers:
        empty = document.createElement("p")
        empty.className = "empty"
        empty.textContent = "No layers in this scene."
        host.append(empty)
        return
    items = document.createElement("ul")
    items.className = "list"
    for name in layers:
        item = document.createElement("li")
        item.textContent = name
        items.append(item)
    host.append(items)
