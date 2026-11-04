import { describe, expect, it } from "vitest";
import { addGroup, groupOf, groupPath, groupsOf, groupTree, hiddenValues, layerShader, moveGroup, removeGroup, setGroup, SHADER_MARK, withShader, withShaderKept, writeGroups } from "../groups.js";
import type { AnnotationJson } from "../measure.js";
import { ancestorNames, findTerm, lookupTerms, parseTerms, searchTerms } from "../ontology.js";
import { BUILTIN_COLUMNS, buildRows, commentsText, fieldColumns, importCsv, parseComments, matches, parseCsv, parseQuery, sortRows, tableCsv, type TableLayer } from "../table.js";
import { csv } from "../ui.js";
import { addField, emptyMeta, fieldId, fieldsOf, type LayerMeta, type LayerSpec, prune, readValue, removeField, setValue, updateField } from "../values.js";

const line = (id: string, description?: string): AnnotationJson => ({ type: "line", id, pointA: [0, 0, 0], pointB: [3, 4, 0], ...(description ? { description } : {}) });
const point = (id: string, description?: string): AnnotationJson => ({ type: "point", id, point: [1, 2, 3], ...(description ? { description } : {}) });

function layer(annotations: AnnotationJson[]): [LayerSpec, LayerMeta] {
  return [{ name: "cells", annotations }, emptyMeta()];
}

describe("values", () => {
  it("keeps a list as an enum property, 0 for none", () => {
    let [spec, meta] = layer([point("a"), point("b")]);
    [spec, meta] = addField(spec, meta, { id: "", title: "Cell type", kind: "list", options: ["pyramidal", "basket"] });
    expect(spec.annotationProperties).toEqual([{ id: "cell_type", type: "uint8", description: "Cell type", enum_values: [0, 1, 2], enum_labels: ["", "pyramidal", "basket"] }]);
    expect(spec.annotations.map((a) => a.props)).toEqual([[0], [0]]);
    const field = fieldsOf(spec, meta)[0];
    expect(field).toMatchObject({ kind: "list", storage: "property", options: ["pyramidal", "basket"], codes: [1, 2] });
    [spec, meta] = setValue(spec, meta, ["b"], field, "basket");
    expect(spec.annotations[1].props).toEqual([2]);
    expect(readValue(field, spec.annotations[1], spec, meta)).toBe("basket");
    expect(readValue(field, spec.annotations[0], spec, meta)).toBeUndefined();
  });

  it("keeps numbers as float32 properties, text and terms in the plugin's state", () => {
    let [spec, meta] = layer([point("a")]);
    [spec, meta] = addField(spec, meta, { id: "", title: "Diameter", kind: "number" });
    [spec, meta] = addField(spec, meta, { id: "", title: "Note", kind: "text" });
    [spec, meta] = addField(spec, meta, { id: "", title: "Region", kind: "ontology", ontology: { title: "Allen", url: "lut://allen" } });
    expect(spec.annotationProperties).toEqual([{ id: "diameter", type: "float32", description: "Diameter" }]);
    const [diameter, note, region] = fieldsOf(spec, meta);
    expect([diameter.storage, note.storage, region.storage]).toEqual(["property", "state", "state"]);
    [spec, meta] = setValue(spec, meta, ["a"], diameter, 12.5);
    [spec, meta] = setValue(spec, meta, ["a"], note, "dendrite cut");
    [spec, meta] = setValue(spec, meta, ["a"], region, { id: "315", name: "Isocortex" });
    expect(spec.annotations[0].props).toEqual([12.5]);
    expect(meta.values).toEqual({ a: { note: "dendrite cut", region: { id: "315", name: "Isocortex" } } });
    [spec, meta] = setValue(spec, meta, ["a"], note, "");
    expect(meta.values.a).toEqual({ region: { id: "315", name: "Isocortex" } });
  });

  it("keeps a list's values by name when the list changes", () => {
    let [spec, meta] = layer([point("a"), point("b")]);
    [spec, meta] = addField(spec, meta, { id: "", title: "Kind", kind: "list", options: ["x", "y", "z"] });
    const kind = () => fieldsOf(spec, meta)[0];
    [spec, meta] = setValue(spec, meta, ["a"], kind(), "y");
    [spec, meta] = setValue(spec, meta, ["b"], kind(), "x");
    [spec, meta] = updateField(spec, meta, "kind", { options: ["z", "y"], title: "Sort" });
    expect(kind().title).toBe("Sort");
    expect(readValue(kind(), spec.annotations[0], spec, meta)).toBe("y");
    expect(readValue(kind(), spec.annotations[1], spec, meta)).toBeUndefined();
  });

  it("removes a field with its values", () => {
    let [spec, meta] = layer([point("a")]);
    [spec, meta] = addField(spec, meta, { id: "", title: "A", kind: "number" });
    [spec, meta] = addField(spec, meta, { id: "", title: "B", kind: "list", options: ["p"] });
    [spec, meta] = setValue(spec, meta, ["a"], fieldsOf(spec, meta)[1], "p");
    [spec, meta] = removeField(spec, meta, "a");
    expect(spec.annotationProperties?.map((p) => p.id)).toEqual(["b"]);
    expect(spec.annotations[0].props).toEqual([1]);
    [spec, meta] = removeField(spec, meta, "b");
    expect(spec.annotationProperties).toBeUndefined();
    expect(spec.annotations[0].props).toBeUndefined();
  });

  it("reads properties made elsewhere as fields", () => {
    const spec: LayerSpec = {
      name: "x",
      annotations: [{ ...point("a"), props: ["#ff0000", 7] }],
      annotationProperties: [
        { id: "color", type: "rgb" },
        { id: "kind", type: "uint8", enum_values: [3, 7], enum_labels: ["soma", "spine"] },
      ],
    };
    const [colour, kind] = fieldsOf(spec, emptyMeta());
    expect(colour.kind).toBe("colour");
    expect(kind).toMatchObject({ kind: "list", options: ["soma", "spine"], codes: [3, 7] });
    expect(readValue(kind, spec.annotations[0], spec, emptyMeta())).toBe("spine");
  });

  it("makes property ids Neuroglancer takes", () => {
    expect(fieldId("Cell type", [])).toBe("cell_type");
    expect(fieldId("2nd look", [])).toBe("nd_look");
    expect(fieldId("Group", [])).toBe("group_2");
    expect(fieldId("!!", [])).toBe("field");
    expect(fieldId("Cell type", ["cell_type"])).toBe("cell_type_2");
  });

  it("forgets the values of annotations gone", () => {
    const meta = { ...emptyMeta(), values: { a: { n: "1" }, b: { n: "2" } }, comments: { b: [{ time: "t", text: "x" }] } };
    expect(prune({ name: "l", annotations: [point("a")] }, meta)).toMatchObject({ values: { a: { n: "1" } }, comments: {} });
  });
});

describe("groups", () => {
  it("nests groups and names them by their path", () => {
    let { groups, value: cortex } = addGroup([], "Cortex");
    let l5: number;
    ({ groups, value: l5 } = addGroup(groups, "Layer 5", cortex));
    ({ groups } = addGroup(groups, "White matter"));
    expect(groupPath(groups, l5)).toBe("Cortex / Layer 5");
    expect(groupTree(groups).map((t) => [t.group.name, t.depth])).toEqual([
      ["Cortex", 0],
      ["Layer 5", 1],
      ["White matter", 0],
    ]);
    expect(hiddenValues(groups.map((g) => (g.value === cortex ? { ...g, hidden: true } : g)))).toEqual([cortex, l5]);
    expect(moveGroup(groups, cortex, l5)).toBe(groups);
  });

  it("writes the group property and moves members of a removed group to its parent", () => {
    let [spec, meta] = layer([point("a"), point("b")]);
    let { groups, value: outer } = addGroup([], "Outer");
    let inner: number;
    ({ groups, value: inner } = addGroup(groups, "Inner", outer));
    [spec, meta] = writeGroups(spec, meta, groups, inner);
    expect(spec.annotationProperties?.[0]).toMatchObject({ id: "group", type: "uint16", default: inner, enum_values: [0, outer, inner], enum_labels: ["", "Outer", "Outer / Inner"] });
    spec = setGroup(spec, ["b"], inner);
    expect(groupOf(spec, spec.annotations[1])).toBe(inner);
    const removed = removeGroup(groups, inner);
    [spec, meta] = writeGroups(spec, meta, removed.groups, meta.activeGroup, { from: inner, to: removed.moveTo });
    expect(groupOf(spec, spec.annotations[1])).toBe(outer);
    expect(meta.activeGroup).toBeUndefined();
    expect(groupsOf(spec, meta).map((g) => g.name)).toEqual(["Outer"]);
  });

  it("hides groups and colours by group or value in the layer's shader", () => {
    let [spec, meta] = layer([point("a")]);
    const { groups } = addGroup([], "A");
    [spec, meta] = writeGroups(spec, meta, [{ ...groups[0], hidden: true }]);
    const shader = layerShader(spec, meta, fieldsOf(spec, meta))!;
    expect(shader.startsWith(SHADER_MARK)).toBe(true);
    expect(shader).toContain("if (prop_group() == 1u) discard;");
    [spec, meta] = addField(spec, meta, { id: "", title: "Kind", kind: "list", options: ["x", "y"] });
    meta = { ...meta, groups: groups, colourBy: "kind" };
    const byKind = layerShader(spec, meta, fieldsOf(spec, meta))!;
    expect(byKind).not.toContain("discard");
    expect(byKind).toContain("if (prop_kind() == 2u) c = ");
    // Nothing to do: the shader made here goes; a user's own stays.
    meta = { ...meta, colourBy: undefined };
    expect(withShader({ ...spec, shader: byKind }, meta, fieldsOf(spec, meta)).shader).toBeUndefined();
    expect(withShader({ ...spec, shader: "void main() { setColor(vec3(1.0)); }" }, meta, fieldsOf(spec, meta)).shader).toContain("vec3(1.0)");
  });

  it("puts a user's own shader back when the one made for hidden groups is no longer needed", () => {
    let [spec, meta] = layer([point("a")]);
    const mine = "void main() { setColor(vec3(1.0, 0.0, 0.0)); }";
    spec = { ...spec, shader: mine };
    const { groups } = addGroup([], "A");
    [spec, meta] = writeGroups(spec, meta, [{ ...groups[0], hidden: true }]);
    // Hiding the group needs a shader made here: the user's is kept in the record.
    [spec, meta] = withShaderKept(spec, meta, fieldsOf(spec, meta));
    expect(spec.shader!.startsWith(SHADER_MARK)).toBe(true);
    expect(meta.userShader).toBe(mine);
    // Shown again: the user's shader comes back, and the record forgets it.
    meta = { ...meta, groups: [{ ...groups[0], hidden: false }] };
    [spec, meta] = withShaderKept(spec, meta, fieldsOf(spec, meta));
    expect(spec.shader).toBe(mine);
    expect(meta.userShader).toBeUndefined();
  });
});

function tableLayer(): TableLayer {
  let [spec, meta] = layer([line("l1", "axon"), point("p1", "soma 1"), point("p2", "soma 10"), point("p3")]);
  [spec, meta] = addField(spec, meta, { id: "", title: "Cell type", kind: "list", options: ["pyramidal", "basket"] });
  [spec, meta] = addField(spec, meta, { id: "", title: "Diameter", kind: "number" });
  [spec, meta] = addField(spec, meta, { id: "", title: "Region", kind: "ontology", ontology: { title: "t", terms: [{ id: "1", name: "Brain" }, { id: "2", name: "Isocortex", parent: "1" }] } });
  const [type, diameter, region] = fieldsOf(spec, meta);
  [spec, meta] = setValue(spec, meta, ["p1", "p2"], type, "pyramidal");
  [spec, meta] = setValue(spec, meta, ["p3"], type, "basket");
  [spec, meta] = setValue(spec, meta, ["p1"], diameter, 12);
  [spec, meta] = setValue(spec, meta, ["p2"], diameter, 8);
  [spec, meta] = setValue(spec, meta, ["p2"], region, { id: "2", name: "Isocortex" });
  const { groups } = addGroup([], "Soma");
  [spec, meta] = writeGroups(spec, meta, groups);
  spec = setGroup(spec, ["p1", "p2"], 1);
  meta = { ...meta, comments: { p2: [{ time: "2026-11-03T10:00:00Z", text: "check, \"twice\"" }] } };
  return { spec, meta, managed: false };
}

const sizes = (_layer: string, a: AnnotationJson) => (a.type === "line" ? { quantity: "length" as const, value: 5 } : undefined);

describe("table", () => {
  const l = tableLayer();
  const fields = fieldsOf(l.spec, l.meta);
  const terms = new Map(fields[2].ontology!.terms!.map((t) => [t.id, t]));
  const rows = buildRows([l], sizes, (f) => (f.kind === "ontology" ? terms : undefined));
  const columns = [...BUILTIN_COLUMNS, ...fieldColumns(fields)];
  const find = (q: string) => rows.filter((r) => matches(r, parseQuery(q), columns)).map((r) => r.id);

  it("has a row for each annotation with its group, values, size and comments", () => {
    expect(rows.map((r) => [r.id, r.groupPath, r.values["Cell type"], r.values.Diameter, r.size?.value, r.comments.length])).toEqual([
      ["l1", "", "", "0", 5, 0],
      ["p1", "Soma", "pyramidal", "12", undefined, 0],
      ["p2", "Soma", "pyramidal", "8", undefined, 1],
      ["p3", "", "basket", "0", undefined, 0],
    ]);
    expect(rows[2].values.Region).toBe("Isocortex");
  });

  it("parses queries", () => {
    expect(parseQuery('celltype:pyr -axon size>=2 note="two words" group=')).toEqual([
      { column: "celltype", op: ":", value: "pyr", negate: false },
      { op: ":", value: "axon", negate: true },
      { column: "size", op: ">=", value: "2", negate: false },
      { column: "note", op: "=", value: "two words", negate: false },
      { column: "group", op: "=", value: "", negate: false },
    ]);
  });

  it("finds rows by any value", () => {
    expect(find("soma")).toEqual(["p1", "p2"]);
    expect(find("celltype:pyr")).toEqual(["p1", "p2"]);
    expect(find("celltype=basket")).toEqual(["p3"]);
    expect(find("diameter>10")).toEqual(["p1"]);
    expect(find("group=")).toEqual(["l1", "p3"]);
    expect(find("-group:soma type:point")).toEqual(["p3"]);
    expect(find("size<10")).toEqual(["l1"]);
    expect(find("comments:twice")).toEqual(["p2"]);
    expect(find("comments>0")).toEqual(["p2"]);
    // A term is found by its ancestors' names.
    expect(find("region:brain")).toEqual(["p2"]);
    // An unknown column is plain text.
    expect(find("nothing:here")).toEqual([]);
  });

  it("sorts numbers as numbers and names naturally, empty last", () => {
    const name = columns.find((c) => c.key === "name")!;
    expect(sortRows(rows, name).map((r) => r.id)).toEqual(["l1", "p3", "p1", "p2"]);
    const diameter = columns.find((c) => c.title === "Diameter")!;
    expect(sortRows(rows, diameter, true).map((r) => r.id)).toEqual(["p1", "p2", "l1", "p3"]);
    const size = columns.find((c) => c.key === "size")!;
    expect(sortRows(rows, size).map((r) => r.id)).toEqual(["l1", "p1", "p2", "p3"]);
  });

  it("writes CSV and reads it back into an empty layer", () => {
    const text = csv(tableCsv(rows, fields.map((f) => f.title)));
    const parsed = parseCsv(text);
    expect(parsed[0].slice(0, 9)).toEqual(["layer", "id", "type", "description", "group", "Cell type", "Diameter", "Region", "size"]);
    expect(parsed[3][10]).toBe('2026-11-03T10:00:00Z check, "twice"');
    const empty: TableLayer = { spec: { name: "copy", annotations: [] }, meta: emptyMeta(), managed: false };
    let n = 0;
    // Rows naming a layer the scene lacks go to the target.
    const result = importCsv(text, new Map([["copy", empty]]), "copy", () => `new${n++}`);
    expect([result.added, result.updated, result.skipped]).toEqual([4, 0, 0]);
    const copy = result.layers.get("copy")!;
    const again = buildRows([copy], sizes);
    expect(again.map((r) => [r.id, r.type, r.description, r.groupPath, r.values["Cell type"], r.values.Diameter, r.values.Region, r.comments.length])).toEqual([
      ["l1", "line", "axon", "", "", "0", "", 0],
      ["p1", "point", "soma 1", "Soma", "pyramidal", "12", "", 0],
      ["p2", "point", "soma 10", "Soma", "pyramidal", "8", "Isocortex", 1],
      ["p3", "point", "", "", "basket", "0", "", 0],
    ]);
    expect(copy.spec.annotations[0]).toMatchObject({ pointA: [0, 0, 0], pointB: [3, 4, 0] });
    // The columns became fields: lists of the values seen, numbers.
    expect(fieldsOf(copy.spec, copy.meta).map((f) => [f.title, f.kind])).toEqual([
      ["Cell type", "list"],
      ["Diameter", "number"],
      ["Region", "list"],
    ]);
  });

  it("updates the annotations a CSV names, and skips rows it cannot place", () => {
    const text = "layer,id,description,group,Cell type,comments\ncells,p3,soma 3,Soma / Large,pyramidal,2026-11-03T11:00:00Z new\ncells,,,,,\ncells,zz,x,,,\n";
    const result = importCsv(text, new Map([["cells", l]]), undefined, () => "n");
    expect([result.added, result.updated, result.skipped]).toEqual([0, 1, 2]);
    const changed = result.layers.get("cells")!;
    const p3 = buildRows([changed], sizes).find((r) => r.id === "p3")!;
    expect([p3.description, p3.groupPath, p3.values["Cell type"], p3.comments.map((c) => c.text)]).toEqual(["soma 3", "Soma / Large", "pyramidal", ["new"]]);
    expect(result.notes.join(" ")).toContain("no type");
  });

  it("reads an ontology's term by its name", () => {
    const result = importCsv("layer,id,Region\ncells,p1,isocortex\ncells,p3,Elsewhere\n", new Map([["cells", l]]), undefined, () => "n");
    const changed = result.layers.get("cells")!;
    expect(changed.meta.values.p1.region).toEqual({ id: "2", name: "Isocortex" });
    expect(changed.meta.values.p3.region).toEqual({ id: "Elsewhere", name: "Elsewhere" });
  });

  it("leaves layers another plugin keeps alone", () => {
    const managed: TableLayer = { ...l, managed: true };
    const result = importCsv("layer,id,description\ncells,p1,x\n", new Map([["cells", managed]]), undefined, () => "n");
    expect(result.skipped).toBe(1);
    expect(result.layers.size).toBe(0);
  });

  it("does not copy rows of another plugin's layer into the target, nor write into such a layer", () => {
    const managed: TableLayer = { ...l, spec: { ...l.spec, name: "regions" }, managed: true };
    const empty: TableLayer = { spec: { name: "copy", annotations: [] }, meta: emptyMeta(), managed: false };
    const layers = new Map([["regions", managed], ["copy", empty]]);
    const text = "layer,id,type,description,point\nregions,r1,point,a region,1 2 3\nelsewhere,p9,point,mine,4 5 6\n";
    const result = importCsv(text, layers, "copy", () => "n");
    expect([result.added, result.skipped]).toEqual([1, 1]);
    expect(result.layers.get("copy")!.spec.annotations.map((a) => a.description)).toEqual(["mine"]);
    // The managed layer as the target: nothing written, nothing thrown.
    const none = importCsv(text, layers, "regions", () => "n");
    expect([none.added, none.skipped, none.layers.size]).toEqual([0, 2, 0]);
  });

  it("keeps a comment of several lines as one through CSV", () => {
    const comments = [{ time: "2026-11-03T10:00:00Z", text: "first line\nsecond \\ line" }, { time: "2026-11-03T11:00:00Z", text: "another" }];
    expect(parseComments(commentsText(comments))).toEqual(comments);
  });
});

describe("ontologies", () => {
  it("reads OBO terms with their parents, without obsolete ones", () => {
    const obo = "format-version: 1.2\nontology: cl\n\n[Term]\nid: CL:0000000\nname: cell\n\n[Term]\nid: CL:0000540\nname: neuron\nis_a: CL:0000000 ! cell\n\n[Term]\nid: CL:9\nname: old\nis_obsolete: true\n\n[Typedef]\nid: part_of\n";
    const o = parseTerms(obo, "cl.obo");
    expect(o.title).toBe("cl");
    expect(o.terms).toEqual([
      { id: "CL:0000000", name: "cell" },
      { id: "CL:0000540", name: "neuron", parent: "CL:0000000" },
    ]);
  });

  it("reads JSON lists and trees (the Allen structure graph)", () => {
    const allen = { msg: [{ id: 997, name: "root", acronym: "root", children: [{ id: 8, name: "Basic cell groups and regions", acronym: "grey", children: [] }] }] };
    expect(parseTerms(JSON.stringify(allen), "allen.json").terms).toEqual([
      { id: "997", name: "root" },
      { id: "8", name: "Basic cell groups and regions", short: "grey", parent: "997" },
    ]);
    expect(parseTerms('["a", "b"]').terms.map((t) => t.name)).toEqual(["a", "b"]);
    expect(parseTerms('[{"id": "x", "label": "X", "parent": "y"}]').terms).toEqual([{ id: "x", name: "X", parent: "y" }]);
  });

  it("reads plain lists, a term a line or id and name", () => {
    expect(parseTerms("pyramidal\nbasket\n\n# note\nbasket\n").terms.map((t) => t.id)).toEqual(["pyramidal", "basket"]);
    expect(parseTerms("A1\tFirst\nA2\tSecond\tA1\n").terms).toEqual([
      { id: "A1", name: "First" },
      { id: "A2", name: "Second", parent: "A1" },
    ]);
  });

  it("takes terms from a lookup table and finds them", () => {
    const terms = lookupTerms({ entries: [{ value: 315n, name: "Isocortex", colour: [0, 0, 0], parent: 695n }, { value: 695n, name: "CTXpl", description: "Cortical plate", colour: [0, 0, 0] }] });
    expect(terms).toEqual([
      { id: "315", name: "Isocortex", parent: "695" },
      { id: "695", name: "Cortical plate", short: "CTXpl" },
    ]);
    expect(searchTerms(terms, "ctx").map((t) => t.id)).toEqual(["695"]);
    expect(searchTerms(terms, "cort").map((t) => t.id)).toEqual(["695", "315"]);
    expect(findTerm(terms, "Cortical plate (CTXpl)")?.id).toBe("695");
    expect(findTerm(terms, "315")?.name).toBe("Isocortex");
    expect(ancestorNames(terms, "315")).toEqual(["Cortical plate", "CTXpl"]);
    // FreeSurfer-style names, underscores for spaces.
    const fs = [{ id: "1", name: "Frontal_Pole" }];
    expect(findTerm(fs, "frontal pole")?.id).toBe("1");
    expect(searchTerms(fs, "frontal p").map((t) => t.id)).toEqual(["1"]);
  });
});

describe("a layer renamed keeps its record", () => {
  it("matches the new name to the layer gone with the same annotations", async () => {
    const { renamedFrom } = await import("../annotate.js");
    const s = (...ids: string[]) => new Set(ids);
    expect(renamedFrom(s("a", "b"), [["old", s("a", "b")], ["other", s("c")]])).toBe("old");
    expect(renamedFrom(s("a", "b"), [["old", s("a")]])).toBeUndefined();
    expect(renamedFrom(s(), [["empty", s()]])).toBe("empty");
    expect(renamedFrom(s(), [["e1", s()], ["e2", s()]])).toBeUndefined();
  });
});
