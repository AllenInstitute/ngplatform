/**
 * The tool bar over the views while a label volume is edited, as
 * WebKnossos's: the tools, the brush's size or the fill's reach in 2-D or
 * 3-D, the active segment and New segment, undo, redo, interpolation and
 * saving.  It sits at the top of the 2-D views, centred over them (not
 * over the 3-D view, where the left button rotates).
 */
import type { Disposer, PlatformContext } from "@ngplatform/sdk";
import { el } from "@ngplatform/sdk/dom";
import type { Editor } from "./editor.js";
import { iconButton } from "./icons.js";
import { LABEL_MAX } from "./label_volume.js";
import { type SegmentRow, segmentName } from "./segments.js";
import { brushes, TOOLS } from "./tools.js";

export class Toolbar {
  private readonly overlay: { element: HTMLElement; dispose(): void };
  private readonly bar: HTMLElement;
  private readonly offs: Disposer[] = [];
  private placed = "";
  private undoButton: HTMLButtonElement | undefined;
  private redoButton: HTMLButtonElement | undefined;

  constructor(
    private readonly ctx: PlatformContext,
    private readonly editor: Editor,
  ) {
    this.overlay = ctx.ui.overlay();
    this.bar = el("div", { class: "sg-bar", role: "toolbar", "aria-label": "Segmentation tools" });
    this.overlay.element.append(this.bar);
    // Clicks on the bar are its own, not the views' under it.
    for (const type of ["mousedown", "dblclick", "wheel"]) this.bar.addEventListener(type, (e) => e.stopPropagation());
    // A button keeps no focus once clicked: Space and the tools' keys stay the views'.
    this.bar.addEventListener("click", () => {
      if (document.activeElement instanceof HTMLButtonElement && this.bar.contains(document.activeElement)) document.activeElement.blur();
    });
    this.offs.push(
      editor.onChanged(() => this.draw()),
      // Undo and Redo name what they take back, which may be a change to the workspace.
      ctx.workspace.onChanged(() => this.drawUndo()),
      ctx.viewer.onRendered(() => this.place()),
    );
    this.draw();
  }

  dispose(): void {
    this.offs.forEach((off) => off());
    this.overlay.dispose();
  }

  /** Keeps the bar centred at the top of the 2-D views (below Neuroglancer's position bar). */
  private place(): void {
    if (this.bar.hidden) return;
    const panels = this.ctx.viewer.panels();
    if (panels.length === 0) return;
    const base = this.overlay.element.getBoundingClientRect();
    const span = barSpan(panels.map((p) => ({ kind: p.kind, rect: p.element.getBoundingClientRect() })));
    const top = span.top - base.top;
    const centre = (span.left + span.right) / 2 - base.left;
    const width = span.right - span.left;
    const key = `${Math.round(top)}/${Math.round(centre)}/${Math.round(width)}`;
    if (key === this.placed) return;
    this.placed = key;
    // Below the views' corner buttons (maximise, layout), which it would cover.
    this.bar.style.top = `${Math.round(top) + 30}px`;
    this.bar.style.left = `${Math.round(centre)}px`;
    this.bar.style.maxWidth = `${Math.max(120, Math.round(width) - 16)}px`;
  }

  /** Undo and Redo: what each takes, the last stroke or a change to the workspace (they undo as one history). */
  private drawUndo(): void {
    const e = this.editor;
    const what = (t: ReturnType<Editor["undoTarget"]>, redo: boolean) =>
      t === undefined ? "nothing" : t.kind === "stroke" ? (redo ? "the stroke undone" : "the last stroke") : `${t.label} (a change to the workspace)`;
    for (const [button, redo] of [[this.undoButton, false], [this.redoButton, true]] as const) {
      if (button === undefined) continue;
      const target = e.undoTarget(redo);
      button.title = `${redo ? "Redo" : "Undo"}: ${what(target, redo)} (${redo ? "Ctrl+Y" : "Ctrl+Z"})`;
      button.disabled = target === undefined;
    }
  }

  private draw(): void {
    const e = this.editor;
    const session = e.current;
    this.bar.hidden = !e.editing || session === undefined;
    if (this.bar.hidden || session === undefined) return;
    // Not while the segment picker is typed in: drawn when it is left.
    const typing = document.activeElement as HTMLElement | null;
    if (typing?.classList?.contains("sg-segment-select") && this.bar.contains(typing)) {
      typing.addEventListener("blur", () => this.draw(), { once: true });
      return;
    }
    const group = (...children: (Node | null)[]) => el("div", { class: "sg-group" }, ...children);

    const tools = group(...TOOLS.map((t) => iconButton(t.id, `${t.title} (${t.key}): ${t.hint}`, () => e.setTool(t.id), e.tool === t.id)));

    let option: HTMLElement | null = null;
    if (brushes(e.tool)) {
      const unit = e.unit === "voxels" ? (e.radius === 1 ? "voxel" : "voxels") : e.unit;
      option = group(
        iconButton("minus", "Smaller brush ([ or Alt+wheel)", () => e.brushSize(-1)),
        el("span", { class: "sg-value", title: "The brush's radius" }, `${e.radius} ${unit}`),
        iconButton("plus", "Larger brush (] or Alt+wheel)", () => e.brushSize(1)),
      );
    } else if (e.tool === "lasso") {
      const modes = el("div", { class: "segmented sg-dims" });
      for (const [erase, label, title] of [[false, "Paint", "Paint inside the outline with the active segment"], [true, "Erase", "Erase inside the outline"]] as const) {
        modes.append(el("button", { type: "button", title, "aria-pressed": String(e.lassoErase === erase), onclick: () => {
          e.lassoErase = erase;
          e.changed();
        } }, label));
      }
      option = group(modes);
    } else if (e.tool === "fill") {
      const dims = el("div", { class: "segmented sg-dims" });
      for (const [three, label, title] of [[false, "2-D", "Fill the section clicked (F)"], [true, "3-D", "Fill in a box round the click (Shift+F)"]] as const) {
        dims.append(el("button", { type: "button", title, "aria-pressed": String(e.fill3d === three), onclick: () => {
          e.fill3d = three;
          e.changed();
        } }, label));
      }
      option = group(dims);
    } else if (e.tool === "quick" && e.quickStatus) {
      // A download, an embedding or spreading under way: what, how far, and Stop.
      const s = e.quickStatus;
      option = group(
        el("span", { class: "sg-status", title: s.text }, s.text),
        s.fraction === undefined ? null : el("progress", { class: "sg-progress", max: "1", value: String(s.fraction) }),
        iconButton("close", "Stop (Escape)", () => e.cancelPreview()),
      );
    } else if (e.tool === "quick" && e.pending) {
      // The proposed mask, shown over the views: paint it or drop it, or spread it to the next sections.
      const accept = iconButton("check", "Accept: paint the mask with the active segment (Enter)", () => e.acceptPreview());
      accept.classList.add("sg-accept");
      const spread = e.canSpread()
        ? el("button", { type: "button", class: "sg-text", title: `Spread the mask to ${e.spreadCount} sections each way (each section's prompt is the box round the mask before it); Enter paints them as one stroke`, onclick: () => e.spread() }, `Spread ±${e.spreadCount}`)
        : null;
      option = group(
        el("span", { class: "sg-value", title: "The voxels quick select proposes" }, `${e.pending.voxels.toLocaleString()} voxels`),
        spread,
        accept,
        iconButton("close", "Cancel: drop the mask (Escape)", () => e.cancelPreview()),
      );
    } else if (e.tool === "quick") {
      // The method (Threshold, AI (MobileSAM), and any a plugin adds), and whether the mask shows first.
      const methods = el("div", { class: "segmented sg-dims" });
      const chosen = e.quickMethod();
      for (const m of e.quickSelect.methods()) {
        methods.append(el("button", { type: "button", title: m.description ?? m.title, "aria-pressed": String(m === chosen), onclick: () => {
          e.method = m.id;
          e.changed();
        } }, m.title));
      }
      const modes = el("div", { class: "segmented sg-dims" });
      for (const [mode, label, title] of [["preview", "Preview", "Show the mask first: Enter paints it, Escape drops it"], ["paint", "At once", "Paint the mask at once (undo takes it back)"]] as const) {
        modes.append(el("button", { type: "button", title, "aria-pressed": String(e.quickMode === mode), onclick: () => {
          e.quickMode = mode;
          e.changed();
        } }, label));
      }
      option = group(methods, modes);
    }

    // The active segment: its colour, id and name, the others to choose from, and New segment.
    const rows = e.rows();
    const active = rows.find((r) => r.value === e.value);
    const choose = segmentPicker(rows, e.value, (v) => e.activate(v));
    const segment = group(
      el("span", { class: "sg-chip", style: `background:${active?.colour ?? session.colour(e.value)}`, title: `Segment ${e.value}` }),
      choose,
      iconButton("plus", `New segment (C): ${rowsMax(rows.map((r) => r.value), LABEL_MAX[session.volume.type])}`, () => e.newSegment()),
    );

    const undo = (this.undoButton = iconButton("undo", "Undo (Ctrl+Z)", () => e.undo(false)));
    const redo = (this.redoButton = iconButton("redo", "Redo (Ctrl+Y)", () => e.undo(true)));
    this.drawUndo();
    const save = iconButton("save", `Save ${session.layer} (${e.saveFormat === "zarr" ? "OME-Zarr" : "NIfTI"}; the format is in the Segmentation panel)${session.unsaved ? `: ${session.unsaved} change${session.unsaved === 1 ? "" : "s"} not saved` : ""}`, () => void e.save());
    save.classList.toggle("sg-unsaved", session.unsaved > 0);
    const actions = group(
      undo,
      redo,
      iconButton("interpolate", "Interpolate (V): fill the sections between two where the active segment is drawn, across the view last drawn in", () => e.interpolate()),
      save,
    );

    this.bar.replaceChildren(
      ...[tools, option, segment, actions].filter((x): x is HTMLElement => x !== null),
      group(iconButton("close", "Stop editing: hide the tool bar (the Segmentation panel shows it again)", () => e.setEditing(false))),
    );
    this.placed = "";
    this.place();
  }
}

/** The most segments the picker lists at once: typing narrows them. */
export const PICKER_MAX = 50;

/** The segments a search finds: by id (those starting with the digits typed first), else by name; at most `max`, and how many in all. */
export function findSegments(rows: SegmentRow[], query: string, max = PICKER_MAX): { found: SegmentRow[]; total: number } {
  const q = query.trim().toLowerCase();
  if (q === "") return { found: rows.slice(0, max), total: rows.length };
  const byId = /^\d+$/.test(q);
  const found: SegmentRow[] = [];
  let total = 0;
  for (const r of rows) {
    const hit = byId ? String(r.value).startsWith(q) : segmentName(r).toLowerCase().includes(q);
    if (!hit) continue;
    if (found.length < max) found.push(r);
    total++;
  }
  return { found, total };
}

/**
 * The active segment as a search box rather than a select: typing an id or
 * a name lists the segments found (at most PICKER_MAX), Enter takes the
 * first (or the id typed, a new one among them), Escape leaves it.  No
 * option is made per segment, so 100k segments cost nothing until searched.
 */
export function segmentPicker(rows: SegmentRow[], value: number, choose: (value: number) => void): HTMLElement {
  const label = (r: SegmentRow | undefined, v: number) => `${v} · ${r ? segmentName(r) : `Segment ${v}`}`;
  const current = rows.find((r) => r.value === value);
  const input = el("input", { class: "text-input sg-segment-select", type: "search", value: label(current, value), placeholder: "Segment id or name", title: "The active segment: tools paint it. Type an id or a name to find another", "aria-label": "Active segment", "aria-autocomplete": "list", role: "combobox", "aria-expanded": "false" }) as HTMLInputElement;
  const list = el("div", { class: "sg-picker-list", role: "listbox", hidden: true });
  let found: SegmentRow[] = [];
  const show = () => {
    const query = input.value === label(current, value) ? "" : input.value;
    const r = findSegments(rows, query);
    found = r.found;
    list.replaceChildren(
      ...found.map((row) => {
        const option = el("div", { class: `sg-picker-option${row.value === value ? " sg-active" : ""}`, role: "option", "aria-selected": String(row.value === value) }, el("span", { class: "sg-chip", style: `background:${row.colour}` }), el("span", { class: "sg-id" }, String(row.value)), el("span", { class: "sg-name" }, segmentName(row)));
        // Before the box loses its focus.
        option.addEventListener("mousedown", (ev) => {
          ev.preventDefault();
          pick(row.value);
        });
        return option;
      }),
      r.total > found.length ? el("div", { class: "sg-picker-more hint" }, `${(r.total - found.length).toLocaleString()} more: type to narrow`) : "",
      r.total === 0 ? el("div", { class: "sg-picker-more hint" }, /^\d+$/.test(query.trim()) ? `Enter: segment ${query.trim()} (new)` : "No segment found.") : "",
    );
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
  };
  const pick = (v: number) => {
    list.hidden = true;
    input.blur();
    choose(v);
  };
  input.addEventListener("focus", () => {
    input.select?.();
    show();
  });
  input.addEventListener("input", show);
  input.addEventListener("keydown", (k) => {
    if (k.key === "Enter") {
      const typed = input.value.trim();
      if (/^\d+$/.test(typed) && Number(typed) > 0) pick(Number(typed));
      else if (found[0] !== undefined) pick(found[0].value);
    } else if (k.key === "Escape") {
      input.value = label(current, value);
      input.blur();
    }
    // The tools' keys are not the views' while typing here.
    k.stopPropagation();
  });
  input.addEventListener("blur", () => {
    list.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.value = label(current, value);
  });
  return el("span", { class: "sg-picker" }, input, list);
}

/**
 * What New segment will give, for its tooltip.  A loop, not Math.max over a
 * spread: a copied segmentation can have more segments than a call takes
 * arguments.
 */
export function rowsMax(values: number[], max: number): string {
  let top = 0;
  for (const v of values) if (v > top) top = v;
  return top < max ? `segment ${top + 1}` : "the smallest unused id";
}

interface PanelRect {
  kind: "2d" | "3d";
  rect: { left: number; right: number; top: number; bottom: number };
}

/**
 * Where the bar goes: across the top row of the 2-D views (those whose top
 * is the highest), so in a layout with a 3-D view beside them (xy-3d,
 * 4panel) it does not cover the 3-D view.  When a 3-D view sits between
 * 2-D views in that row, the widest 2-D view alone; with no 2-D view, all
 * the views.
 */
export function barSpan(panels: PanelRect[]): { left: number; right: number; top: number } {
  const flat = panels.filter((p) => p.kind === "2d");
  const use = flat.length ? flat : panels;
  const top = Math.min(...use.map((p) => p.rect.top));
  const row = use.filter((p) => p.rect.top < top + 4);
  let left = Math.min(...row.map((p) => p.rect.left));
  let right = Math.max(...row.map((p) => p.rect.right));
  const between = panels.some((p) => p.kind === "3d" && flat.length > 0 && p.rect.left < right - 1 && p.rect.right > left + 1 && p.rect.top < top + 40 && p.rect.bottom > top);
  if (between) {
    const widest = row.reduce((a, b) => (b.rect.right - b.rect.left > a.rect.right - a.rect.left ? b : a));
    left = widest.rect.left;
    right = widest.rect.right;
  }
  return { left, right, top };
}
