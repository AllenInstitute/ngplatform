/**
 * The annotation table, in the bottom dock: every annotation of the
 * scene's local annotation layers, found by a query, sorted by a column;
 * a click goes to one and selects it, and the editor beside the table sets
 * its name, group, values and comments, or deletes it.  The table is saved
 * as CSV, and CSV read into the layers.
 */
import type { Disposer, PlatformContext } from "@ngplatform/sdk";
import type { Annotate, Selected } from "./annotate.js";
import { groupOf, groupsOf, groupTree, setGroup, addGroup, writeGroups } from "./groups.js";
import { findTerm, searchTerms, termLabel } from "./ontology.js";
import { BUILTIN_COLUMNS, type Column, fieldColumns, importCsv, matches, parseQuery, type Row, rowName, sortRows, tableCsv, type TableLayer } from "./table.js";
import { button, csv, download, el, fileName, physical, select } from "./ui.js";
import { type Field, fieldsOf, readValue, setValue, valueText } from "./values.js";

/** Rows drawn at once; a query finds the others. */
const MAX_ROWS = 500;

const POWER = { length: 1, area: 2, volume: 3 } as const;

export class TablePanel {
  private query = "";
  /** "" for every layer. */
  private layer = "";
  private sort: { key: string; descending: boolean } | undefined;

  constructor(
    private readonly ctx: PlatformContext,
    private readonly model: Annotate,
  ) {}

  /** The layers shown, their rows (found and sorted) and columns. */
  private view(): { layers: TableLayer[]; rows: Row[]; all: number; columns: Column[]; fields: Field[] } {
    const layers = this.model.layers().filter((l) => this.layer === "" || l.spec.name === this.layer);
    const fields = layers.flatMap((l) => fieldsOf(l.spec, l.meta));
    // Fields after the name and group, before the size; the layer when there are several.
    const columnsOf = (f: Field[], several: boolean) => {
      const builtin = BUILTIN_COLUMNS.filter((c) => c.key !== "id" && (c.key !== "layer" || several));
      return [...builtin.slice(0, 3), ...fieldColumns(f), ...builtin.slice(3)];
    };
    const all = this.model.rows(layers);
    const terms = parseQuery(this.query);
    let rows = terms.length ? all.filter((r) => matches(r, terms, [...columnsOf(fields, true), BUILTIN_COLUMNS.find((c) => c.key === "id")!])) : all;
    // The fields of the layers whose annotations are found.
    const found = new Set(rows.map((r) => r.layer));
    const shown = rows.length ? layers.filter((l) => found.has(l.spec.name)).flatMap((l) => fieldsOf(l.spec, l.meta)) : fields;
    const columns = columnsOf(shown, (rows.length ? found.size : layers.length) > 1);
    const sortBy = this.sort && columns.find((c) => c.key === this.sort!.key);
    if (sortBy) rows = sortRows(rows, sortBy, this.sort!.descending);
    return { layers, rows, all: all.length, columns, fields: shown };
  }

  render(host: HTMLElement): Disposer {
    host.classList.add("an-table-panel");
    const search = el("input", { class: "text-input an-search", type: "search", placeholder: "Find: text, or celltype:basket, size>2, group=, -word", "aria-label": "Find annotations", value: this.query }) as HTMLInputElement;
    search.addEventListener("input", () => {
      this.query = search.value;
      draw(true);
    });
    const layerSlot = el("span", {});
    const count = el("span", { class: "an-faint an-count" });
    const file = el("input", { type: "file", accept: ".csv,text/csv", hidden: true }) as HTMLInputElement;
    file.addEventListener("change", () => {
      const f = file.files?.[0];
      file.value = "";
      if (f) void this.importFile(f);
    });
    const toolbar = el(
      "div",
      { class: "an-row an-toolbar" },
      search,
      layerSlot,
      count,
      el("span", { class: "an-spacer" }),
      button("Save CSV", () => this.exportCsv(), "The rows found, as CSV: values, sizes, comments and coordinates"),
      button("Open CSV…", () => file.click(), "Add or update annotations from a CSV table (as saved here, or a spreadsheet's)"),
      button("Delete found…", () => void this.deleteFound(), "Delete every annotation the query finds"),
      file,
    );
    const tableWrap = el("div", { class: "an-table-scroll" });
    const editor = el("div", { class: "an-editor" });
    host.append(toolbar, el("div", { class: "an-table-body" }, tableWrap, editor));

    let shown = "";
    let shownEditor = "";
    const draw = (force = false) => {
      // Hidden (another tab of the dock, or the dock closed): drawn when shown again.
      if (host.offsetParent === null) {
        shown = shownEditor = "";
        return;
      }
      const v = this.view();
      const selected = this.model.selected;
      const key = JSON.stringify([v.rows.map((r) => [r.layer, r.id, r.description, r.groupPath, r.values, r.size?.value, r.comments.length]), v.columns.map((c) => c.key), this.sort, v.all, this.model.layers().map((l) => l.spec.name), this.layer]);
      if (key !== shown || force) {
        shown = key;
        this.drawTable(tableWrap, v, layerSlot, count, () => draw(true));
      }
      // The selected row, and its editor.
      for (const tr of tableWrap.querySelectorAll<HTMLElement>("tr[data-key]")) tr.classList.toggle("an-current", tr.dataset.key === (selected ? `${selected.layer}|${selected.id}` : ""));
      const l = selected && this.model.layer(selected.layer);
      const a = l?.spec.annotations.find((x) => x.id === selected!.id);
      const editorKey = JSON.stringify([selected, a, l?.meta.values[selected?.id ?? ""], l?.meta.comments[selected?.id ?? ""], l?.spec.annotationProperties, l?.meta.fields, l?.meta.groups]);
      if (editorKey !== shownEditor || force) {
        // Keep what is being typed: an editor is drawn again only when it is not focused, or its annotation changed
        // (and when the focus leaves it).
        const typing = editor.contains(document.activeElement) && editor.dataset.key === (selected ? `${selected.layer}|${selected.id}` : "");
        if (!typing || force) {
          shownEditor = editorKey;
          this.drawEditor(editor, selected);
        }
      }
      if (selected && (key !== shown || force)) tableWrap.querySelector(`tr.an-current`)?.scrollIntoView({ block: "nearest" });
    };
    draw();
    let last: string | undefined;
    const off = this.model.onChange(() => {
      const now = this.model.selected ? `${this.model.selected.layer}|${this.model.selected.id}` : "";
      draw();
      if (now !== last) {
        last = now;
        tableWrap.querySelector("tr.an-current")?.scrollIntoView({ block: "nearest" });
      }
    });
    editor.addEventListener("focusout", (e) => {
      if (!editor.contains(e.relatedTarget as Node | null)) requestAnimationFrame(() => draw());
    });
    const visible = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) draw();
    });
    visible.observe(host);
    return () => {
      off();
      visible.disconnect();
    };
  }

  private drawTable(host: HTMLElement, v: ReturnType<TablePanel["view"]>, layerSlot: HTMLElement, count: HTMLElement, redraw: () => void): void {
    const names = this.model.layers().map((l) => l.spec.name);
    if (this.layer && !names.includes(this.layer)) this.layer = "";
    layerSlot.replaceChildren(
      select([["", "Every layer"], ...names.map((n) => [n, n] as [string, string])], this.layer, (value) => {
        this.layer = value;
        redraw();
      }, "Layer"),
    );
    count.textContent = v.rows.length === v.all ? `${v.all} annotation${v.all === 1 ? "" : "s"}` : `${v.rows.length} of ${v.all}`;
    if (v.all === 0) {
      host.replaceChildren(el("p", { class: "empty" }, names.length ? "No annotations yet: pick a tool in Annotations → Annotate and Ctrl+click in a view." : "No local annotation layer in this scene: make one in Annotations → Annotate."));
      return;
    }
    const head = el(
      "tr",
      {},
      ...v.columns.map((c) => {
        const on = this.sort?.key === c.key;
        return el(
          "th",
          {
            class: `an-sortable${c.number ? " num" : ""}`,
            title: `Sort by ${c.title.toLowerCase()}`,
            "aria-sort": on ? (this.sort!.descending ? "descending" : "ascending") : undefined,
            onclick: () => {
              this.sort = on && !this.sort!.descending ? { key: c.key, descending: true } : on ? undefined : { key: c.key, descending: false };
              redraw();
            },
          },
          c.key === "comments" ? "💬" : c.title,
          on ? (this.sort!.descending ? " ▾" : " ▴") : "",
        );
      }),
    );
    const body = el("tbody", {});
    for (const r of v.rows.slice(0, MAX_ROWS)) {
      const cells = v.columns.map((c) => {
        if (c.key === "size") return el("td", { class: "num" }, r.size ? physical(r.size.value, POWER[r.size.quantity]) : "");
        if (c.key === "comments") return el("td", { class: "num", title: r.comments.map((x) => x.text).join("\n") }, r.comments.length ? String(r.comments.length) : "");
        if (c.key === "type") return el("td", { class: "an-faint" }, c.text(r));
        if (c.number) return el("td", { class: "num" }, c.text(r));
        return el("td", {}, c.text(r));
      });
      body.append(el("tr", { class: "an-click", "data-key": `${r.layer}|${r.id}`, onclick: () => this.model.select({ layer: r.layer, id: r.id }) }, ...cells));
    }
    host.replaceChildren(
      el("table", { class: "an-table" }, el("thead", {}, head), body),
      v.rows.length > MAX_ROWS ? el("p", { class: "an-hint" }, `The first ${MAX_ROWS} of ${v.rows.length}: a query finds the others.`) : "",
      v.rows.length === 0 ? el("p", { class: "empty" }, "No annotation matches.") : "",
    );
  }

  // -------------------------------------------------------------- editor

  private drawEditor(host: HTMLElement, selected: Selected | undefined): void {
    const l = selected && this.model.layer(selected.layer);
    const a = l?.spec.annotations.find((x) => x.id === selected!.id);
    const key = selected ? `${selected.layer}|${selected.id}` : "";
    // Another annotation's editor starts at its top.
    if (host.dataset.key !== key) host.scrollTop = 0;
    host.dataset.key = key;
    if (!selected || l === undefined || a === undefined) {
      host.replaceChildren(el("p", { class: "an-hint" }, "Click a row to go to its annotation and edit it here; a new annotation drawn in a view comes here too."));
      return;
    }
    const name = selected.layer;
    const fields = fieldsOf(l.spec, l.meta);
    const row = this.model.rows([{ ...l, spec: { ...l.spec, annotations: [a] } }])[0];
    const edit = (change: (layer: TableLayer) => [TableLayer["spec"], TableLayer["meta"]]) => {
      const now = this.model.layer(name);
      if (now === undefined) return;
      const [spec, meta] = change(now);
      this.model.write(name, spec, meta);
    };
    const parts: (HTMLElement | string)[] = [];
    parts.push(
      el(
        "div",
        { class: "an-editor-head" },
        el("strong", {}, rowName(row)),
        el("span", { class: "an-faint" }, `${row.size ? physical(row.size.value, POWER[row.size.quantity]) + " · " : ""}${name}`),
      ),
      el(
        "div",
        { class: "an-row" },
        button("Go to", () => this.model.select(selected), "Move the views to it"),
        button("Delete", () => this.model.delete([selected]), "Delete the annotation (Undo brings it back)"),
      ),
    );
    if (l.managed) {
      parts.push(el("p", { class: "an-hint" }, "A region of track filtering: its name and shape are set in the Filtering tab. Comments are kept here."));
    } else {
      const description = el("input", { class: "text-input", value: a.description ?? "", placeholder: "Name or description", "aria-label": "Description" }) as HTMLInputElement;
      description.addEventListener("change", () =>
        edit(({ spec, meta }) => [
          {
            ...spec,
            annotations: spec.annotations.map((x) => {
              if (x.id !== a.id) return x;
              const { description: _old, ...rest } = x;
              return description.value.trim() ? { ...rest, description: description.value.trim() } : rest;
            }),
          },
          meta,
        ]),
      );
      parts.push(el("label", { class: "field" }, el("span", {}, "Description"), description));
      const groups = groupsOf(l.spec, l.meta);
      const group = select(
        [["0", "No group"], ...groupTree(groups).map(({ group: g, depth }) => [String(g.value), `${"  ".repeat(depth)}${g.name}`] as [string, string]), ["new", "New group…"]],
        String(groupOf(l.spec, a)),
        async (v) => {
          if (v !== "new") return edit(({ spec, meta }) => [setGroup(spec, [a.id], Number(v)), meta]);
          const answer = await this.ctx.ui.form<{ name: string }>("New group", { type: "object", properties: { name: { type: "string", title: "Name" } }, required: ["name"] });
          if (!answer?.name.trim()) return this.drawEditor(host, selected);
          edit(({ spec, meta }) => {
            const { groups: next, value } = addGroup(groupsOf(spec, meta), answer.name);
            const [s, m] = writeGroups(spec, meta, next);
            return [setGroup(s, [a.id], value), m];
          });
        },
        "Group",
      );
      parts.push(el("label", { class: "field" }, el("span", {}, "Group"), group));
      for (const f of fields) parts.push(this.fieldControl(f, l, a.id, (value) => edit(({ spec, meta }) => setValue(spec, meta, [a.id], fieldsOf(spec, meta).find((x) => x.id === f.id)!, value))));
    }
    // Comments.
    const comments = l.meta.comments[a.id] ?? [];
    const text = el("textarea", { class: "text-input an-textarea", rows: 2, placeholder: "A comment (Ctrl+Enter adds it)", "aria-label": "Comment" }) as HTMLTextAreaElement;
    const add = () => {
      if (!text.value.trim()) return;
      this.model.addComment(selected, text.value);
      text.value = "";
    };
    text.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        add();
      }
    });
    parts.push(
      el("h4", { class: "an-sub" }, "Comments"),
      ...comments.map((c, i) =>
        el(
          "div",
          { class: "an-comment" },
          el("div", { class: "an-faint" }, c.time.slice(0, 16).replace("T", " "), button("×", () => this.model.removeComment(selected, i), "Remove the comment", "btn small icon an-comment-x")),
          el("div", {}, c.text),
        ),
      ),
      text,
      el("div", { class: "an-row" }, button("Add comment", add)),
    );
    host.replaceChildren(...parts);
  }

  /** The control setting one field's value. */
  private fieldControl(f: Field, l: TableLayer, id: string, set: (value: string | number | { id: string; name: string } | undefined) => void): HTMLElement {
    const a = l.spec.annotations.find((x) => x.id === id)!;
    const value = readValue(f, a, l.spec, l.meta);
    const where = f.storage === "property" ? "A Neuroglancer annotation property" : "Kept in this plugin's state";
    let control: HTMLElement;
    if (f.kind === "list") {
      control = select([["", "–"], ...f.options!.map((o) => [o, o] as [string, string])], typeof value === "string" ? value : "", (v) => set(v), f.title);
    } else if (f.kind === "number") {
      const input = el("input", { class: "text-input", type: "number", step: "any", value: valueText(value), "aria-label": f.title }) as HTMLInputElement;
      input.addEventListener("change", () => set(input.value === "" ? undefined : Number(input.value)));
      control = input;
    } else if (f.kind === "text") {
      const input = el("input", { class: "text-input", value: valueText(value), "aria-label": f.title }) as HTMLInputElement;
      input.addEventListener("change", () => set(input.value));
      control = input;
    } else if (f.kind === "ontology") {
      const list = this.model.termList(f);
      const listId = `an-terms-${Math.random().toString(36).slice(2)}`;
      const options = el("datalist", { id: listId });
      const input = el("input", { class: "text-input", value: valueText(value), placeholder: typeof list === "string" ? list : `Search ${list.length} terms`, list: listId, "aria-label": f.title }) as HTMLInputElement;
      const suggest = () => {
        const terms = this.model.termList(f);
        if (typeof terms === "string") return;
        options.replaceChildren(...searchTerms(terms, input.value, 40).map((t) => el("option", { value: termLabel(t) })));
      };
      input.addEventListener("focus", suggest);
      input.addEventListener("input", suggest);
      input.addEventListener("change", () => {
        const terms = this.model.termList(f);
        if (input.value.trim() === "") return set(undefined);
        const t = typeof terms === "string" ? undefined : findTerm(terms, input.value);
        if (t === undefined) {
          this.ctx.ui.toast(`No term “${input.value}” in ${f.ontology?.title ?? "the list"}.`, "error");
          input.value = valueText(value);
          return;
        }
        set({ id: t.id, name: t.name });
      });
      control = el("span", { class: "an-inline-wide" }, input, options);
    } else {
      control = el("span", { class: "an-inline" }, el("span", { class: "an-swatch big", style: `background: ${String(value)}` }), String(value ?? ""));
    }
    return el("label", { class: "field", title: where }, el("span", {}, f.title), control);
  }

  // ------------------------------------------------------------- actions

  private exportCsv(): void {
    const v = this.view();
    const titles = [...new Set(v.fields.map((f) => f.title))];
    const name = v.layers.length === 1 ? v.layers[0].spec.name : "annotations";
    download(new Blob([csv(tableCsv(v.rows, titles))], { type: "text/csv" }), `${fileName(name)}.csv`);
  }

  private async importFile(file: File): Promise<void> {
    const layers = new Map(this.model.layers().map((l) => [l.spec.name, l]));
    const target = this.layer || this.model.chosen();
    const terms = (f: Field) => {
      const list = this.model.termList(f);
      return typeof list === "string" ? undefined : list;
    };
    const result = importCsv(await file.text(), layers, target, () => crypto.randomUUID().replace(/-/g, ""), terms);
    for (const [name, l] of result.layers) this.model.write(name, l.spec, l.meta);
    const message = `${file.name}: ${result.added} added, ${result.updated} updated${result.skipped ? `, ${result.skipped} skipped` : ""}.`;
    this.ctx.ui.toast([message, ...result.notes.slice(0, 3)].join(" "), result.skipped && !result.added && !result.updated ? "error" : "info");
    for (const n of result.notes) this.ctx.log.info(n);
  }

  /** Deletes the annotations found, but track filtering's regions (deleted one at a time, or in its tab). */
  private async deleteFound(): Promise<void> {
    const found = this.view().rows;
    const rows = found.filter((r) => !r.managed);
    if (rows.length === 0) return this.ctx.ui.toast(found.length ? "The annotations found are track filtering's regions: delete them one at a time, or in the Filtering tab." : "Nothing found to delete.");
    const kept = found.length - rows.length;
    if (!(await this.ctx.ui.confirm(`Delete the ${rows.length} annotation${rows.length === 1 ? "" : "s"} found${this.query ? ` by “${this.query}”` : ""}${kept ? ` (not the ${kept} track filtering region${kept === 1 ? "" : "s"})` : ""}? Undo brings them back.`))) return;
    this.model.delete(rows.map((r) => ({ layer: r.layer, id: r.id })));
  }
}
