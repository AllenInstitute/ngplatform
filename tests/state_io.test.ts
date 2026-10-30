import { describe, expect, it } from "vitest";
import {
  encodeFragment,
  fetchableUrl,
  InputError,
  layerCount,
  layerNameFor,
  parseInput,
  workspaceLink,
} from "../src/core/state_io.js";

// Neuroglancer's url-safe parser is injected; plain JSON stands in for it here.
const parse = (text: string) => parseInput(text, (f) => JSON.parse(decodeURIComponent(f)));

describe("parseInput", () => {
  it("reads a plain Neuroglancer state", () => {
    const got = parse('{"layers": [{"name": "a"}], "layout": "3d"}');
    expect(got).toEqual({ kind: "state", state: { ng: { layers: [{ name: "a" }], layout: "3d" }, app: {} } });
  });

  it("reads a workspace with app state", () => {
    const got = parse('{"ng": {"layers": []}, "app": {"tractography": {"version": 1}}}');
    expect(got).toEqual({ kind: "state", state: { ng: { layers: [] }, app: { tractography: { version: 1 } } } });
  });

  it("reads the state out of any Neuroglancer link", () => {
    const state = { layers: [{ name: "x", source: "precomputed://gs://b/x" }] };
    const link = "https://neuroglancer-demo.appspot.com/#!" + encodeFragment(JSON.stringify(state));
    expect(parse(link)).toEqual({ kind: "state", state: { ng: state, app: {} } });
  });

  it("round-trips our own links", () => {
    const workspace = { ng: { layers: [{ name: "t", source: "https://h/s/|zarr-vectors:" }] }, app: { p: { v: 1 } } };
    const link = workspaceLink("https://app.example/index.html#!old", workspace);
    expect(link.startsWith("https://app.example/index.html#!")).toBe(true);
    expect(parse(link)).toEqual({ kind: "state", state: workspace });
  });

  it("omits empty app state from links, so they read as plain Neuroglancer state", () => {
    const link = workspaceLink("https://app/", { ng: { layout: "xy" }, app: {} });
    expect(decodeURIComponent(link.split("#!")[1])).toBe('{"ng":{"layout":"xy"}}');
  });

  it("treats a link to a JSON state as remote", () => {
    expect(parse("https://neuroglancer-demo.appspot.com/#!gs://bucket/state.json")).toEqual({
      kind: "remote",
      url: "https://storage.googleapis.com/bucket/state.json",
    });
    expect(parse("https://example.org/states/a.json")).toEqual({ kind: "remote", url: "https://example.org/states/a.json" });
  });

  it("adds a data URL as a layer", () => {
    expect(parse("gs://bucket/tracts/run1.zarrvectors/|zarr-vectors:")).toEqual({
      kind: "source",
      url: "gs://bucket/tracts/run1.zarrvectors/|zarr-vectors:",
      name: "run1",
    });
    expect(parse("precomputed://gs://neuroglancer-public-data/flyem_fib-25/image").kind).toBe("source");
  });

  it("explains what it cannot read", () => {
    expect(() => parse("")).toThrow(InputError);
    expect(() => parse("hello")).toThrow(/Not a Neuroglancer link/);
    expect(() => parse("{nope")).toThrow(/does not parse/);
    expect(() => parse("[1, 2]")).toThrow(InputError);
  });
});

describe("helpers", () => {
  it("names layers after the last path component", () => {
    expect(layerNameFor("https://h/a/b/brain.nii.gz")).toBe("brain");
    expect(layerNameFor("zarr-vectors://https://h/x/y.zarrvectors/")).toBe("y");
  });

  it("maps cloud URLs to fetchable ones", () => {
    expect(fetchableUrl("gs://b/k/s.json")).toBe("https://storage.googleapis.com/b/k/s.json");
    expect(fetchableUrl("s3://b/k")).toBe("https://b.s3.amazonaws.com/k");
    expect(fetchableUrl("https://x/y")).toBe("https://x/y");
  });

  it("counts layers in list and dict form", () => {
    expect(layerCount({ layers: [{}, {}] })).toBe(2);
    expect(layerCount({ layers: { a: "x" } })).toBe(1);
    expect(layerCount({})).toBe(0);
  });
});
