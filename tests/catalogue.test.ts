import { describe, expect, it } from "vitest";
import { ASYNC_WORKER_MODULES, CHUNK_WORKER_MODULES, workerName, workerPlugins } from "../src/engine/workers/plugins.js";
import { CATALOGUE } from "../plugins/index.js";
import { checkManifest } from "../src/sdk/manifest.js";

describe("the plugin catalogue", () => {
  it("has sound manifests, each with the code its kind needs", () => {
    for (const { manifest, load, neuroglancer } of CATALOGUE) {
      expect(checkManifest(manifest), manifest.id).toEqual([]);
      if (manifest.kind === "datatype") {
        expect(neuroglancer, manifest.id).toBeDefined();
        expect(CHUNK_WORKER_MODULES[manifest.id], `${manifest.id} chunk worker module`).toBeDefined();
        expect(ASYNC_WORKER_MODULES[manifest.id], `${manifest.id} async worker module`).toBeDefined();
      } else {
        expect(load, manifest.id).toBeDefined();
      }
    }
  });

  it("lists each plugin requirements first, with a line for the Plugins tab and an offer for every tool", () => {
    const seen = new Set<string>();
    for (const { manifest, summary, offer } of CATALOGUE) {
      for (const r of manifest.requires?.plugins ?? []) expect(seen.has(r), `${manifest.id} after ${r}`).toBe(true);
      seen.add(manifest.id);
      expect(summary.length, manifest.id).toBeGreaterThan(0);
      if (manifest.kind === "tool") expect(offer, manifest.id).toBeDefined();
    }
  });

  it("requires only plugins it ships", () => {
    const ids = new Set(CATALOGUE.map((e) => e.manifest.id));
    for (const { manifest } of CATALOGUE) for (const r of manifest.requires?.plugins ?? []) expect(ids.has(r), `${manifest.id} → ${r}`).toBe(true);
  });

  it("names the plugins a worker loads", () => {
    expect(workerPlugins(workerName(["a", "b"]))).toEqual(["a", "b"]);
    expect(workerPlugins("")).toEqual([]);
    expect(workerPlugins("not json")).toEqual([]);
  });
});
