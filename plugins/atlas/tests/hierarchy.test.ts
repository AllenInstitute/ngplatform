import { readFileSync } from "node:fs";
import { parseLookupTable } from "@ngplatform/sdk/lookup";
import { describe, expect, it } from "vitest";
import { Atlas, freeSurferClass, type Region } from "../hierarchy.js";

const allenText = readFileSync(new URL("./fixtures/allen_structure_graph.json", import.meta.url), "utf8");
const allen = () => Atlas.fromTable(parseLookupTable(allenText));
const table = (name: string) => readFileSync(new URL(`../../../data/lookup-tables/${name}`, import.meta.url), "utf8");

const names = (regions: Iterable<Region>) => [...regions].map((r) => r.acronym ?? r.name);

describe("an atlas's hierarchy", () => {
  it("builds the Allen ontology's tree, full names with acronyms", () => {
    const atlas = allen();
    expect(atlas.kind).toBe("hierarchy");
    expect(atlas.size).toBe(22);
    expect(names(atlas.roots)).toEqual(["root"]);
    expect(names(atlas.roots[0].children)).toEqual(["grey", "fiber tracts", "VS"]);
    const mop = atlas.regionOf(985n)!;
    expect(mop).toMatchObject({ name: "Primary motor area", acronym: "MOp", value: 985n });
    expect(names(mop.children)).toEqual(["MOp1", "MOp2/3", "MOp5", "MOp6a"]);
    expect(mop.parent?.acronym).toBe("MO");
  });

  it("names a region's path, from the root", () => {
    const atlas = allen();
    const mop1 = atlas.regionOf(320n)!;
    expect(names(atlas.path(mop1))).toEqual(["root", "grey", "CH", "CTX", "CTXpl", "Isocortex", "MO", "MOp", "MOp1"]);
    expect(atlas.pathText(atlas.regionOf(985n)!)).toBe(
      "root › Basic cell groups and regions › Cerebrum › Cerebral cortex › Cortical plate › Isocortex › Somatomotor areas › Primary motor area",
    );
  });

  it("selects a region with all its descendants", () => {
    const atlas = allen();
    const mo = atlas.regionOf(500n)!;
    expect(names(atlas.descendants(mo))).toEqual(["MO", "MOp", "MOp1", "MOp2/3", "MOp5", "MOp6a", "MOs"]);
    expect(atlas.values(mo)).toEqual([500n, 985n, 320n, 943n, 648n, 844n, 993n]);
    expect(atlas.values(atlas.regionOf(382n)!)).toEqual([382n]);
  });

  it("searches names, acronyms and values, showing the way to each match", () => {
    const atlas = allen();
    const { matches, shown } = atlas.search("primary motor");
    expect(names(matches)).toEqual(["MOp", "MOp1", "MOp2/3", "MOp5", "MOp6a"]);
    expect(shown.has(atlas.regionOf(997n)!)).toBe(true);
    expect(shown.has(atlas.regionOf(500n)!)).toBe(true);
    expect(shown.has(atlas.regionOf(993n)!)).toBe(false);
    // Case aside, words in any order; acronyms; values.
    expect(names(atlas.search("AREA primary SOMATO").matches)).toEqual(["SSp", "SSp-n"]);
    expect(names(atlas.search("ca1").matches)).toEqual(["CA1"]);
    expect(names(atlas.search("382").matches)).toEqual(["CA1"]);
    expect(atlas.search("  ").matches.size).toBe(0);
    // With descendants, everything under a match is shown too.
    const { shown: under } = atlas.search("Somatomotor", true);
    expect(under.has(atlas.regionOf(320n)!)).toBe(true);
  });

  it("totals voxels over each region's descendants, leaving out regions with none", () => {
    const atlas = allen();
    const totals = atlas.totals(
      new Map([
        [320n, 10],
        [943n, 5],
        [382n, 7],
      ]),
    );
    expect(totals.get(atlas.regionOf(985n)!)).toBe(15);
    expect(totals.get(atlas.regionOf(315n)!)).toBe(15);
    expect(totals.get(atlas.regionOf(997n)!)).toBe(22);
    expect(totals.has(atlas.regionOf(993n)!)).toBe(false);
  });

  it("groups FreeSurfer's aparc+aseg by tissue and hemisphere", () => {
    const atlas = Atlas.fromTable(parseLookupTable(table("FreeSurfer_DesikanKilliany.txt")));
    expect(atlas.kind).toBe("freesurfer");
    expect(names(atlas.roots)).toEqual(["Cerebral cortex", "Cerebral white matter", "Subcortical grey matter", "Cerebellum", "Brain stem", "Ventricles and CSF", "Other"]);
    expect(atlas.pathText(atlas.regionOf(1024n)!)).toBe("Cerebral cortex › Left hemisphere › ctx-lh-precentral");
    expect(atlas.pathText(atlas.regionOf(2024n)!)).toBe("Cerebral cortex › Right hemisphere › ctx-rh-precentral");
    expect(atlas.pathText(atlas.regionOf(17n)!)).toBe("Subcortical grey matter › Left hemisphere › Left-Hippocampus");
    expect(atlas.pathText(atlas.regionOf(41n)!)).toBe("Cerebral white matter › Right hemisphere › Right-Cerebral-White-Matter");
    expect(atlas.pathText(atlas.regionOf(8n)!)).toBe("Cerebellum › Left hemisphere › Left-Cerebellum-Cortex");
    expect(atlas.pathText(atlas.regionOf(16n)!)).toBe("Brain stem › Brain-Stem");
    expect(atlas.pathText(atlas.regionOf(4n)!)).toBe("Ventricles and CSF › Left hemisphere › Left-Lateral-Ventricle");
    expect(atlas.pathText(atlas.regionOf(14n)!)).toBe("Ventricles and CSF › 3rd-Ventricle");
    expect(atlas.pathText(atlas.regionOf(251n)!)).toBe("Cerebral white matter › CC_Posterior");
    // Left and right come first in a group, then the labels on neither side.
    const wm = atlas.roots[1];
    expect(names(wm.children.slice(0, 2))).toEqual(["Left hemisphere", "Right hemisphere"]);
    // The left cortex is aseg's (3) and aparc's 1000s; a group the table does not number has no value.
    const leftCortex = atlas.region("group:Cerebral cortex/Left hemisphere")!;
    expect(leftCortex.value).toBeUndefined();
    const values = atlas.values(leftCortex);
    expect(values).toContain(3n);
    expect(values.filter((v) => v >= 1000n)).toHaveLength(36);
    expect(values.every((v) => v < 2000n)).toBe(true);
  });

  it("classifies FreeSurfer's codes beyond aseg", () => {
    expect(freeSurferClass(11121, "ctx_lh_G_and_S_paracentral")).toBe("Cerebral cortex");
    expect(freeSurferClass(3024, "wm-lh-precentral")).toBe("Cerebral white matter");
    expect(freeSurferClass(5002, "Right-UnsegmentedWhiteMatter")).toBe("Cerebral white matter");
    expect(freeSurferClass(80, "non-WM-hypointensities")).toBe("Other");
    expect(freeSurferClass(31, "Left-choroid-plexus")).toBe("Ventricles and CSF");
    expect(Atlas.fromTable(parseLookupTable(table("FreeSurferColorLUT.txt"))).kind).toBe("freesurfer");
  });

  it("groups Schaefer's parcels by hemisphere and network", () => {
    const atlas = Atlas.fromTable(parseLookupTable(table("Schaefer2018_100Parcels_7Networks.txt")));
    expect(atlas.kind).toBe("schaefer");
    expect(names(atlas.roots)).toEqual(["Background", "Left hemisphere", "Right hemisphere"]);
    expect(names(atlas.roots[1].children)).toEqual(["Vis", "SomMot", "DorsAttn", "SalVentAttn", "Limbic", "Cont", "Default"]);
    expect(atlas.pathText(atlas.regionOf(1n)!)).toBe("Left hemisphere › Vis › 7Networks_LH_Vis_1");
  });

  it("lists other tables flat", () => {
    const atlas = Atlas.fromTable(parseLookupTable(table("HarvardOxford_Cortical.txt")));
    expect(atlas.kind).toBe("flat");
    // Background and 48 regions.
    expect(atlas.roots).toHaveLength(49);
    expect(atlas.roots.every((r) => r.children.length === 0 && r.parent === undefined)).toBe(true);
  });
});
