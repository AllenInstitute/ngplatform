/** Loading in Neuroglancer: memory limits by the computer's memory, the hint when the GPU memory is full, and stores named by their Zarr version. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { TrackableValue } from "neuroglancer/unstable/trackable_value.js";
import { gpuMemoryFull, memoryLimits, sizeMemoryLimits, watchGpuMemory } from "../src/engine/memory.js";
import type { ChunkSourceStatistics } from "../src/engine/view_settings.js";

const MB = 2 ** 20;
const GB = 2 ** 30;

afterEach(() => vi.useRealTimers());

describe("memory limits", () => {
  it("follow the computer's memory, within bounds, the system's never under the GPU's", () => {
    expect(memoryLimits(8)).toEqual({ gpu: 2 * GB, system: 3 * GB });
    expect(memoryLimits(4)).toEqual({ gpu: 1 * GB, system: 1.5 * GB });
    expect(memoryLimits(2)).toEqual({ gpu: 512 * MB, system: 768 * MB });
    expect(memoryLimits(0.5)).toEqual({ gpu: 512 * MB, system: 768 * MB });
    // A browser that does not say (Firefox, Safari): Neuroglancer's own.
    expect(memoryLimits(undefined)).toBeUndefined();
  });

  it("are the limits' defaults, so a state names them only when changed, and a limit already set is kept", () => {
    const viewer = () => {
      const gpu = new TrackableValue<number>(1e9, Number);
      const system = new TrackableValue<number>(2e9, Number);
      return { gpu, system, v: { chunkQueueManager: { capacities: { gpuMemory: { sizeLimit: gpu }, systemMemory: { sizeLimit: system } } } } as never };
    };
    const a = viewer();
    sizeMemoryLimits(a.v, 8);
    expect([a.gpu.value, a.system.value]).toEqual([2 * GB, 3 * GB]);
    expect(a.gpu.toJSON()).toBeUndefined();
    a.gpu.value = 4 * GB;
    expect(a.gpu.toJSON()).toBe(4 * GB);
    a.gpu.reset();
    expect(a.gpu.value).toBe(2 * GB);
    const b = viewer();
    b.gpu.value = 3e9;
    sizeMemoryLimits(b.v, 2);
    expect([b.gpu.value, b.system.value]).toEqual([3e9, 768 * MB]);
    const c = viewer();
    sizeMemoryLimits(c.v, undefined);
    expect([c.gpu.value, c.system.value]).toEqual([1e9, 2e9]);
  });
});

const row = (memory: number, gpuBytes: number): ChunkSourceStatistics => ({ kind: "zarr volume", details: [], id: "", visible: 10, downloading: 0, memory, gpu: 0, failed: 0, gpuBytes, latency: NaN });

describe("a full GPU", () => {
  it("is chunks the views need waiting in system memory while the GPU's are near its limit", () => {
    expect(gpuMemoryFull([row(3, 600 * MB), row(0, 350 * MB)], GB)).toBe(true);
    expect(gpuMemoryFull([row(0, 1000 * MB)], GB)).toBe(false); // all drawn
    expect(gpuMemoryFull([row(5, 100 * MB)], GB)).toBe(false); // waiting for an upload, with room
    expect(gpuMemoryFull([], GB)).toBe(false);
  });

  it("is told once each time it fills, after two looks, and looked for no more once stopped", async () => {
    vi.useFakeTimers();
    let rows = [row(0, 0)];
    let reads = 0;
    const hints: string[] = [];
    const stop = watchGpuMemory(
      async () => (++reads, rows),
      () => 2 * GB,
      (m) => hints.push(m),
      1000,
    );
    const tick = async (n: number) => {
      for (let i = 0; i < n; ++i) await vi.advanceTimersByTimeAsync(1000);
    };
    await tick(2);
    expect(hints).toEqual([]);
    rows = [row(4, 1.9 * GB)];
    await tick(1);
    expect(hints).toEqual([]); // one look: maybe an upload under way
    await tick(5);
    expect(hints).toEqual(["GPU memory is full (2 GB): some of what the views show is not drawn. Raise GPU memory in Settings › View, or hide layers you are not using."]);
    rows = [row(0, 1.9 * GB)];
    await tick(2);
    rows = [row(4, 1.9 * GB)];
    await tick(3);
    expect(hints).toHaveLength(2);
    stop();
    const at = reads;
    await tick(5);
    expect(reads).toBe(at);
  });
});

describe("the examples' stores", () => {
  it("name Zarr v3 as zarr3://, so Neuroglancer does not look for v2's .zarray and .zattrs first", async () => {
    const { EXAMPLES } = await import("../src/builtins/examples.js");
    const sources = EXAMPLES.flatMap((e) => ((e.state() as { ng: { layers?: { source: unknown }[] } }).ng.layers ?? []).map((l) => l.source)).filter((s): s is string => typeof s === "string");
    const zarr = sources.filter((s) => /^zarr\d?:\/\//.test(s));
    expect(zarr.length).toBeGreaterThan(0);
    expect(zarr.filter((s) => s.startsWith("zarr://"))).toEqual([]);
  });
});

describe("stores on this computer", () => {
  it("are named by the Zarr version their metadata was found in", async () => {
    const { LocalData } = await import("../src/virtual/local_data.js");
    const local = new LocalData("http://app.test/");
    const text = (value: unknown) => new File([JSON.stringify(value)], "x");
    const open = (id: string, name: string, files: Record<string, unknown>) =>
      (local as unknown as { entries: Map<string, unknown> }).entries.set(id, {
        id,
        name,
        kind: "folder",
        needsPermission: false,
        files: new Map(Object.entries(files).map(([k, v]) => [k, text(v)])),
      });
    open("a", "a.ome.zarr", { "zarr.json": { zarr_format: 3, node_type: "group", attributes: { ome: { multiscales: [] } } } });
    open("b", "b.ome.zarr", { ".zattrs": { multiscales: [] }, ".zgroup": { zarr_format: 2 } });
    open("c", "c.zarr", { ".zarray": { zarr_format: 2 } });
    expect((await local.detect("a"))[0].source).toBe("zarr3://http://app.test/local/a/");
    expect((await local.detect("b"))[0].source).toBe("zarr2://http://app.test/local/b/");
    expect((await local.detect("c"))[0].source).toBe("zarr2://http://app.test/local/c/");
  });
});
