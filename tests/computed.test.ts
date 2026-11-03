/** Images computed by chunkmirage's engine: pipelines in URLs, sources as the engine reads them, whose Python runs. */
import { beforeEach, describe, expect, it } from "vitest";
import { Engine } from "chunkmirage-web/engine";
import { allow, decodePipeline, encodePipeline, engineReplies, engineSource, mayRun, ownPython, pipelineCode, type PipelineView } from "../src/virtual/computed.js";

const memory = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => memory.get(k) ?? null,
  setItem: (k: string, v: string) => void memory.set(k, v),
};

describe("computed images", () => {
  beforeEach(() => memory.clear());

  it("carries a pipeline in a URL path segment and back", async () => {
    const spec: PipelineView = { source: "https://example.org/a.ome.zarr/", ops: [{ op: "gaussian", sigma: 1.5 }, { op: "python", code: "def apply(block):\n    return block * 2\n" }], chunk: [64, 64, 64] };
    const code = await encodePipeline(spec);
    expect(code).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(await decodePipeline(code)).toEqual(spec);
    expect(pipelineCode(`zarr3://https://host/app/virtual/ngp/${code}/`)).toBe(code);
    expect(pipelineCode("zarr3://https://host/app/local/abc/x.nii/")).toBeUndefined();
    await expect(decodePipeline("AAAA")).rejects.toThrow();
  });

  it("reads a layer's source as chunkmirage takes it", () => {
    expect(engineSource("zarr3://https://h/a.zarr/|zarr3:")).toBe("https://h/a.zarr/");
    expect(engineSource("zarr://https://h/a.zarr/")).toBe("https://h/a.zarr/");
    expect(engineSource("n5://gs://b/x.n5/")).toBe("gs://b/x.n5/");
    expect(engineSource("precomputed://gs://b/vol")).toBe("precomputed://gs://b/vol");
  });

  it("runs Python from a link only when it is the platform's own or allowed here", async () => {
    const own = ownPython("#halo 1\n# mine\ndef apply(block, r):\n    return block\n");
    const theirs: PipelineView = { source: "s", chunk: [64, 64, 64], ops: [{ op: "python", code: "import os\ndef apply(block):\n    return block\n" }] };
    expect(await mayRun({ source: "s", chunk: [64, 64, 64], ops: [{ op: "gaussian", sigma: 1 }] })).toBe(true);
    // The platform's own, whatever its halo.
    expect(await mayRun({ source: "s", chunk: [64, 64, 64], ops: [{ op: "python", code: own.replace("#halo 1", "#halo 7") }] })).toBe(true);
    expect(await mayRun({ source: "s", chunk: [64, 64, 64], ops: [{ op: "python", code: `${own}# changed\n` }] })).toBe(false);
    expect(await mayRun(theirs)).toBe(false);
    await allow(theirs);
    expect(await mayRun(theirs)).toBe(true);
  });

  it("passes requests on to the engine as the vendored chunkmirage answers them", () => {
    expect(engineReplies(Object.create(Engine.prototype))).toBe(true);
  });
});

describe("computed images from signed-in buckets", () => {
  it("keeps gs+google:// in the pipeline and reads it through the app's own path", async () => {
    const { readableSource } = await import("../src/virtual/computed.js");
    expect(engineSource("zarr3://gs+google://bucket/a.zarr/")).toBe("gs+google://bucket/a.zarr/");
    expect(readableSource("gs+google://bucket/a.zarr/", "https://host/app/")).toBe("https://host/app/gcs-google/bucket/a.zarr/");
    expect(readableSource("precomputed://gs+google://bucket/vol", "https://host/app/")).toBe("precomputed://https://host/app/gcs-google/bucket/vol");
    expect(readableSource("https://h/a.zarr/", "https://host/app/")).toBe("https://h/a.zarr/");
  });
});
