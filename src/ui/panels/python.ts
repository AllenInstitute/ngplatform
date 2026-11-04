/**
 * The Python tab: a Python console (Pyodide, CPython compiled to
 * WebAssembly) running in this page, loaded the first time the tab opens.
 * `ngp` drives the workspace: the scene's Neuroglancer state as a dict, its
 * layers, the position, and every command in the palette; arrays made here
 * show as layers (ngp.show).  numpy, scipy and the other Pyodide packages
 * load when imported.
 */
import { clear, h } from "../dom.js";
import type { Workbench } from "../workbench.js";

// The same Pyodide as chunkmirage's engine (vendor/chunkmirage/web/src/pyworker.ts), so the browser fetches and caches one.
const PYODIDE = "https://cdn.jsdelivr.net/pyodide/v0.28.3/full/";

interface PyProxyLike {
  (...args: unknown[]): Promise<unknown>;
}
interface Pyodide {
  version: string;
  runPythonAsync(code: string): Promise<unknown>;
  loadPackagesFromImports(code: string, options?: { messageCallback?: (m: string) => void }): Promise<void>;
  registerJsModule(name: string, module: object): void;
  setStdout(options: { batched: (text: string) => void }): void;
  setStderr(options: { batched: (text: string) => void }): void;
  globals: { get(name: string): PyProxyLike };
}

// What `ngp` is, in Python.  The bridge passes JSON strings both ways.
export const PRELUDE = `
import json as _json
from contextlib import contextmanager as _contextmanager
import _ngp_bridge as _bridge

class _Workspace:
    """The workspace: ngp.state(), ngp.set_state(d), with ngp.txn() as s: …,
    ngp.layers(), ngp.add_layer(url), await ngp.show(array),
    await ngp.show_points(xyz), await ngp.show_lines(lines),
    await ngp.show_mesh(vertices, faces), ngp.annotate(points=…), ngp.position,
    @ngp.command(title), @ngp.panel(title),
    await ngp.invoke(id, args), ngp.commands(), and ngp.viewer (Neuroglancer's
    JavaScript viewer)."""

    def state(self):
        """This scene's Neuroglancer state, as a dict."""
        return _json.loads(_bridge.getState())

    def set_state(self, state):
        """Replaces this scene's Neuroglancer state."""
        _bridge.setState(_json.dumps(state))

    @_contextmanager
    def txn(self):
        """Edits the state in place, applied when the block ends:
        with ngp.txn() as s: s["layout"] = "xy" """
        state = self.state()
        yield state
        self.set_state(state)

    def layers(self):
        """The names of this scene's layers."""
        return _json.loads(_bridge.layers())

    def layer(self, name):
        """A layer's specification, as a dict."""
        return next((l for l in self.state().get("layers", []) if l.get("name") == name), None)

    def add_layer(self, source, name=None, kind=None):
        """Adds a dataset by URL (any source Neuroglancer reads); returns its layer's name."""
        return _bridge.addLayer(source, name or "", kind or "auto")

    async def show(self, array, name="array", voxel_size=(1.0, 1.0, 1.0), origin=(0.0, 0.0, 0.0), labels=False):
        """Shows a numpy array, indexed [x, y, z] (or [x, y] or [x, y, z, t]), as a layer:
        an image, or with labels=True a segmentation.  voxel_size and origin (the
        first voxel's centre) are in millimetres.  Returns the layer's name:
            layer = await ngp.show(np.random.rand(64, 64, 64), voxel_size=(0.5, 0.5, 2))"""
        import numpy as np
        from pyodide.ffi import to_js
        a = np.asarray(array)
        if a.ndim == 2:
            a = a[:, :, None]
        if a.ndim not in (3, 4):
            raise ValueError("an array of 2 to 4 dimensions: [x, y], [x, y, z] or [x, y, z, t]")
        if a.dtype == np.bool_:
            a = a.astype(np.uint8)
        codes = {"uint8": 2, "int16": 4, "int32": 8, "float32": 16, "float64": 64, "int8": 256, "uint16": 512, "uint32": 768, "int64": 1024, "uint64": 1280}
        if a.dtype.name not in codes:
            a = a.astype(np.float32)
        header = _nifti_header(a, codes[a.dtype.name], voxel_size, origin, 1002 if labels else 0, f"ngp.show: {name}")
        data = header + np.asfortranarray(a.astype(a.dtype.newbyteorder("<"), copy=False)).tobytes(order="F")
        return await _bridge.showFile(f"{name}.nii", to_js(data), name, "segmentation" if labels else "image")

    async def show_points(self, xyz, name="points", values=None):
        """Shows points (an N × 3 array of x, y, z in millimetres) as a layer, each
        point an object; values: {name: N values} shown and filtered per point.
            await ngp.show_points(np.random.rand(1000, 3) * 50, values={"size": np.arange(1000)})"""
        import io
        import numpy as np
        p = np.asarray(xyz, dtype=np.float64)
        if p.ndim != 2 or p.shape[1] != 3:
            raise ValueError("points as an N x 3 array of x, y, z")
        columns = {k: np.asarray(v, dtype=np.float64).ravel() for k, v in (values or {}).items()}
        for k, v in columns.items():
            if len(v) != len(p):
                raise ValueError(f"{k}: {len(v)} values for {len(p)} points")
        table = np.column_stack([p] + list(columns.values())) if columns else p
        out = io.StringIO()
        np.savetxt(out, table, delimiter=",", header=",".join(["x_mm", "y_mm", "z_mm"] + [str(k) for k in columns]), comments="", fmt="%.9g")
        return await self._show_bytes(f"{name}.csv", out.getvalue().encode(), name)

    async def show_lines(self, lines, name="lines"):
        """Shows polylines (a list of M × 3 arrays, millimetres) as streamlines, each
        line an object, as a tractogram would be:
            await ngp.show_lines([np.cumsum(np.random.randn(100, 3), 0) for _ in range(50)])"""
        import numpy as np
        tracks = [np.asarray(l, dtype="<f4").reshape(-1, 3) for l in lines]
        body = bytearray()
        for t in tracks:
            body += t.tobytes() + np.full(3, np.nan, "<f4").tobytes()
        body += np.full(3, np.inf, "<f4").tobytes()
        head = f"mrtrix tracks\\ndatatype: Float32LE\\ncount: {len(tracks)}\\nfile: . {{}}\\nEND\\n"
        offset = len(head.format(0)) + 8
        header = head.format(offset).encode().ljust(offset, b"\\0")
        return await self._show_bytes(f"{name}.tck", bytes(header) + bytes(body), name)

    async def show_mesh(self, vertices, faces, name="mesh"):
        """Shows a triangle mesh (vertices N × 3 in millimetres, faces M × 3 vertex
        indices), as a mesh file would be:
            await ngp.show_mesh(v, f)"""
        import numpy as np
        v = np.asarray(vertices, dtype="<f4").reshape(-1, 3)
        f = np.asarray(faces, dtype="<i4").reshape(-1, 3)
        if f.size and (f.min() < 0 or f.max() >= len(v)):
            raise ValueError("a face names a vertex the mesh does not have")
        head = (f"ply\\nformat binary_little_endian 1.0\\nelement vertex {len(v)}\\nproperty float x\\nproperty float y\\nproperty float z\\n"
                f"element face {len(f)}\\nproperty list uchar int vertex_indices\\nend_header\\n").encode()
        rows = np.zeros(len(f), dtype=[("n", "u1"), ("i", "<i4", 3)])
        rows["n"] = 3
        rows["i"] = f
        return await self._show_bytes(f"{name}.ply", head + v.tobytes() + rows.tobytes(), name)

    async def _show_bytes(self, file_name, data, name):
        from pyodide.ffi import to_js
        return await _bridge.showFile(file_name, to_js(bytes(data)), name, "auto")

    def annotate(self, points=(), lines=(), boxes=(), ellipsoids=(), name="annotations", descriptions=None):
        """Adds an annotation layer (kept in the workspace, editable in the views),
        in the views' coordinates (as ngp.position):
            points: [p, …]; lines: [(a, b), …]; boxes: [(corner, corner), …];
            ellipsoids: [(centre, radii), …]; descriptions: one text per annotation, in that order.
        Returns the layer's name."""
        def xyz(v):
            return [float(x) for x in v]
        made = [{"type": "point", "point": xyz(p)} for p in points]
        made += [{"type": "line", "pointA": xyz(a), "pointB": xyz(b)} for a, b in lines]
        made += [{"type": "axis_aligned_bounding_box", "pointA": xyz(a), "pointB": xyz(b)} for a, b in boxes]
        made += [{"type": "ellipsoid", "center": xyz(c), "radii": xyz(r)} for c, r in ellipsoids]
        for i, a in enumerate(made):
            a["id"] = f"py{i}"
            if descriptions is not None and i < len(descriptions) and descriptions[i]:
                a["description"] = str(descriptions[i])
        with self.txn() as s:
            taken = {l.get("name") for l in s.get("layers", [])}
            layer, k = name, 2
            while layer in taken:
                layer, k = f"{name} {k}", k + 1
            dims = s.get("dimensions", {})
            s.setdefault("layers", []).append({"type": "annotation", "name": layer, "source": {"url": "local://annotations", "transform": {"outputDimensions": dims}}, "annotations": made})
        return layer

    @property
    def position(self):
        return _json.loads(_bridge.position())

    @position.setter
    def position(self, value):
        _bridge.setPosition(_json.dumps([float(v) for v in value]))

    async def invoke(self, command, args=None):
        """Runs a command from the palette by id, e.g. await ngp.invoke("scene.new")."""
        return _json.loads(await _bridge.invoke(command, _json.dumps(args or {})))

    def commands(self):
        """Every command: {id: title}."""
        return _json.loads(_bridge.commands())

    @property
    def viewer(self):
        return _bridge.viewer()

    def panel(self, title, id=None, slot="left"):
        """Adds a tab (slot "left", "right" or "bottom") drawn by a function given the
        tab's element, when shown and again whenever the workspace changes:
        @ngp.panel("My tab")
        def draw(host): host.textContent = f"{len(ngp.layers())} layers"
        """
        def register(function):
            _bridge.registerPanel(id or function.__name__, title, slot, function)
            return function
        return register

    def command(self, title, id=None):
        """Adds a function to the command palette:
        @ngp.command("Count my layers")
        def count(): print(len(ngp.layers()))"""
        def register(function):
            _bridge.registerCommand(id or f"python.{function.__name__}", title, function)
            return function
        return register

    def __repr__(self):
        return "<ngp: the workspace. help(ngp) lists what it does.>"

def _nifti_header(a, datatype, voxel_size, origin, intent, description):
    """A NIfTI-1 header (352 bytes, "n+1") for an array in x-fastest order: sform and qform to millimetres."""
    import struct
    v = [float(x) for x in voxel_size]
    o = [float(x) for x in origin]
    dims = list(a.shape) + [1] * (7 - a.ndim)
    h = bytearray(352)
    struct.pack_into("<i", h, 0, 348)
    struct.pack_into("<8h", h, 40, a.ndim, *dims)
    struct.pack_into("<h", h, 68, intent)
    struct.pack_into("<hh", h, 70, datatype, a.dtype.itemsize * 8)
    struct.pack_into("<8f", h, 76, 1.0, *v, 1.0, 1.0, 1.0, 1.0)
    struct.pack_into("<f", h, 108, 352.0)
    h[123] = 2 | 8  # millimetres, seconds
    h[148:148 + 79] = description.encode()[:79].ljust(79, bytes(1))
    struct.pack_into("<hh", h, 252, 2, 2)  # qform and sform: aligned
    struct.pack_into("<3f", h, 268, *o)
    for r in range(3):
        row = [v[r] if c == r else 0.0 for c in range(3)] + [o[r]]
        struct.pack_into("<4f", h, 280 + 16 * r, *row)
    h[344:348] = b"n+1" + bytes(1)
    return bytes(h)

ngp = _Workspace()

async def _ngp_run(source):
    from pyodide.code import eval_code_async
    value = await eval_code_async(source, globals())
    return None if value is None else repr(value)
`;

let pyodide: Promise<Pyodide> | undefined;

/** Commands that Python code added, by the plugin (or "console") that added them. */
const pythonCommands = new Map<string, Map<string, () => void>>();
let pythonOwner = "console";

/** Removes what a Python plugin added (before it runs again, or when it is removed). */
export function forgetPython(owner: string): void {
  for (const dispose of pythonCommands.get(owner)?.values() ?? []) dispose();
  pythonCommands.delete(owner);
}

/** Runs a Python plugin's source as `owner`; its @ngp.command functions join the palette. */
export async function runPythonPlugin(wb: Workbench, owner: string, source: string): Promise<void> {
  const py = await loadPython(wb);
  forgetPython(owner);
  pythonOwner = owner;
  try {
    await py.loadPackagesFromImports(source);
    await py.globals.get("_ngp_run")(source);
  } finally {
    pythonOwner = "console";
  }
}

/** Where printed output goes while the Python tab is open. */
let pythonSink: ((text: string, kind: "out" | "err") => void) | undefined;

export function loadPython(wb: Workbench): Promise<Pyodide> {
  pyodide ??= (async () => {
    const module = (await import(/* @vite-ignore */ `${PYODIDE}pyodide.mjs`)) as { loadPyodide(o: { indexURL: string }): Promise<Pyodide> };
    const py = await module.loadPyodide({ indexURL: PYODIDE });
    const { engine, store, commands } = wb;
    py.registerJsModule("_ngp_bridge", {
      getState: () => JSON.stringify(store.ng()),
      setState: (json: string) => {
        const next = JSON.parse(json) as Record<string, unknown>;
        store.patchState((ng) => {
          for (const key of Object.keys(ng)) delete (ng as Record<string, unknown>)[key];
          Object.assign(ng, next);
        });
      },
      layers: () => JSON.stringify(engine.layers().map((l) => l.name)),
      addLayer: (source: string, name: string, kind: string) => {
        const id = store.addDataset({ source, name: name || undefined, kind });
        return store.sceneDatasets().find((d) => d.dataset.id === id)?.layers[0] ?? "";
      },
      showFile: async (fileName: string, bytes: Uint8Array, name: string, kind: string) => {
        const [found] = await wb.localData.openFile(new File([bytes as BlobPart], fileName));
        if (found === undefined) throw new Error(`${fileName} could not be read`);
        const id = store.addDataset({ source: found.source, name, kind });
        return store.sceneDatasets().find((d) => d.dataset.id === id)?.layers[0] ?? "";
      },
      position: () => JSON.stringify(engine.navigation().position),
      setPosition: (json: string) => engine.setPosition(JSON.parse(json)),
      invoke: async (id: string, args: string) => JSON.stringify((await commands.invoke(id, JSON.parse(args))) ?? null),
      commands: () => JSON.stringify(Object.fromEntries(commands.list().map((c) => [c.id, c.title]))),
      viewer: () => engine.viewer,
      registerCommand: (given: string, title: string, fn: { (): unknown; destroy?(): void; copy?(): typeof fn }) => {
        const owner = pythonOwner;
        // A plugin's default ids are its own (python.<plugin>.<function>), so two plugins' hello() do not clash.
        const id = owner !== "console" && given.startsWith("python.") ? `python.${owner.replace(/[^A-Za-z0-9_-]/g, "_")}.${given.slice(7)}` : given;
        const own = pythonCommands.get(owner) ?? new Map<string, () => void>();
        pythonCommands.set(owner, own);
        own.get(id)?.();
        // Pyodide destroys a function proxy after the call that passed it unless it is copied.
        const kept = fn.copy?.() ?? fn;
        const off = commands.register({
          id,
          title,
          group: owner === "console" ? "Python" : `Python: ${owner}`,
          run: async () => {
            try {
              await kept();
            } catch (e) {
              wb.log.add(`${title}: ${(e as Error).message}`, "error", "Python");
            }
          },
        });
        own.set(id, () => {
          off();
          kept.destroy?.();
        });
      },
      registerPanel: (id: string, title: string, slot: string, fn: { (host: HTMLElement): unknown; destroy?(): void; copy?(): typeof fn }) => {
        const owner = pythonOwner;
        const own = pythonCommands.get(owner) ?? new Map<string, () => void>();
        pythonCommands.set(owner, own);
        const tab = `python.${owner}.${id}`.replace(/[^A-Za-z0-9_.-]/g, "_");
        own.get(tab)?.();
        const kept = fn.copy?.() ?? fn;
        const off = wb.docks.addTab({
          id: tab,
          title,
          slot: (["left", "right", "bottom"].includes(slot) ? slot : "left") as "left" | "right" | "bottom",
          order: 95,
          owner: owner === "console" ? "python" : `python:${owner}`,
          // Drawn when shown, and again (a moment later) whenever the workspace changes.
          render: (host) => {
            const draw = () => {
              try {
                host.replaceChildren();
                kept(host);
              } catch (e) {
                host.textContent = `${title}: ${(e as Error).message}`;
              }
            };
            draw();
            let timer: ReturnType<typeof setTimeout> | undefined;
            const offChange = store.onChange(() => {
              clearTimeout(timer);
              timer = setTimeout(draw, 150);
            });
            return () => {
              clearTimeout(timer);
              offChange();
            };
          },
        });
        own.set(tab, () => {
          off();
          kept.destroy?.();
        });
      },
    });
    await py.runPythonAsync(PRELUDE);
    // Printed output goes to the Python tab when it is open, else to the Activity tab (a command's print, say).
    py.setStdout({ batched: (t) => (pythonSink ? pythonSink(t, "out") : wb.log.add(t, "info", "Python")) });
    py.setStderr({ batched: (t) => (pythonSink ? pythonSink(t, "err") : wb.log.add(t, "error", "Python")) });
    return py;
  })();
  pyodide.catch(() => (pyodide = undefined));
  return pyodide;
}

export function renderPythonPanel(host: HTMLElement, wb: Workbench): () => void {
  const out = h("div", { class: "py-out", role: "log", "aria-live": "polite" });
  const input = h("textarea", {
    class: "py-in",
    rows: 1,
    spellcheck: "false",
    placeholder: "Enter runs · Shift+Enter: new line · ↑ ↓: history",
    "aria-label": "Python input",
    disabled: true,
  });
  const prompt = h("span", { class: "py-prompt" }, ">>>");
  host.append(out, h("div", { class: "py-line" }, prompt, input));
  host.classList.add("py-host");

  const print = (text: string, kind: "in" | "out" | "err" | "result" | "note" = "out") => {
    const atEnd = out.scrollTop + out.clientHeight >= out.scrollHeight - 4;
    out.append(h("pre", { class: `py-${kind}` }, text));
    if (atEnd || kind === "in") out.scrollTop = out.scrollHeight;
  };
  const fit = () => {
    input.style.height = "auto";
    input.style.height = `${input.scrollHeight}px`;
  };

  const history: string[] = [];
  let cursor = 0;
  let python: Pyodide | undefined;
  let running = false;

  const run = async (code: string) => {
    if (python === undefined || running) return;
    running = true;
    input.disabled = true;
    print(code.replace(/^/gm, (_m, i: number) => (i === 0 ? ">>> " : "... ")), "in");
    try {
      await python.loadPackagesFromImports(code, { messageCallback: (m) => print(m, "note") });
      const value = (await python.globals.get("_ngp_run")(code)) as string | undefined;
      if (value !== undefined && value !== null) print(value, "result");
    } catch (e) {
      const message = String((e as Error).message ?? e);
      // Keep the traceback from the user's code on: Pyodide's own frames say nothing useful.
      const lines = message.split("\n");
      const start = lines.findIndex((l) => l.includes('File "<exec>"'));
      print(start > 0 ? ["Traceback (most recent call last):", ...lines.slice(start)].join("\n") : message, "err");
    } finally {
      running = false;
      input.disabled = false;
      input.focus();
    }
  };

  input.addEventListener("input", fit);
  input.addEventListener("keydown", (e) => {
    const value = input.value;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (value.trim() === "") return;
      history.push(value);
      cursor = history.length;
      input.value = "";
      fit();
      void run(value);
    } else if (e.key === "ArrowUp" && !value.slice(0, input.selectionStart).includes("\n") && cursor > 0) {
      e.preventDefault();
      input.value = history[--cursor];
      fit();
    } else if (e.key === "ArrowDown" && !value.slice(input.selectionEnd).includes("\n") && cursor < history.length) {
      e.preventDefault();
      cursor++;
      input.value = history[cursor] ?? "";
      fit();
    } else if (e.key === "l" && e.ctrlKey) {
      e.preventDefault();
      clear(out);
    }
  });

  let disposed = false;
  const start = () => {
    clear(out);
    print("Loading Python…", "note");
    loadPython(wb).then(
      (py) => {
        if (disposed) return;
        python = py;
        pythonSink = print;
        clear(out);
        print(`Python (Pyodide ${py.version}), in this page. ngp is the workspace: help(ngp) lists what it does. Packages load when imported; Ctrl+L clears.`, "note");
        input.disabled = false;
        input.focus();
      },
      (e) => {
        if (disposed) return;
        clear(out);
        print(`Python did not load from ${PYODIDE}: ${(e as Error).message}. Check the connection, then try again.`, "err");
        out.append(h("button", { class: "btn small py-retry", type: "button", onclick: start }, "Try again"));
      },
    );
  };
  start();
  return () => {
    disposed = true;
    if (pythonSink === print) pythonSink = undefined;
    host.classList.remove("py-host");
  };
}
