/**
 * Opening a segmentation's meshes for 2,000 segments over a fake fetch:
 * the manifests are read a few at a time, and segments whose manifest is
 * missing or cannot be read are left out and counted, not the layer failed.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { MANIFEST_CONCURRENCY, openPrecomputedMeshes } from "../precomputed_meshes.js";

afterEach(() => vi.unstubAllGlobals());

const BASE = "http://em.test/seg/";
const text = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));

/** One level of detail, one node, one fragment of `size` bytes. */
function manifest(size: number): Uint8Array {
  const out = new DataView(new ArrayBuffer(28 + 20 + 16));
  let at = 0;
  const f = (v: number) => (out.setFloat32(at, v, true), (at += 4));
  const u = (v: number) => (out.setUint32(at, v, true), (at += 4));
  [64, 64, 64, 0, 0, 0].forEach(f);
  u(1);
  f(1);
  [0, 0, 0].forEach(f);
  u(1);
  [1, 1, 1].forEach(u);
  u(size);
  return new Uint8Array(out.buffer);
}

/**
 * Serves the volume's and the meshes' infos and a manifest per segment;
 * `answer` picks a segment's: its manifest, 404 or a server error.
 */
function serve(answer: (id: number) => "ok" | "missing" | "error") {
  let inFlight = 0;
  let most = 0;
  let manifests = 0;
  vi.stubGlobal("fetch", async (url: string | URL) => {
    const path = String(url).slice(BASE.length);
    inFlight++;
    most = Math.max(most, inFlight);
    try {
      await new Promise((resolve) => setTimeout(resolve, 1));
      if (path === "info") return new Response(text({ type: "segmentation", data_type: "uint64", num_channels: 1, mesh: "mesh", scales: [{ resolution: [8, 8, 40] }] }) as BlobPart);
      if (path === "mesh/info") return new Response(text({ "@type": "neuroglancer_multilod_draco", vertex_quantization_bits: 10, transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0], lod_scale_multiplier: 1 }) as BlobPart);
      const m = /^mesh\/(\d+)\.index$/.exec(path);
      if (m === null) return new Response(null, { status: 404 });
      manifests++;
      const kind = answer(Number(m[1]));
      if (kind === "missing") return new Response(null, { status: 404 });
      if (kind === "error") return new Response(null, { status: 503, statusText: "Service Unavailable" });
      return new Response(manifest(100) as BlobPart);
    } finally {
      inFlight--;
    }
  });
  return { most: () => most, manifests: () => manifests };
}

const decode = async () => ({ indices: new Uint32Array(0), vertexPositions: new Uint32Array(0) });
const ids = Array.from({ length: 2000 }, (_, i) => BigInt(i + 1));

describe("a segmentation's meshes for many segments", () => {
  it("reads the manifests a few at a time", async () => {
    const counts = serve(() => "ok");
    const store = await openPrecomputedMeshes(BASE, ids, { decode });
    expect(counts.manifests()).toBe(2000);
    expect(counts.most()).toBeLessThanOrEqual(MANIFEST_CONCURRENCY);
    expect(store.count).toBe(2000);
    expect(store.warnings).toEqual([]);
  });

  it("leaves out segments whose manifest fails, says how many, and opens the rest", async () => {
    // Three server errors and seven segments with no mesh.
    serve((id) => (id === 5 || id === 900 || id === 1999 ? "error" : id % 250 === 0 && id <= 1750 ? "missing" : "ok"));
    const store = await openPrecomputedMeshes(BASE, ids, { decode });
    expect(store.count).toBe(1990);
    expect(store.plan.ids).not.toContain(5n);
    expect(store.plan.ids).not.toContain(250n);
    expect(store.warnings).toEqual([`10 of 2,000 segments had no mesh (3 could not be read: ${BASE}mesh/5.index: 503 Service Unavailable)`]);
  });

  it("fails only when no segment has a mesh, and then says why", async () => {
    serve(() => "error");
    await expect(openPrecomputedMeshes(BASE, ids.slice(0, 3), { decode })).rejects.toThrow("none of the 3 segments has a mesh: 3 of 3 segments had no mesh (3 could not be read");
  });
});
