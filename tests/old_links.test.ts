/**
 * Links made by other releases open: the fixtures in testdata/links are
 * links as they were written (a plain Neuroglancer link, the platform's
 * version 1 with an older plugin slice, and one from a newer release), so a
 * change to how links are read cannot break them unnoticed.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseInput } from "../src/core/state_io.js";
import { PLATFORM_KEY } from "../src/core/workspace.js";
import { WorkspaceStore } from "../src/platform/workspace_store.js";
import { readSaved } from "../plugins/track-filtering/plugin.js";
import { FakeEngine } from "./fake_engine.js";

const fixture = (name: string) => readFileSync(new URL(`testdata/links/${name}`, import.meta.url), "utf8");

function open(text: string) {
  const engine = new FakeEngine();
  const logged: { message: string; level?: string }[] = [];
  const store = new WorkspaceStore(engine, { framed: false, log: (message, level) => logged.push({ message, level }), settleDelay: 1, writeUrl: () => {} });
  const parsed = parseInput(text, (fragment) => JSON.parse(decodeURIComponent(fragment)));
  if (parsed.kind !== "state") throw new Error(`not a state: ${parsed.kind}`);
  store.open(parsed.state, "a link");
  const errors = () => logged.filter((l) => l.level === "error").map((l) => l.message);
  return { engine, store, errors };
}

describe("old links", () => {
  it("opens a plain Neuroglancer link as one scene of its datasets", () => {
    const { store, engine, errors } = open(fixture("neuroglancer-plain.txt"));
    expect(store.state().scenes).toHaveLength(1);
    expect(store.datasets().map((d) => d.name)).toEqual(["image", "ground-truth"]);
    expect((engine.ng.layers as { segments?: string[] }[])[1].segments).toEqual(["158571", "21894"]);
    expect(errors()).toEqual([]);
  });

  it("opens the platform's version 1: its scenes, datasets (keys without sign-ins) and plugin state", () => {
    const { store, errors } = open(fixture("platform-v1-two-scenes.json"));
    const state = store.state();
    expect(state.scenes.map((s) => s.name)).toEqual(["Whole brain", "Detail"]);
    expect(state.activeScene).toBe("s-a");
    expect(store.datasets().map((d) => d.key)).toEqual(["https://h.example.org/b/brain.ome.zarr|zarr3:", "https://h.example.org/b/tracts.zarrvectors|zarr-vectors:"]);
    // Track filtering's version 1 slice (one filter) is handed over as it was saved, and read as one group.
    const saved = readSaved(store.rawSlice("trackFiltering", 2));
    expect(saved.groups).toHaveLength(1);
    expect(saved.groups[0].filter.ranges).toEqual({ length: [20, 200] });
    expect(errors()).toEqual([]);
  });

  it("opens a link from a newer release as far as it can, and says so", () => {
    const { store, errors } = open(fixture("newer-release.json"));
    expect(store.state().scenes.map((s) => s.name)).toEqual(["Future"]);
    expect(store.datasets().map((d) => d.name)).toEqual(["brain"]);
    expect(errors()).toEqual([expect.stringContaining("made by a newer release (workspace version 2")]);
    // A plugin's slice from a newer version is not read, and the user is told once.
    expect(store.rawSlice("trackFiltering", 2)).toBeUndefined();
    expect(store.rawSlice("trackFiltering", 2)).toBeUndefined();
    expect(errors()).toHaveLength(2);
    expect(errors()[1]).toContain('"trackFiltering" state is version 9');
  });

  it("writes the platform's current version", () => {
    const { store } = open(fixture("newer-release.json"));
    expect((store.workspace().app[PLATFORM_KEY] as { version: number }).version).toBe(1);
  });
});
