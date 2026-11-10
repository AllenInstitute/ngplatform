/**
 * The Annotate card: the layer new annotations go to, its groups (shown
 * or hidden, coloured, nested) and its fields (a list of values, a number,
 * text, or an ontology's terms).  They are drawn with the layer's own tools
 * (Layers → the layer's Annotations tab), which "Draw" opens; the
 * annotations themselves are in the annotation table (./table_panel.ts).
 */
import type { Disposer, PlatformContext } from "@ngplatform/sdk";
import { button, checkbox, el, emptyState, field, iconButton, info, region, select } from "@ngplatform/sdk/dom";
import type { Annotate } from "./annotate.js";
import { addGroup, groupOf, groupPath, groupsOf, groupTree, hiddenValues, moveGroup, removeGroup, withinGroup, writeGroups } from "./groups.js";
import { TABLE_PANEL } from "./manifest.js";
import { parseTerms } from "./ontology.js";
import { addField, type Field, fieldsOf, type FieldKind, GROUP, type Group, type LayerMeta, type OntologyRef, removeField, updateField } from "./values.js";

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

  /**
   * Drawn once: the layer's row, its groups and its fields are each a
   * region drawn again only when what it shows changes (moving about
   * changes the state too), so editing a field is not lost when a group
   * changes.
   */
  render(host: HTMLElement): Disposer {
    // Each region's key is the layer and what it shows; its drawing reads the layer chosen.
    const shown = () => {
      const name = this.model.chosen();
      return name !== undefined && this.model.layer(name) !== undefined ? name : undefined;
    };
    const top = region(() => this.layerRow());
    const groups = region(() => {
      const name = shown();
      return name ? this.groups(name) : [];
    });
    const fields = region(() => {
      const name = shown();
      return name ? this.fields(name) : [];
    });
    // The field being added or edited: its own region, so what is typed in it stays while the layer changes.
    const form = region(() => {
      const name = shown();
      const l = name === undefined ? undefined : this.model.layer(name);
      return name === undefined || l === undefined || this.editing === undefined ? [] : this.form(name, fieldsOf(l.spec, l.meta).find((f) => f.id === this.editing));
    });
    host.append(el("div", { class: "stack" }, top, groups, el("div", { class: "stack" }, fields, form)));
    const draw = () => {
      const name = this.model.chosen();
      const layers = this.model.layers();
      const l = layers.find((x) => x.spec.name === name);
      top.update([name, layers.map((x) => [x.spec.name, x.managed, x.spec.annotations.length])]);
      groups.update(l && [name, l.spec.annotations.map((a) => groupOf(l.spec, a)), l.spec.annotationProperties, l.meta.groups, l.meta.fields, l.meta.colourBy, l.meta.activeGroup]);
      fields.update(l && [name, l.spec.annotationProperties, l.meta.fields, this.editing !== undefined]);
      form.update(l && [name, this.editing]);
    };
    draw();
    const off = this.model.onChange(draw);
    this.redraw = draw;
    return () => {
      off();
      this.redraw = undefined;
    };
  }

  private redraw: (() => void) | undefined;

  /** The layer new annotations go to (or the action that makes one), Draw… and the table. */
  private layerRow(): HTMLElement {
    const name = this.model.chosen();
    const editable = this.model.layers().filter((x) => !x.managed);
    const newLayer = () => this.model.newLayer();
    // Drawing is in one place, the layer's own Annotations tab; each new annotation is selected in the table.
    const drawIn = () => {
      if (name === undefined) return;
      this.ctx.workspace.selectLayer(name);
      this.ctx.viewer.patchState(
        (ng) => {
          const spec = ((ng as { layers?: Record<string, unknown>[] }).layers ?? []).find((x) => x.name === name);
          if (spec !== undefined) spec.tab = "annotations";
        },
        { quiet: true },
      );
      this.ctx.ui.showPanel("layers");
    };
    const openTable = button("Open table", () => this.ctx.ui.showPanel(TABLE_PANEL), "The table of every annotation, in the Activity dock");
    if (editable.length === 0) return el("div", { class: "stack" }, emptyState("No annotation layer yet.", { label: "+ New layer", run: newLayer }), el("div", { class: "row" }, openTable));
    return el(
      "div",
      { class: "stack" },
      el(
        "div",
        { class: "row an-layer" },
        field("Layer", select(editable.map((x) => [x.spec.name, `${x.spec.name} (${x.spec.annotations.length})`]), name ?? "", (v) => this.model.choose(v), "Layer")),
        button("+ New layer", newLayer, "A local annotation layer, kept in the link"),
      ),
      el(
        "div",
        { class: "row" },
        button("Draw…", drawIn, "Draw with the layer's tools (Layers → Annotations)"),
        info("Draw… opens the layer's Annotations tab in Layers, with its tools: Ctrl+click in a view to draw. Each new annotation is selected in the annotation table, ready for its values.", "About drawing"),
        openTable,
      ),
    );
  }

  // -------------------------------------------------------------- groups

  private groups(name: string): HTMLElement {
    const l = this.model.layer(name)!;
    const { spec, meta } = l;
    const groups = groupsOf(spec, meta);
    const counts = new Map<number, number>();
    for (const a of spec.annotations) counts.set(groupOf(spec, a), (counts.get(groupOf(spec, a)) ?? 0) + 1);
    // Each change starts from the layer as it is now: its annotations' values may have changed since this was drawn.
    type Change = { groups: Group[]; active?: number; moved?: { from: number; to: number }; colourBy?: string };
    const write = (edit: (groups: Group[], meta: LayerMeta) => Change) => {
      const now = this.model.layer(name);
      if (now === undefined) return;
      const c = edit(groupsOf(now.spec, now.meta), now.meta);
      const [s, m] = writeGroups(now.spec, "colourBy" in c ? { ...now.meta, colourBy: c.colourBy } : now.meta, c.groups, "active" in c ? c.active : now.meta.activeGroup, c.moved);
      this.model.write(name, s, m);
    };
    const addTop = () =>
      write((gs, m) => {
        const { groups: next, value } = addGroup(gs, "");
        return { groups: next, active: m.activeGroup ?? value };
      });
    // Groups hidden with a group they are in.
    const hidden = new Set(hiddenValues(groups));
    const rows = groupTree(groups).map(({ group: g, depth }) => {
      const shown = checkbox(`Show ${g.name || "the group"}`, !g.hidden, (on) => write((gs) => ({ groups: gs.map((x) => (x.value === g.value ? { ...x, hidden: !on } : x)) })), { hideLabel: true });
      const colour = el("input", { type: "color", class: "colour-input", value: g.colour, "aria-label": `Colour of ${g.name || "the group"}` }) as HTMLInputElement;
      colour.addEventListener("change", () => write((gs, m) => ({ groups: gs.map((x) => (x.value === g.value ? { ...x, colour: colour.value } : x)), colourBy: m.colourBy ?? GROUP })));
      const title = el("input", { class: "text-input", value: g.name, "aria-label": "Group name" }) as HTMLInputElement;
      title.addEventListener("change", () => {
        // " / " separates a path's groups.
        const text = title.value.trim().replace(/\s+\/\s+/g, " - ");
        if (text) write((gs) => ({ groups: gs.map((x) => (x.value === g.value ? { ...x, name: text } : x)) }));
      });
      // Not into itself, or a group within it.
      const within = withinGroup(groups, g.value);
      const parents: [string, string][] = [["", "Move to the top"], ...groups.filter((x) => !within.has(x.value)).map((x) => [String(x.value), `Move into ${groupPath(groups, x.value)}`] as [string, string])];
      const parent = select(parents, g.parent === undefined ? "" : String(g.parent), (v) => write((gs) => ({ groups: moveGroup(gs, g.value, v === "" ? undefined : Number(v)) })), "Move");
      parent.className = "text-input an-group-parent";
      return el(
        "div",
        { class: `an-group${meta.activeGroup === g.value ? " an-active" : ""}${hidden.has(g.value) && !g.hidden ? " an-dim" : ""}`, "data-depth": String(Math.min(depth, 6)) },
        shown,
        colour,
        title,
        el("span", { class: "faint an-count", "aria-label": "Annotations in it" }, String(counts.get(g.value) ?? 0)),
        parent,
        iconButton("plus", "A group within this one", () => write((gs) => ({ groups: addGroup(gs, "", g.value).groups }))),
        iconButton("close", "Remove the group (its annotations go to the group it is in)", () =>
          write((gs, m) => {
            const { groups: rest, moveTo } = removeGroup(gs, g.value);
            return { groups: rest, active: m.activeGroup === g.value ? moveTo : m.activeGroup, moved: { from: g.value, to: moveTo } };
          }),
        ),
      );
    });
    const fields = fieldsOf(spec, meta);
    const colourable: [string, string][] = [["", "Layer colour"], ...(groups.length ? [[GROUP, "Group"] as [string, string]] : []), ...fields.filter((f) => f.storage === "property").map((f) => [f.id, f.title] as [string, string])];
    const colourBy = select(colourable, meta.colourBy ?? "", (v) => write((gs) => ({ groups: gs, colourBy: v || undefined })), "Colour by");
    const active = select([["0", "No group"], ...groupTree(groups).map(({ group: g }) => [String(g.value), groupPath(groups, g.value)] as [string, string])], String(meta.activeGroup ?? 0), (v) => write((gs) => ({ groups: gs, active: Number(v) || 0 })), "New annotations go to");
    return el(
      "div",
      { class: "stack" },
      el("h4", { class: "section-title" }, "Groups", info("Groups are shown or hidden together and coloured, and can be nested: tick to show one (and the groups in it), pick its colour, and move it into another.", "About groups")),
      groups.length ? el("div", { class: "an-groups" }, ...rows) : emptyState("No groups.", { label: "+ Group", run: addTop }),
      groups.length ? el("div", { class: "row" }, button("+ Group", addTop, "A new group; new annotations go to it if none is chosen")) : null,
      groups.length ? el("div", { class: "grid-2" }, field("New annotations go to", active), field("Colour by", colourBy)) : field("Colour by", colourBy),
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
        el("div", {}, el("div", {}, f.title), el("div", { class: "faint" }, `${KIND_NAMES[f.kind]}${f.ontology ? ` (${f.ontology.title})` : ""} · ${f.storage === "property" ? "Neuroglancer property" : "plugin state"}`)),
        f.kind === "colour" ? "" : button("Edit", () => this.edit(f.id), "Its name, and its values or terms"),
        iconButton("close", `Remove the field ${f.title} and its values`, async () => {
          if (!(await this.ctx.ui.confirm(`Remove the field “${f.title}” and its values?`))) return;
          const now = this.model.layer(name)!;
          const [s, m] = removeField(now.spec, now.meta, f.id);
          this.model.write(name, s, m);
        }),
      ),
    );
    const add = () => this.edit("");
    return el(
      "div",
      { class: "stack" },
      el("h4", { class: "section-title" }, "Fields", info("Values each annotation of the layer has: a cell type from a list, a number, a note, a structure from an ontology. Lists and numbers are kept as Neuroglancer annotation properties; text and terms in this plugin's state, in the link.", "About fields")),
      fields.length ? el("div", { class: "an-fields" }, ...rows) : this.editing === undefined ? emptyState("No fields.", { label: "+ Field", run: add }) : null,
      this.editing === undefined && fields.length ? el("div", { class: "row" }, button("+ Field", add, "A value the layer's annotations have")) : null,
    );
  }

  private edit(id: string | undefined): void {
    this.editing = id;
    this.redraw?.();
  }

  /** Adding a field, or editing one. */
  private form(layer: string, existing: Field | undefined): HTMLElement {
    let kind: FieldKind = existing?.kind ?? "list";
    let ontology: OntologyRef | undefined = existing?.ontology;
    const title = el("input", { class: "text-input", value: existing?.title ?? "", placeholder: "Cell type", "aria-label": "Name" }) as HTMLInputElement;
    const values = el("textarea", { class: "text-input an-textarea", rows: 4, placeholder: "One value a line" }) as HTMLTextAreaElement;
    values.value = (existing?.options ?? []).join("\n");
    // What was read for the terms, or why not.
    const note = el("p", { class: "hint" });
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
        note.className = "hint";
        note.textContent = `${o.terms.length} terms from ${f.name}.`;
        source.options[0].textContent = `${o.title} (${o.terms.length} terms)`;
        source.value = "";
      } catch (e) {
        note.className = "hint error";
        note.textContent = `Could not read ${f.name}: ${(e as Error).message}.`;
      }
    });
    const kindSelect = select(KINDS, kind, (v) => {
      kind = v as FieldKind;
      show();
    }, "Kind");
    kindSelect.disabled = existing !== undefined;
    const listPart = field("Values", values, { info: "One value a line, kept as a Neuroglancer annotation property (an enum)." });
    const ontologyPart = field("Terms from", el("div", {}, source, file), { info: "A lookup table (the Allen structures among them), or a list, OBO or JSON file. The term is kept in this plugin's state." });
    const show = () => {
      listPart.hidden = kind !== "list";
      ontologyPart.hidden = kind !== "ontology";
    };
    show();
    const save = () => {
      const now = this.model.layer(layer);
      if (now === undefined) return;
      const text = title.value.trim();
      const options = [...new Set(values.value.split(/\r?\n/).map((v) => v.trim()).filter((v) => v !== ""))];
      if (!text) return this.ctx.ui.toast("Give the field a name.", "error");
      if (kind === "ontology" && ontology === undefined) return this.ctx.ui.toast("Choose where its terms come from.", "error");
      if (fieldsOf(now.spec, now.meta).some((f) => f.id !== existing?.id && f.title.toLowerCase() === text.toLowerCase())) return this.ctx.ui.toast(`The layer has a field “${text}” already.`, "error");
      const [s, m] =
        existing === undefined
          ? addField(now.spec, now.meta, { id: "", title: text, kind, ...(kind === "list" ? { options } : {}), ...(kind === "ontology" ? { ontology } : {}) })
          : updateField(now.spec, now.meta, existing.id, { title: text, ...(kind === "list" ? { options } : {}), ...(kind === "ontology" ? { ontology } : {}) });
      this.editing = undefined;
      this.model.write(layer, s, m);
    };
    return el(
      "div",
      { class: "an-form stack" },
      el(
        "div",
        { class: "grid-2" },
        field("Name", title),
        field("Kind", kindSelect, {
          info: existing
            ? "A field's kind cannot be changed: remove it and add another."
            : "A list of values or a number is kept as a Neuroglancer annotation property (a number is 0 when not set); text and an ontology's term in this plugin's state, in the link.",
        }),
      ),
      listPart,
      ontologyPart,
      note,
      el("div", { class: "row" }, button(existing ? "Save" : "Add field", save, undefined, "btn primary small"), button("Cancel", () => this.edit(undefined))),
    );
  }
}
