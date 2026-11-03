/**
 * The Annotate section: the layer new annotations go to, the tools that
 * draw them, its groups (shown or hidden, coloured, nested) and its fields
 * (a list of values, a number, text, or an ontology's terms).  The
 * annotations themselves are in the annotation table (./table_panel.ts).
 */
import type { Disposer, PlatformContext } from "@ngplatform/sdk";
import { type Annotate, TOOLS } from "./annotate.js";
import { addGroup, groupOf, groupPath, groupsOf, groupTree, hiddenValues, moveGroup, removeGroup, withinGroup, writeGroups } from "./groups.js";
import { TABLE_PANEL } from "./manifest.js";
import { parseTerms } from "./ontology.js";
import { button, el, select } from "./ui.js";
import { addField, type Field, fieldsOf, type FieldKind, GROUP, type OntologyRef, removeField, updateField } from "./values.js";

const KINDS: [FieldKind, string][] = [
  ["list", "List of values"],
  ["number", "Number"],
  ["text", "Text"],
  ["ontology", "Ontology term"],
];

const KIND_NAMES: Record<FieldKind, string> = { list: "list", number: "number", text: "text", ontology: "ontology", colour: "colour" };

/** An ontology read from a file is kept with its field, in the link: up to this many terms. */
const MAX_TERMS = 5000;

export class AnnotatePanel {
  /** The field being added or edited (its id; "" for a new one). */
  private editing: string | undefined;

  constructor(
    private readonly ctx: PlatformContext,
    private readonly model: Annotate,
  ) {}

  render(host: HTMLElement): Disposer {
    let shown = "";
    const draw = (force = false) => {
      const name = this.model.chosen();
      const layers = this.model.layers();
      const l = layers.find((x) => x.spec.name === name);
      const tool = this.model.currentTool();
      const counts = l ? l.spec.annotations.map((a) => groupOf(l.spec, a)) : [];
      // Moving about changes the state too: redraw only when what is shown changes.
      const key = JSON.stringify([name, layers.map((x) => [x.spec.name, x.managed]), l?.spec.annotationProperties, l?.meta.groups, l?.meta.fields, l?.meta.colourBy, l?.meta.activeGroup, tool, counts, this.editing]);
      if (key === shown && !force) return;
      shown = key;
      const editable = layers.filter((x) => !x.managed);
      const layerRow = el(
        "div",
        { class: "an-row" },
        editable.length
          ? select(
              editable.map((x) => [x.spec.name, `${x.spec.name} (${x.spec.annotations.length})`]),
              name ?? "",
              (v) => this.model.choose(v),
              "Layer",
            )
          : el("span", { class: "an-hint" }, "No annotation layer of yours yet."),
        button("+ New layer", () => this.model.newLayer(), "A local annotation layer, kept in the link"),
      );
      const tools = el("div", { class: "segmented an-tools" });
      for (const [id, label, title] of TOOLS) {
        tools.append(el("button", { type: "button", title, "aria-pressed": String(tool === id), onclick: () => this.model.useTool(id) }, label));
      }
      host.replaceChildren(
        layerRow,
        tools,
        el("p", { class: "an-hint" }, "Pick a tool, then Ctrl+click in a view (Ctrl+double-click ends a polyline). Each new annotation is selected in the annotation table, ready for its values. Pick the tool again to stop."),
        el("div", { class: "an-row" }, button("Annotation table", () => this.ctx.ui.showPanel(TABLE_PANEL), "The table of every annotation, in the bottom dock")),
        l ? this.groups(l.spec.name) : "",
        l ? this.fields(l.spec.name) : "",
      );
    };
    draw();
    const off = this.model.onChange(() => draw());
    this.redraw = () => draw(true);
    return () => {
      off();
      this.redraw = undefined;
    };
  }

  private redraw: (() => void) | undefined;

  // -------------------------------------------------------------- groups

  private groups(name: string): HTMLElement {
    const l = this.model.layer(name)!;
    const { spec, meta } = l;
    const groups = groupsOf(spec, meta);
    const counts = new Map<number, number>();
    for (const a of spec.annotations) counts.set(groupOf(spec, a), (counts.get(groupOf(spec, a)) ?? 0) + 1);
    const write = (next: typeof groups, active = meta.activeGroup, moved?: { from: number; to: number }) => {
      const [s, m] = writeGroups(spec, meta, next, active, moved);
      this.model.write(name, s, m);
    };
    // Groups hidden with a group they are in.
    const hidden = new Set(hiddenValues(groups));
    const rows = groupTree(groups).map(({ group: g, depth }) => {
      const shown = el("input", { type: "checkbox", title: "Shown in the views" }) as HTMLInputElement;
      shown.checked = !g.hidden;
      shown.addEventListener("change", () => write(groups.map((x) => (x.value === g.value ? { ...x, hidden: !shown.checked } : x))));
      const colour = el("input", { type: "color", value: g.colour, title: "Its colour, when the layer is coloured by group" }) as HTMLInputElement;
      colour.addEventListener("change", () => {
        const next = groups.map((x) => (x.value === g.value ? { ...x, colour: colour.value } : x));
        const [s, m] = writeGroups(spec, { ...meta, colourBy: meta.colourBy ?? GROUP }, next);
        this.model.write(name, s, m);
      });
      const title = el("input", { class: "text-input", value: g.name, "aria-label": "Group name" }) as HTMLInputElement;
      title.addEventListener("change", () => {
        const text = title.value.trim().replace(/\s*\/\s*/g, " - ");
        if (text) write(groups.map((x) => (x.value === g.value ? { ...x, name: text } : x)));
      });
      // Not into itself, or a group within it.
      const within = withinGroup(groups, g.value);
      const parents: [string, string][] = [["", "Move to the top"], ...groups.filter((x) => !within.has(x.value)).map((x) => [String(x.value), `Move into ${groupPath(groups, x.value)}`] as [string, string])];
      const parent = select(parents, g.parent === undefined ? "" : String(g.parent), (v) => write(moveGroup(groups, g.value, v === "" ? undefined : Number(v))), "Move");
      parent.className = "an-group-parent";
      parent.title = "Move it to the top, or into another group";
      return el(
        "div",
        { class: `an-group${meta.activeGroup === g.value ? " an-active" : ""}${hidden.has(g.value) && !g.hidden ? " an-dim" : ""}`, style: `padding-left: ${depth * 14}px` },
        shown,
        colour,
        title,
        el("span", { class: "an-faint an-count", title: "Annotations in it" }, String(counts.get(g.value) ?? 0)),
        parent,
        button("+", () => write(addGroup(groups, "", g.value).groups), "A group within this one", "btn outline small icon"),
        button("×", () => {
          const { groups: rest, moveTo } = removeGroup(groups, g.value);
          write(rest, meta.activeGroup === g.value ? moveTo : meta.activeGroup, { from: g.value, to: moveTo });
        }, "Remove the group (its annotations go to the group it is in)", "btn outline small icon"),
      );
    });
    const fields = fieldsOf(spec, meta);
    const colourable: [string, string][] = [["", "Layer colour"], ...(groups.length ? [[GROUP, "Group"] as [string, string]] : []), ...fields.filter((f) => f.storage === "property").map((f) => [f.id, f.title] as [string, string])];
    const colourBy = select(colourable, meta.colourBy ?? "", (v) => {
      const m = { ...meta, colourBy: v || undefined };
      this.model.write(name, spec, m);
    }, "Colour by");
    const active = select([["0", "No group"], ...groups.map((g) => [String(g.value), g.name] as [string, string])], String(meta.activeGroup ?? 0), (v) => write(groups, Number(v) || undefined), "New annotations go to");
    return el(
      "div",
      { class: "an-block" },
      el("h4", { class: "an-sub" }, "Groups"),
      groups.length ? el("div", { class: "an-groups" }, ...rows) : el("p", { class: "an-hint" }, "Put annotations in named groups, nested if you like: shown or hidden together, and coloured."),
      el("div", { class: "an-row" }, button("+ Group", () => {
        const { groups: next, value } = addGroup(groups, "");
        write(next, meta.activeGroup ?? value);
      }, "A new group; new annotations go to it if none is chosen")),
      groups.length ? el("div", { class: "an-grid2" }, el("label", { class: "field" }, el("span", {}, "New annotations go to"), active), el("label", { class: "field" }, el("span", {}, "Colour by"), colourBy)) : el("label", { class: "field" }, el("span", {}, "Colour by"), colourBy),
    );
  }

  // -------------------------------------------------------------- fields

  private fields(name: string): HTMLElement {
    const l = this.model.layer(name)!;
    const fields = fieldsOf(l.spec, l.meta);
    const rows = fields.map((f) =>
      el(
        "div",
        { class: "an-field-row" },
        el(
          "div",
          {},
          el("div", {}, f.title),
          el("div", { class: "an-faint", title: f.storage === "property" ? "Kept as a Neuroglancer annotation property" : "Kept in this plugin's state, in the link" }, `${KIND_NAMES[f.kind]}${f.ontology ? ` (${f.ontology.title})` : ""} · ${f.storage === "property" ? "Neuroglancer property" : "plugin state"}`),
        ),
        f.kind === "colour" ? "" : button("Edit", () => this.edit(f.id), "Its name, and its values or terms", "btn outline small"),
        button("×", async () => {
          if (!(await this.ctx.ui.confirm(`Remove the field “${f.title}” and its values?`))) return;
          const now = this.model.layer(name)!;
          const [s, m] = removeField(now.spec, now.meta, f.id);
          this.model.write(name, s, m);
        }, "Remove the field and its values", "btn outline small icon"),
      ),
    );
    return el(
      "div",
      { class: "an-block" },
      el("h4", { class: "an-sub" }, "Fields"),
      fields.length ? el("div", { class: "an-fields" }, ...rows) : el("p", { class: "an-hint" }, "Values each annotation of the layer has: a cell type from a list, a number, a note, a structure from an ontology."),
      this.editing !== undefined ? this.form(name, fields.find((f) => f.id === this.editing)) : el("div", { class: "an-row" }, button("+ Field", () => this.edit(""), "A value the layer's annotations have")),
    );
  }

  private edit(id: string | undefined): void {
    this.editing = id;
    this.redraw?.();
  }

  /** Adding a field, or editing one. */
  private form(layer: string, field: Field | undefined): HTMLElement {
    let kind: FieldKind = field?.kind ?? "list";
    let ontology: OntologyRef | undefined = field?.ontology;
    const title = el("input", { class: "text-input", value: field?.title ?? "", placeholder: "Cell type", "aria-label": "Name" }) as HTMLInputElement;
    const values = el("textarea", { class: "text-input an-textarea", rows: 4, placeholder: "One value a line" }) as HTMLTextAreaElement;
    values.value = (field?.options ?? []).join("\n");
    const note = el("p", { class: "an-hint" });
    const tables = this.ctx.viewer.lookupTables.catalogue();
    const source = select(
      [["", ontology ? `${ontology.title}${ontology.terms ? ` (${ontology.terms.length} terms)` : ""}` : "Choose…"], ...tables.map((t) => [t.url, `${t.group}: ${t.title}`] as [string, string]), ["file", "A file on this computer…"]],
      "",
      (v) => {
        if (v === "file") file.click();
        else if (v) {
          const t = tables.find((x) => x.url === v)!;
          ontology = { title: t.title, url: t.url };
          note.textContent = t.fetched ? "Read from its publisher when first used." : "";
        }
      },
      "Terms from",
    );
    const file = el("input", { type: "file", accept: ".obo,.json,.txt,.csv,.tsv,.lst", hidden: true }) as HTMLInputElement;
    file.addEventListener("change", async () => {
      const f = file.files?.[0];
      if (f === undefined) return;
      try {
        const o = parseTerms(await f.text(), f.name);
        if (o.terms.length === 0) throw new Error("no terms in it");
        if (o.terms.length > MAX_TERMS) throw new Error(`${o.terms.length} terms; up to ${MAX_TERMS} are kept with a field`);
        ontology = o;
        note.textContent = `${o.terms.length} terms from ${f.name}.`;
        source.options[0].textContent = `${o.title} (${o.terms.length} terms)`;
        source.value = "";
      } catch (e) {
        note.textContent = `Could not read ${f.name}: ${(e as Error).message}.`;
      }
    });
    const kindSelect = select(KINDS, kind, (v) => {
      kind = v as FieldKind;
      show();
    }, "Kind");
    kindSelect.disabled = field !== undefined;
    const listPart = el("label", { class: "field" }, el("span", {}, "Values"), values, el("span", { class: "field-hint" }, "Kept as a Neuroglancer annotation property (an enum)."));
    const ontologyPart = el("label", { class: "field" }, el("span", {}, "Terms from"), source, file, el("span", { class: "field-hint" }, "A lookup table (the Allen structures among them), or a list, OBO or JSON file. The term is kept in this plugin's state."));
    const otherHint = el("p", { class: "an-hint" });
    const show = () => {
      listPart.hidden = kind !== "list";
      ontologyPart.hidden = kind !== "ontology";
      otherHint.textContent = kind === "number" ? "Kept as a Neuroglancer annotation property (float32); 0 when not set." : kind === "text" ? "Kept in this plugin's state, in the link." : "";
      otherHint.hidden = otherHint.textContent === "";
    };
    show();
    const save = () => {
      const now = this.model.layer(layer);
      if (now === undefined) return;
      const text = title.value.trim();
      const options = [...new Set(values.value.split(/\r?\n/).map((v) => v.trim()).filter((v) => v !== ""))];
      if (!text) return this.ctx.ui.toast("Give the field a name.", "error");
      if (kind === "ontology" && ontology === undefined) return this.ctx.ui.toast("Choose where its terms come from.", "error");
      if (field === undefined && fieldsOf(now.spec, now.meta).some((f) => f.title.toLowerCase() === text.toLowerCase())) return this.ctx.ui.toast(`The layer has a field “${text}” already.`, "error");
      const [s, m] =
        field === undefined
          ? addField(now.spec, now.meta, { id: "", title: text, kind, ...(kind === "list" ? { options } : {}), ...(kind === "ontology" ? { ontology } : {}) })
          : updateField(now.spec, now.meta, field.id, { title: text, ...(kind === "list" ? { options } : {}), ...(kind === "ontology" ? { ontology } : {}) });
      this.editing = undefined;
      this.model.write(layer, s, m);
    };
    return el(
      "div",
      { class: "an-form" },
      el("div", { class: "an-grid2" }, el("label", { class: "field" }, el("span", {}, "Name"), title), el("label", { class: "field" }, el("span", {}, "Kind"), kindSelect)),
      listPart,
      ontologyPart,
      otherHint,
      note,
      el("div", { class: "an-row" }, button(field ? "Save" : "Add field", save, undefined, "btn primary small"), button("Cancel", () => this.edit(undefined))),
    );
  }
}
