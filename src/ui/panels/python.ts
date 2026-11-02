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

const PYODIDE = "https://cdn.jsdelivr.net/pyodide/v0.27.7/full/";

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
const PRELUDE = `
import json as _json
from contextlib import contextmanager as _contextmanager
import _ngp_bridge as _bridge

class _Workspace:
    """The workspace: ngp.state(), ngp.set_state(d), with ngp.txn() as s: …,
    ngp.layers(), ngp.add_layer(url), await ngp.show(array), ngp.position,
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
      registerCommand: (id: string, title: string, fn: { (): unknown; destroy?(): void; copy?(): typeof fn }) => {
        const owner = pythonOwner;
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
    });
    await py.runPythonAsync(PRELUDE);
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
    placeholder: "Python. Enter runs, Shift+Enter adds a line, ↑ and ↓ go through history.",
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
  print("Loading Python…", "note");
  loadPython(wb).then(
    (py) => {
      if (disposed) return;
      python = py;
      py.setStdout({ batched: (t) => print(t, "out") });
      py.setStderr({ batched: (t) => print(t, "err") });
      clear(out);
      print(
        `Python (Pyodide ${py.version}), running in this page. ngp is the workspace: ngp.state(), ngp.set_state(d), ` +
          `with ngp.txn() as s: …, ngp.layers(), ngp.add_layer(url), await ngp.show(array), ngp.position, await ngp.invoke(id, args), ngp.commands(). ` +
          `Packages such as numpy load when imported. Ctrl+L clears.`,
        "note",
      );
      input.disabled = false;
      input.focus();
    },
    (e) => {
      clear(out);
      print(`Python did not load: ${(e as Error).message}. It comes from ${PYODIDE}; check the connection and reopen this tab.`, "err");
    },
  );
  return () => {
    disposed = true;
    host.classList.remove("py-host");
  };
}
