/**
 * The Registration class and its panel, against a context that holds only
 * what they use (a viewer with layers, transforms, a global space and
 * annotation layers; the plugin's state; a worker that answers as told):
 * marking pairs, refitting, Live and Apply, the volumes that follow, undo,
 * warping, saving, transform files, and the panel kept up to date in place.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Json, LayerTransform, PlatformContext } from "@ngplatform/sdk";
import { type FakeDom, fakeDocument } from "@ngplatform/sdk/testing";
import { notOffered, Registration, type Saved, type SaveWorker } from "../plugin.js";
import { finestThatFits, saveBytes } from "../volume_io.js";

const MM = 1e-3;
const identity = () => Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** A layer of the fake viewer: a 1 mm, 100-voxel cube at the origin unless said otherwise. */
interface FakeLayer {
  name: string;
  type: string;
  visible: boolean;
  rank: number;
  source: string;
  matrix: Float64Array;
}

function transformOf(l: FakeLayer): LayerTransform {
  const n = l.rank;
  const names = ["x", "y", "z", "t"].slice(0, n);
  return {
    rank: n,
    input: { names, scales: names.map(() => MM), units: names.map(() => "m"), bounds: { lower: names.map(() => 0), upper: names.map(() => 100) } },
    output: { names, scales: names.map(() => MM), units: names.map(() => "m") },
    matrix: l.matrix,
    defaultMatrix: identity(),
  } as unknown as LayerTransform;
}

function fakeContext() {
  const layers: FakeLayer[] = [];
  const ng: { dimensions: Record<string, [number, string]>; position: number[]; layers: Json[] } = {
    dimensions: { x: [MM, "m"], y: [MM, "m"], z: [MM, "m"] },
    position: [50, 50, 50],
    layers: [],
  };
  let state: unknown;
  let cursor: number[] | undefined;
  const listeners = { state: new Set<() => void>(), layers: new Set<() => void>(), ng: new Set<() => void>() };
  const fire = (set: Set<() => void>) => [...set].forEach((f) => f());
  const panels = new Map<string, (host: HTMLElement) => (() => void) | void>();
  const commands = new Map<string, () => unknown>();
  const invoked: string[] = [];
  const subscriptions: (() => void)[] = [];
  const ctx = {
    viewer: {
      layers: () => layers.map((l) => ({ name: l.name, type: l.type, visible: l.visible })),
      layerTransform: (name: string) => {
        const l = layers.find((x) => x.name === name);
        return l && transformOf(l);
      },
      setLayerTransform: (name: string, m: Float64Array) => {
        layers.find((x) => x.name === name)!.matrix = Float64Array.from(m);
        fire(listeners.ng);
      },
      layerSpec: (name: string) => {
        const l = layers.find((x) => x.name === name);
        return l && { type: l.type, source: l.source };
      },
      getState: () => ng,
      patchState: (edit: (s: Json) => void) => {
        edit(ng as unknown as Json);
        fire(listeners.ng);
      },
      onStateChanged: (f: () => void) => (listeners.ng.add(f), () => listeners.ng.delete(f)),
      onLayersChanged: (f: () => void) => (listeners.layers.add(f), () => listeners.layers.delete(f)),
      cursor: () => ({ active: cursor !== undefined, position: cursor ?? [], names: ["x", "y", "z"], units: ["m", "m", "m"], values: {} }),
      setPosition: vi.fn((p: number[]) => void (ng.position = [...p])),
    },
    state: {
      get: () => state,
      set: (v: unknown) => ((state = JSON.parse(JSON.stringify(v))), fire(listeners.state)),
      onChanged: (f: () => void) => (listeners.state.add(f), () => listeners.state.delete(f)),
    },
    settings: { get: () => undefined, set: vi.fn() },
    ui: {
      panel: (id: string, render: (host: HTMLElement) => (() => void) | void) => (panels.set(id, render), () => panels.delete(id)),
      showPanel: vi.fn(),
      toast: vi.fn(),
      confirm: vi.fn(async () => true),
    },
    commands: {
      register: (id: string, run: () => unknown) => (commands.set(id, run), () => commands.delete(id)),
      invoke: async (id: string) => void invoked.push(id),
    },
    log: { info: vi.fn() },
    workspace: { computed: { url: vi.fn(async () => "computed://warped") }, addDataset: vi.fn() },
    subscriptions,
  };
  return {
    ctx: ctx as unknown as PlatformContext,
    raw: ctx,
    ng,
    panels,
    commands,
    invoked,
    saved: () => state as Saved,
    matrix: (name: string) => layers.find((l) => l.name === name)!.matrix,
    add(name: string, o: Partial<FakeLayer> = {}) {
      layers.push({ name, type: "image", visible: true, rank: 3, source: `zarr://https://example.org/${name}.ome.zarr`, matrix: identity(), ...o });
      fire(listeners.layers);
    },
    /** The mouse over the views at this global position (mm), or off them. */
    point(at?: number[]) {
      cursor = at;
    },
    dispose: () => subscriptions.forEach((d) => d()),
  };
}

/** A worker answering each request with `answer` (which may wait for the request's signal). */
function fakeWorker(answer: (message: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>) {
  const requests: Record<string, unknown>[] = [];
  const worker: SaveWorker = {
    request: <T>(message: object, _progress?: unknown, signal?: AbortSignal) => {
      requests.push(message as Record<string, unknown>);
      return answer(message as Record<string, unknown>, signal) as Promise<T>;
    },
    dispose: vi.fn(),
  };
  return { worker, requests };
}

/** Lets the promises waiting settle. */
const settle = async () => {
  for (let i = 0; i < 20; ++i) await Promise.resolve();
};

describe("what Registration can move, and the memory a save needs", () => {
  it("says why a layer is not offered", () => {
    expect(notOffered([{ name: "brain", type: "image", rank: 3 }])).toBe("");
    expect(
      notOffered([
        { name: "movie", type: "image", rank: 4 },
        { name: "section", type: "segmentation", rank: 2 },
        { name: "notes", type: "annotation", rank: 3 },
        { name: "loading", type: "image" },
      ]),
    ).toBe("“movie” is 4-D, “section” is 2-D");
  });

  it("counts the source, the output, the file and cubic's coefficients", () => {
    const n = 100 ** 3;
    expect(saveBytes(n, n, 1, "linear", false)).toBe(3 * n);
    // Cubic's 64-bit coefficients: eight bytes a source voxel, eight times a uint8 source.
    expect(saveBytes(n, n, 1, "cubic", false)).toBe(11 * n);
    expect(saveBytes(n, 8 * n, 2, "nearest", false)).toBe(2 * n + 32 * n);
    expect(saveBytes(n, n, 4, "cubic", true)).toBe(8 * n);
  });

  it("takes the finest level that fits, else the coarsest", () => {
    expect(finestThatFits([900, 300, 100], 512)).toBe(1);
    expect(finestThatFits([400, 100], 512)).toBe(0);
    expect(finestThatFits([2000, 1000], 512)).toBe(1);
  });
});

describe("the Registration panel", () => {
  let dom: FakeDom;
  beforeEach(() => {
    dom = fakeDocument();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    dom.restore();
  });

  /** The plugin activated with `worker`, its panel drawn, and "brain" chosen as the moving layer when there is one and none is yet. */
  async function open(f: ReturnType<typeof fakeContext>, worker?: SaveWorker) {
    const registration = new Registration(f.ctx, worker && (() => worker));
    f.raw.commands.register("registration.fixedHere", () => registration.mark("fixed"));
    f.raw.commands.register("registration.movingHere", () => registration.mark("moving"));
    const host = dom.host();
    const dispose = registration.render(host);
    const layer = host.querySelector<HTMLSelectElement>('select[aria-label="Moving layer"]')!;
    if (layer.value === "" && f.ctx.viewer.layerTransform("brain")) {
      layer.value = "brain";
      dom.fire(layer, "change");
    }
    return { registration, host, dispose };
  }

  const number = (host: HTMLElement, label: string) => host.querySelector<HTMLInputElement>(`input.num-input[aria-label="${label}"]`)!;
  const button = (host: HTMLElement, label: string) => dom.find<HTMLButtonElement>(host, "button", label);
  const card = (host: HTMLElement, id: string) => host.querySelector<HTMLDetailsElement>(`details[data-card="${id}"]`)!;
  const mark = (f: ReturnType<typeof fakeContext>, role: "fixed" | "moving", at: number[]) => {
    f.point(at);
    f.commands.get(role === "fixed" ? "registration.fixedHere" : "registration.movingHere")!();
  };

  it("shows only the empty state, with its action, when there is nothing to move", async () => {
    const f = fakeContext();
    f.add("movie", { rank: 4 });
    const { host } = await open(f);
    const empty = host.querySelector<HTMLElement>(".empty-state")!;
    expect(dom.text(host)).toBe("No 3-D layer to move: “movie” is 4-D. Open data…");
    button(host, "Open data…").click();
    expect(f.invoked).toEqual(["dataset.add"]);

    f.add("brain");
    expect(dom.text(host)).not.toContain("No 3-D layer");
    expect(empty.isConnected).toBe(true);
    expect(host.querySelector(".hint")!.textContent).toBe("Only 3-D layers can be moved: “movie” is 4-D.");
    expect(dom.text(host)).toContain("Transform");
  });

  it("is built of cards with stable ids, and the shared controls", async () => {
    const f = fakeContext();
    f.add("brain");
    const { host } = await open(f);
    expect(Array.from(host.querySelectorAll("details"), (d) => d.getAttribute("data-card"))).toEqual([
      "registration.transform",
      "registration.straighten",
      "registration.landmarks",
      "registration.transformFile",
      "registration.image",
    ]);
    expect(card(host, "registration.transform").open).toBe(true);
    // No private number boxes, radios or headings; every select in the shared field style; every on/off control the SDK's.
    expect(host.querySelectorAll(".rg-num, h3, input[type=radio]")).toEqual([]);
    expect(Array.from(host.querySelectorAll("select"), (s) => s.className).every((c) => c === "text-input")).toBe(true);
    expect(Array.from(host.querySelectorAll("input[type=checkbox]"), (c) => (c.parentNode as Element).className).every((c) => c === "choice")).toBe(true);
    expect(host.querySelectorAll(".slider").length).toBe(9);
  });

  it("updates in place: a typed angle moves the layer and the box keeps the keyboard", async () => {
    const f = fakeContext();
    f.add("brain");
    const { host } = await open(f);
    const cards = host.querySelectorAll("details");
    const x = number(host, "Translate X (L-R)");
    x.focus();
    x.value = "5";
    dom.fire(x, "change");
    expect(f.saved().manual.translate).toEqual([5, 0, 0]);
    expect(f.matrix("brain")[12]).toBeCloseTo(5, 9);
    // Nothing was drawn again: the box typed in is still there, and still has the keyboard (Tab goes on from it).
    expect(number(host, "Translate X (L-R)")).toBe(x);
    expect(dom.document.activeElement).toBe(x);
    expect(x.isConnected).toBe(true);
    expect(host.querySelectorAll("details")).toEqual(cards);
    // An undo while it is typed in waits until it is left.
    f.ctx.state.set({ ...f.saved(), manual: { ...f.saved().manual, translate: [0, 0, 0] } });
    expect(x.value).toBe("5");
    x.blur();
    expect(x.value).toBe("0");
  });

  it("marks pairs, fits them, and moves the layer with each one when Live", async () => {
    const f = fakeContext();
    f.add("brain");
    const { host } = await open(f);
    dom.find<HTMLSelectElement>(host, "select[aria-label=Model]").value = "translation";
    dom.fire(dom.find(host, "select[aria-label=Model]"), "change");
    mark(f, "fixed", [10, 20, 30]);
    expect(f.saved().pairs).toMatchObject([{ fixed: [10, 20, 30], on: true }]);
    mark(f, "moving", [12, 20, 30]);
    expect(f.saved().pairs[0].moving).toEqual([12, 20, 30]);
    // Live: moving onto fixed, 2 mm along -x.
    expect(f.matrix("brain")[12]).toBeCloseTo(-2, 9);
    expect(host.querySelector(".card-badge")!.textContent).toBe("1 pair");
    expect(dom.text(host.querySelector(".rg-pairs")!)).toContain("Fixed x, y, z (mm) Moving x, y, z (mm) Error 1 10.0, 20.0, 30.0");
    expect(dom.text(host)).toContain("RMS 0.00 mm");
    // The landmarks show in their annotation layers, the moving one where the layer now puts it.
    const fixed = f.ng.layers.find((l) => l.name === "landmarks (fixed)")!.annotations as Json[];
    const moving = f.ng.layers.find((l) => l.name === "landmarks (moving)")!.annotations as Json[];
    expect(fixed[0].point).toEqual([10, 20, 30]);
    expect(moving[0].point).toEqual([10, 20, 30]);
  });

  it("waits for Apply when Live is off, and leaves out a pair switched off", async () => {
    const f = fakeContext();
    f.add("brain");
    const { host } = await open(f);
    dom.find<HTMLSelectElement>(host, "select[aria-label=Model]").value = "translation";
    dom.fire(dom.find(host, "select[aria-label=Model]"), "change");
    dom.check(dom.find<HTMLInputElement>(host, "input[role=switch]"), false);
    expect(f.saved().live).toBe(false);
    const apply = button(host, "Apply");
    expect(apply.disabled).toBe(true);
    mark(f, "fixed", [0, 0, 0]);
    mark(f, "moving", [0, 0, 3]);
    expect(f.matrix("brain")[14]).toBe(0);
    expect(apply.disabled).toBe(false);
    apply.click();
    expect(f.matrix("brain")[14]).toBeCloseTo(-3, 9);
    // The pair switched off: too few pairs to fit, said in the panel.
    dom.check(dom.find<HTMLInputElement>(host, 'input[aria-label="Use pair 1"]'), false);
    expect(f.saved().pairs[0].on).toBe(false);
    expect(dom.text(host)).toContain("translation needs 1 complete pair; there are 0.");
    expect(apply.disabled).toBe(true);
  });

  it("moves the other visible volumes with it, and puts them back", async () => {
    const f = fakeContext();
    f.add("atlas");
    f.add("tracts", { source: "zarr-vectors://https://example.org/tracts.zarr" });
    f.add("hidden", { visible: false });
    f.add("brain");
    const { host } = await open(f);
    // The image added last is the moving one.
    expect(dom.find<HTMLSelectElement>(host, 'select[aria-label="Moving layer"]').value).toBe("brain");
    const all = dom.find(host, "label", "Apply to all visible volumes").querySelector<HTMLInputElement>("input")!;
    dom.check(all, true);
    expect(f.saved().all).toBe(true);
    dom.type(number(host, "Translate Y (P-A)"), "4");
    expect(f.matrix("brain")[13]).toBeCloseTo(4, 9);
    expect(f.matrix("atlas")[13]).toBeCloseTo(4, 9);
    // Geometry and hidden layers stay where they are.
    expect(f.matrix("tracts")[13]).toBe(0);
    expect(f.matrix("hidden")[13]).toBe(0);
    dom.check(all, false);
    expect(f.matrix("atlas")[13]).toBe(0);
    expect(f.matrix("brain")[13]).toBeCloseTo(4, 9);
  });

  it("follows an undo: the state put back is read again and shown", async () => {
    const f = fakeContext();
    f.add("brain");
    const { host } = await open(f);
    mark(f, "fixed", [1, 2, 3]);
    const before = f.saved();
    mark(f, "moving", [1, 2, 4]);
    expect(f.saved().pairs[0].moving).toBeDefined();
    f.ctx.state.set(before);
    expect(dom.text(host.querySelector(".rg-pairs")!)).toContain("—");
    expect(host.querySelector(".card-badge")!.textContent).toBe("1 pair");
    f.ctx.state.set({ ...before, pairs: [] });
    expect(host.querySelector(".rg-pairs")).toBeNull();
    expect(button(host, "Clear pairs").disabled).toBe(true);
  });

  it("goes to a pair, and reads back a landmark dragged in its layer", async () => {
    const f = fakeContext();
    f.add("brain");
    const { host } = await open(f);
    mark(f, "fixed", [10, 20, 30]);
    host.querySelector<HTMLButtonElement>('button[aria-label="Go to pair 1"]')!.click();
    expect(f.raw.viewer.setPosition).toHaveBeenLastCalledWith([10, 20, 30]);

    // Neuroglancer keeping the point as a 32-bit float is not a drag: nothing is written.
    const layer = f.ng.layers.find((l) => l.name === "landmarks (fixed)")!;
    const id = f.saved().pairs[0].id;
    const saved = JSON.stringify(f.saved());
    layer.annotations = [{ type: "point", id: `f${id}`, point: [10, 20, 30].map((v) => Math.fround(v + 1e-7)), description: "1" }];
    f.raw.viewer.patchState(() => {});
    vi.advanceTimersByTime(300);
    expect(JSON.stringify(f.saved())).toBe(saved);

    // Dragged 5 mm along z: the pair follows.
    layer.annotations = [{ type: "point", id: `f${id}`, point: [10, 20, 35], description: "1" }];
    f.raw.viewer.patchState(() => {});
    vi.advanceTimersByTime(300);
    expect(f.saved().pairs[0].fixed).toEqual([10, 20, 35]);
  });

  it("warps through four pairs or more, and says when there are too few", async () => {
    const f = fakeContext();
    f.add("brain");
    const { host } = await open(f);
    // Not Live: the moving points stay where they are marked.
    dom.check(dom.find<HTMLInputElement>(host, "input[role=switch]"), false);
    button(host, "Warp through the pairs").click();
    await settle();
    expect(dom.text(card(host, "registration.landmarks"))).toContain("A warp needs four complete pairs or more");
    for (const p of [
      [0, 0, 0],
      [10, 0, 0],
      [0, 10, 0],
      [0, 0, 10],
    ]) {
      mark(f, "fixed", p);
      mark(f, "moving", p.map((v) => v + 1));
    }
    button(host, "Warp through the pairs").click();
    await settle();
    const asked = f.raw.workspace.computed.url.mock.calls[0] as unknown as [{ source: string; warp: { kind: string; fixed: number[][]; moving: number[][] } }];
    expect(asked[0].source).toBe("zarr://https://example.org/brain.ome.zarr");
    expect(asked[0].warp.kind).toBe("tps");
    expect(asked[0].warp.fixed[1]).toEqual([10, 0, 0]);
    expect(asked[0].warp.moving[1]).toEqual([11, 1, 1]);
    expect(f.raw.workspace.addDataset).toHaveBeenCalledWith({ source: "computed://warped", name: "brain (warped, 4 pairs)", kind: "image" });
    // Done: nothing to report.
    expect(host.querySelectorAll(".status-line.error")).toEqual([]);
  });

  it("saves the image through the worker, and reports a failure with Retry", async () => {
    const f = fakeContext();
    f.add("brain");
    const created: Blob[] = [];
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockImplementation((b) => (created.push(b as Blob), "blob:x"));
    let fail = true;
    const { worker, requests } = fakeWorker(async () => {
      if (fail) throw new Error("it needs about 4 GiB of memory");
      return { files: [["image.nii.gz", new Uint8Array([1, 2, 3])]], level: 1, voxelSize: 2, size: [50, 50, 50] };
    });
    const { host } = await open(f, worker);
    dom.type(number(host, "Translate X (L-R)"), "5");
    button(host, "Save image…").click();
    await settle();
    expect(requests[0]).toMatchObject({ type: "save", store: "https://example.org/brain.ome.zarr/", header: false, method: "linear", format: "nii.gz", label: false, maxBytes: 512 * 2 ** 20 });
    expect((requests[0].move as number[])[3]).toBeCloseTo(5, 9);
    const status = card(host, "registration.image").querySelector<HTMLElement>(".status-line")!;
    expect(dom.text(status)).toBe("Could not save: it needs about 4 GiB of memory Retry");
    fail = false;
    dom.find(status, "button", "Retry").click();
    await settle();
    expect(created.length).toBe(1);
    expect(status.hidden).toBe(true);
    expect(f.raw.ui.toast).toHaveBeenLastCalledWith("Saved brain_registered.nii.gz: 50 × 50 × 50, level 1 (2 mm): the finest that fits in memory.");
    createObjectURL.mockRestore();
  });

  it("cancels a save, and removes the OME-Zarr folder it had started", async () => {
    const f = fakeContext();
    f.add("brain");
    const removed: string[] = [];
    const folder = {
      name: "out",
      getDirectoryHandle: async (name: string, o?: { create?: boolean }) => {
        if (!o?.create) throw new DOMException("not there", "NotFoundError");
        return folder;
      },
      removeEntry: async (name: string) => void removed.push(name),
    };
    (globalThis.window as unknown as { showDirectoryPicker: unknown }).showDirectoryPicker = async () => folder;
    const { worker } = fakeWorker(
      (_m, signal) => new Promise((_, reject) => signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")))),
    );
    const { host } = await open(f, worker);
    const format = dom.find<HTMLSelectElement>(host, "select[aria-label=Format]", undefined);
    // The image's format: the second Format select.
    const imageFormat = card(host, "registration.image").querySelector<HTMLSelectElement>("select")!;
    expect(format).not.toBe(imageFormat);
    imageFormat.value = "zarr";
    dom.fire(imageFormat, "change");
    button(host, "Save image…").click();
    await settle();
    const cancel = button(host, "Cancel");
    expect(cancel.hidden).toBe(false);
    expect(button(host, "Save image…").disabled).toBe(true);
    cancel.click();
    await settle();
    expect(removed).toEqual(["brain_registered.ome.zarr"]);
    expect(cancel.hidden).toBe(true);
    expect(card(host, "registration.image").querySelector<HTMLElement>(".status-line")!.hidden).toBe(true);
  });

  it("asks before saving an LTA without the volumes' geometry", async () => {
    const f = fakeContext();
    f.add("brain");
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:x");
    const { worker } = fakeWorker(async () => {
      throw new Error("unreadable");
    });
    f.raw.ui.confirm.mockResolvedValueOnce(false);
    const { host } = await open(f, worker);
    button(host, "Save transform").click();
    await settle();
    expect(f.raw.ui.confirm).toHaveBeenCalledTimes(1);
    expect(f.raw.ui.confirm.mock.calls[0]).toEqual([expect.stringContaining("without the volumes' geometry")]);
    expect(createObjectURL).not.toHaveBeenCalled();
    button(host, "Save transform").click();
    await settle();
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    createObjectURL.mockRestore();
  });

  it("imports a transform file, and the same file again", async () => {
    const f = fakeContext();
    f.add("brain");
    const { host } = await open(f);
    const input = host.querySelector<HTMLInputElement>("input[type=file]")!;
    const itk = new File(["#Insight Transform File V1.0\nTransform: AffineTransform_double_3_3\nParameters: 1 0 0 0 1 0 0 0 1 -5 0 0\nFixedParameters: 0 0 0\n"], "reg.txt");
    const choose = async (file: File) => {
      Object.defineProperty(input, "files", { value: [file], configurable: true });
      input.value = "C:\\fakepath\\reg.txt";
      dom.fire(input, "change");
      await settle();
    };
    await choose(itk);
    // Emptied, so the same file chosen again fires a change.
    expect(input.value).toBe("");
    expect(f.matrix("brain")[12]).toBeCloseTo(-5, 9);
    // A file it cannot read: said in its card.
    await choose(new File(["nonsense"], "bad.lta"));
    expect(dom.text(card(host, "registration.transformFile").querySelector<HTMLElement>(".status-line")!)).toMatch(/^Could not read bad.lta/);
    await choose(itk);
    expect(card(host, "registration.transformFile").querySelector<HTMLElement>(".status-line")!.hidden).toBe(true);
  });

  it("lets go of its panel when disposed, and of its worker and timers when switched off", async () => {
    const f = fakeContext();
    f.add("brain");
    const { worker } = fakeWorker(async () => ({}));
    const { dispose } = await open(f, worker);
    dispose();
    // A change after the panel is gone draws nothing and throws nothing; a problem is then a toast.
    f.ctx.state.set({ layer: "brain", pairs: [] });
    f.commands.get("registration.fixedHere")!();
    expect(f.saved().pairs.length).toBe(1);
    f.ctx.state.set({ layer: "gone", pairs: [] });
    f.commands.get("registration.fixedHere")!();
    expect(f.raw.ui.toast).toHaveBeenLastCalledWith("Choose the moving layer in the Registration panel first.", "error");
    f.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});
