/**
 * The Segmentation panel: the label volume edited (one at a time), a new
 * segmentation layer, the segment list, the active tool's settings, the
 * image whose values limit the tools, saving, and the copies kept in this
 * browser.  The tools themselves are also on the tool bar over the views
 * (./toolbar.ts).
 *
 * The panel is drawn once: its cards and status line stay, and each card's
 * body is drawn again only when what it shows changes (a `region()` keyed
 * by it), so a change to the segments does not redraw the tool's settings.
 */
import type { Disposer, PlatformContext } from "@ngplatform/sdk";
import { button, card, checkbox, el, emptyState, field, info, numberInput, region, select, statusLine } from "@ngplatform/sdk/dom";
import { voxelEdges, voxelVolume } from "../annotations/geometry.js";
import { physical } from "../annotations/ui.js";
import { layerStore, readableImages, type Voxels } from "../annotations/voxels.js";
import { type Editor, fmtBytes, type ImageLevel, labelTypeOf, MAX_COPY, MAX_NIFTI } from "./editor.js";
import { CowVolume } from "./cow_volume.js";
import { iconButton } from "./icons.js";
import { age, type KeptInfo, keptBytes } from "./keep.js";
import { LABEL_MAX, type LabelType } from "./label_volume.js";
import { MOBILE_SAM, MODEL_BYTES, ORT_VERSION, type Provider } from "./sam_model.js";
import { niftiBytes } from "./save.js";
import { groupOf, grouped } from "./segment_groups.js";
import { segmentName } from "./segments.js";
import type { Session } from "./session.js";
import { brushes, TOOLS } from "./tools.js";

/** Past this many items (rows and group heads) the segment list draws only those in view. */
export const VIRTUAL_MIN = 200;
/** Each item's height in a list drawn in view only (style.ts gives it), the list's at most, and the rows drawn past each end. */
const ROW_HEIGHT = 27;
const LIST_HEIGHT = 320;
const OVERSCAN = 8;

/** A hash of the segment rows (value, name, colour, voxels, shown): the list is drawn again when it changes. */
export function rowsHash(rows: { value: number; name: string; colour: string; voxels: number; visible: boolean }[]): number {
  let h = 0x811c9dc5;
  const mix = (n: number) => (h = Math.imul(h ^ n, 0x01000193) >>> 0);
  for (const r of rows) {
    mix(r.value);
    mix(r.voxels);
    mix(r.visible ? 1 : 0);
    for (let i = 0; i < r.name.length; ++i) mix(r.name.charCodeAt(i));
    for (let i = 0; i < r.colour.length; ++i) mix(r.colour.charCodeAt(i));
  }
  return h;
}

const IN_PLACE_INFO =
  "Edited in place, the segmentation is read at its finest level as it is shown or drawn on, a chunk of 64³ voxels at a time; a chunk is copied when you first change it, and only changed chunks are kept (in this page up to 512 MB, then in this browser's storage). The original is hidden and never written. Save writes the edits alone (an OME-Zarr that names the original) or the whole volume.";

export class Panel {
  // The New form's choices.
  private newLayer = "";
  private newLevel = 0;
  private newType: LabelType = "uint8";
  private newName = "";
  /** A segmentation's new layer starts as a copy of its labels, edits it in place, or starts empty. */
  private newStart: "copy" | "inPlace" | "empty" = "copy";
  private showForm = false;
  /** A layer being made (a copy can take a while): Create stays off until it is. */
  private creating = false;
  /** A segment row is being dragged (onto a group): the list waits to be redrawn. */
  private dragging = false;
  private levels: { store: string; levels: ImageLevel[] } | undefined;

  constructor(
    private readonly ctx: PlatformContext,
    private readonly editor: Editor,
    private readonly voxels: Voxels,
  ) {}

  render(host: HTMLElement): Disposer {
    void this.editor.refreshKept();
    const e = this.editor;
    const status = statusLine();
    const head = region(() => (e.current ? this.head(e.current) : []), { class: "sg-head" });
    const newBody = region(() => this.newForm());
    const segmentsBody = region(() => (e.current ? this.segmentList(e.current) : []));
    const toolBody = region(() => [this.toolRow(), this.toolOptions()]);
    const valuesBody = region(() => (e.current ? this.intensity(e.current) : []));
    const saveBody = region(() => (e.current ? this.saveRow(e.current) : []));
    const keptBody = region(() => this.keptList());
    const newCard = card("segmentation.new", "New segmentation layer", { open: true }, newBody);
    const segmentsCard = card("segmentation.segments", "Segments", { open: true, badge: " " }, segmentsBody);
    const toolCard = card("segmentation.tool", "Tool", { open: true }, toolBody);
    const valuesCard = card("segmentation.values", "Image values", {}, valuesBody);
    const saveCard = card("segmentation.save", "Save", { badge: " " }, saveBody);
    const keptCard = card("segmentation.kept", "Kept in this browser", { badge: " ", info: "Copies of label volumes as drawn, kept by this browser so a reload or a closed tab does not lose them. They are not saved files: save a volume to keep it." }, keptBody);
    host.append(el("div", { class: "sg" }, head, status, newCard, segmentsCard, toolCard, valuesCard, saveCard, keptCard));
    const badge = (c: HTMLElement, text: string) => (c.querySelector(".card-badge")!.textContent = text);
    // The last failed save shown: its card is opened once for it.
    let failures = e.saveFailures;

    const draw = () => {
      const s = e.current;
      head.update(s && [s.fileName, s.layer, e.inScene().map((x) => [x.fileName, x.layer]), e.editing, s.volume.size, s.volume.type, s.volume instanceof CowVolume ? s.volume.original.layer : ""]);
      newCard.hidden = s !== undefined && !this.showForm;
      if (!newCard.hidden) newBody.update(this.newKey());
      for (const c of [segmentsCard, toolCard, valuesCard, saveCard]) c.hidden = s === undefined;
      if (s !== undefined) {
        const rows = e.rows();
        badge(segmentsCard, String(rows.length));
        // A hash of the rows, not the rows: with 100k segments their text alone is megabytes.
        segmentsBody.update([s.fileName, rowsHash(rows), rows.length, e.value, e.groups(s), s.volume.type]);
        toolBody.update(this.toolKey());
        valuesBody.update([s.fileName, s.reference?.layer, s.reference?.level, readableImages(this.ctx), e.limit, e.low, e.high]);
        badge(saveCard, s.unsaved ? `${s.unsaved} unsaved` : "");
        const v = s.volume;
        saveBody.update([s.fileName, v instanceof CowVolume, e.saveInPlace, e.saveFormat, e.saveCrop, niftiBytes(v) > MAX_NIFTI, v.chunkCount, v.bytes, v instanceof CowVolume ? v.spilledCount : 0]);
      }
      keptCard.hidden = e.keptHere.length === 0;
      badge(keptCard, e.keptHere.length ? fmtBytes(e.keptHere.reduce((n, k) => n + keptBytes(k), 0)) : "");
      keptBody.update([e.keptHere.map((k) => [k.id, k.name, k.time, k.chunks]), e.storage, Math.floor(Date.now() / 60_000)]);
      // Progress and errors only: a save under way, or why the last one failed.
      const report = e.saveStatus;
      if (report === undefined) status.clear();
      else if (report.kind === "progress") status.progress(report.text);
      else status.error(report.text, { label: "Save again", run: () => void e.save() });
      if (e.saveFailures !== failures) {
        failures = e.saveFailures;
        if (s !== undefined) saveCard.open = true;
      }
    };
    let queued = false;
    // Drawn at most once a frame, and not while a field in it is being typed in.
    const update = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        const active = document.activeElement as HTMLInputElement | null;
        if (active?.tagName === "INPUT" && active.type === "text" && host.contains(active)) {
          active.addEventListener("blur", () => update(), { once: true });
          return;
        }
        // Not while a segment is dragged onto a group: the row dragged must stay.
        if (this.dragging) {
          document.addEventListener("dragend", () => update(), { once: true });
          return;
        }
        draw();
      });
    };
    draw();
    const off = this.editor.onChanged(update);
    return () => off();
  }

  private head(session: Session): Node[] {
    const e = this.editor;
    const volume = session.volume;
    const edges = voxelEdges(session.placement()?.voxelToMm ?? volume.voxelToRas);
    const editing = e.editing;
    return [
      el(
        "div",
        { class: "row" },
        e.inScene().length > 1
          ? select(e.inScene().map((s) => [s.fileName, s.layer]), session.fileName, (v) => {
              const s = e.inScene().find((x) => x.fileName === v);
              if (s) e.setCurrent(s);
            }, "Label volume")
          : el("strong", {}, session.layer),
        el("span", { class: "spacer" }),
        button(editing ? "Editing" : "Edit", () => e.setEditing(!editing), editing ? "Hide the tool bar: the views are Neuroglancer's again" : "Show the tool bar over the views", editing ? "btn primary small" : "btn outline small"),
        info("Edit shows the tool bar over the views; B, E, L, F, I and Q pick its tools.", "About Edit"),
        button("New…", () => {
          this.showForm = true;
          e.changed();
        }, "A new segmentation layer"),
        button("Close", () => void e.close(session), "Remove it from the scene"),
      ),
      el("span", { class: "readout" }, `${volume.size.join(" × ")} voxels of ${edges.map((x) => physical(x)).join(" × ")} · ${volume.type}${volume instanceof CowVolume ? ` · ${volume.original.layer} edited in place` : ""}`),
    ];
  }

  // ----------------------------------------------------------------- new

  /** The layers a new segmentation layer can be made on (not those edited already). */
  private choices(): { images: string[]; segmentations: string[] } {
    const open = new Set(this.editor.inScene().map((s) => s.layer));
    return {
      images: readableImages(this.ctx).filter((n) => !open.has(n)),
      segmentations: readableImages(this.ctx, ["segmentation"]).filter((n) => !open.has(n)),
    };
  }

  /** What the New form shows depends on. */
  private newKey(): unknown {
    const { images, segmentations } = this.choices();
    return [images, segmentations, this.newLayer, this.newLevel, this.newType, this.newStart, this.levels?.store, this.levels?.levels.length, this.creating, this.editor.current !== undefined];
  }

  private newForm(): HTMLElement {
    const e = this.editor;
    const { images, segmentations } = this.choices();
    const layers = [...images, ...segmentations];
    if (!layers.includes(this.newLayer)) {
      this.newLayer = layers[0] ?? "";
      this.newLevel = 0;
    }
    const isSegmentation = segmentations.includes(this.newLayer);
    const store = this.newLayer ? layerStore(this.ctx, this.newLayer) : undefined;
    if (store !== undefined && this.levels?.store !== store) {
      this.levels = { store, levels: [] };
      void this.voxels.levels(store).then(
        (l) => {
          this.levels = { store, levels: l };
          e.changed();
        },
        () => {},
      );
    }
    const levels = this.levels?.store === store ? (this.levels?.levels ?? []) : [];
    const voxelsAt = (l: ImageLevel | undefined) => (l ? l.size[0] * l.size[1] * l.size[2] : 0);
    // Too large to copy: edited in place instead.
    const tooLarge = isSegmentation && this.newStart === "copy" && voxelsAt(levels[this.newLevel]) > MAX_COPY;
    const inPlace = isSegmentation && (this.newStart === "inPlace" || tooLarge);
    const copy = isSegmentation && this.newStart === "copy" && !tooLarge;
    const type = (copy || inPlace) && levels[inPlace ? 0 : this.newLevel] ? labelTypeOf(levels[inPlace ? 0 : this.newLevel].type) : this.newType;
    const levelLabel = (l: ImageLevel, i: number) => {
      const n = l.size[0] * l.size[1] * l.size[2];
      const bytes = n * (type === "uint8" ? 1 : type === "uint16" ? 2 : 4);
      return `${i}: ${l.size.join(" × ")}, ${physical(l.voxelSize)} (${isSegmentation && this.newStart === "copy" ? (n > MAX_COPY ? "too large to copy: edited in place" : `${fmtBytes(bytes)} at most`) : `${fmtBytes(bytes)} if all painted`})`;
    };
    const defaultName = copy || inPlace ? `${this.newLayer} (edited)` : "Segmentation";
    const name = el("input", { class: "text-input", type: "text", value: this.newName, placeholder: defaultName, "aria-label": "Name" }) as HTMLInputElement;
    name.addEventListener("change", () => (this.newName = name.value.trim()));
    const create = button(inPlace ? "Edit in place" : copy ? "Copy and edit" : "Create", () => {
      if (this.creating) return;
      this.creating = true;
      create.disabled = true;
      void e
        .create({ layer: this.newLayer, level: inPlace ? 0 : this.newLevel, type: this.newType, name: this.newName || defaultName, copy, inPlace })
        .then(
          (made) => {
            if (made) {
              this.showForm = false;
              this.newName = "";
            }
          },
          (err) => this.ctx.ui.toast(`Could not make the layer: ${(err as Error).message}`, "error"),
        )
        .finally(() => {
          this.creating = false;
          e.changed();
        });
    }, inPlace ? "Edit this segmentation at its finest level without copying it" : copy ? "A copy of this segmentation's labels at this level, to edit (the original is hidden and not changed)" : "An empty label volume on this layer's grid", "btn primary small");
    create.disabled = this.creating || !this.newLayer || levels.length === 0;
    const opens = [
      button("Open NIfTI…", () => e.pickNifti(), "Edit a label image from this computer (.nii, .nii.gz)"),
      button("Open edits…", () => e.pickEdits(), "Edits of a segmentation saved here (Save → Edits only, an OME-Zarr folder), opened over the original again"),
    ];
    const cancel = e.current
      ? button("Cancel", () => {
          this.showForm = false;
          e.changed();
        })
      : null;
    if (layers.length === 0) {
      return el(
        "div",
        { class: "stack" },
        emptyState("No image or segmentation to draw on.", { label: "Open data…", run: () => void this.ctx.commands.invoke("dataset.add") }),
        el("div", { class: "row" }, ...opens, cancel),
      );
    }
    return el(
      "div",
      { class: "stack" },
      el(
        "div",
        { class: "grid-2" },
        field("On the grid of", select(layers.map((n) => [n, segmentations.includes(n) ? `${n} (segmentation)` : n]), this.newLayer, (v) => {
          this.newLayer = v;
          this.newLevel = 0;
          e.changed();
        }, "Layer")),
        field("Name", name),
        inPlace && !tooLarge
          ? field("Level", el("span", { class: "readout" }, levels[0] ? `0: ${levels[0].size.join(" × ")}, ${physical(levels[0].voxelSize)} (the finest)` : "…"))
          : field("Level", select(levels.map((l, i) => [String(i), levelLabel(l, i)]), String(this.newLevel), (v) => {
              this.newLevel = Number(v);
              e.changed();
            }, "Level")),
        isSegmentation
          ? field("Start", select([["copy", "A copy of its labels"], ["inPlace", "Edit it in place (nothing copied)"], ["empty", "Empty"]], this.newStart, (v) => {
              this.newStart = v as "copy" | "inPlace" | "empty";
              e.changed();
            }, "Start"), { info: IN_PLACE_INFO })
          : null,
        copy || inPlace
          ? null
          : field("Labels", select([["uint8", "8-bit (to 255)"], ["uint16", "16-bit (to 65,535)"], ["uint32", "32-bit"]], this.newType, (v) => {
              this.newType = v as LabelType;
              e.changed();
            }, "Type")),
      ),
      tooLarge ? el("p", { class: "hint" }, `Level ${this.newLevel} is too large to copy (${levels[this.newLevel].size.join(" × ")} voxels): edited in place at the finest level.`) : null,
      el("div", { class: "row" }, create, ...opens, cancel),
    );
  }

  // ---------------------------------------------------------------- kept

  /** The copies kept in this browser and not open: each with its size and age, to open again or remove. */
  private keptList(): HTMLElement {
    const e = this.editor;
    const remove = async (k: KeptInfo) => {
      if (!(await this.ctx.ui.confirm(`Remove the copy of “${k.name}” kept in this browser (${fmtBytes(keptBytes(k))})? What is not saved in it is lost.`))) return;
      await e.discardKept(k.id);
    };
    const removeAll = async () => {
      const total = e.keptHere.reduce((n, k) => n + keptBytes(k), 0);
      if (!(await this.ctx.ui.confirm(`Remove all ${e.keptHere.length} copies kept in this browser (${fmtBytes(total)})? What is not saved in them is lost.`))) return;
      for (const k of e.keptHere) await e.discardKept(k.id);
    };
    const { usage, quota, persisted } = e.storage;
    return el(
      "div",
      { class: "stack" },
      el(
        "div",
        { class: "list sg-kept" },
        ...e.keptHere.map((k) =>
          el(
            "div",
            { class: "row sg-kept-row" },
            el("div", { class: "sg-kept-name" }, el("span", {}, k.name), el("span", { class: "readout" }, `${k.size.join(" × ")}${k.original ? `, edits of ${k.original.layer}` : ""} · ${fmtBytes(keptBytes(k))} · ${age(k.time)}`)),
            button("Open", () => void e.reopen(k).then(() => e.refreshKept(), (err) => this.ctx.ui.toast(`Could not open it: ${(err as Error).message}`, "error")), "Open it again as a new layer"),
            button("Remove…", () => void remove(k), "Remove it from this browser"),
          ),
        ),
      ),
      el(
        "div",
        { class: "row" },
        usage !== undefined && quota !== undefined ? el("span", { class: "readout" }, `This site uses ${fmtBytes(usage)} of ${fmtBytes(quota)}${persisted === false ? "; may be cleared when space is short" : ""}`) : null,
        el("span", { class: "spacer" }),
        e.keptHere.length > 1 ? button("Remove all…", () => void removeAll(), "Remove every copy kept in this browser") : null,
      ),
    );
  }

  // --------------------------------------------------------------- save

  private saveRow(session: Session): HTMLElement {
    const e = this.editor;
    const volume = session.volume;
    const size = el(
      "span",
      { class: "readout" },
      volume instanceof CowVolume
        ? `${volume.chunkCount} chunk${volume.chunkCount === 1 ? "" : "s"} edited, ${fmtBytes(volume.bytes)} in this page${volume.spilledCount ? `, ${volume.spilledCount} in browser storage` : ""}`
        : `${volume.chunkCount} chunk${volume.chunkCount === 1 ? "" : "s"}, ${fmtBytes(volume.bytes)} in this page`,
    );
    if (volume instanceof CowVolume) {
      return el(
        "div",
        { class: "stack" },
        el(
          "div",
          { class: "row sg-save" },
          field("Save", select([["edits", "Edits only (OME-Zarr)"], ["whole", "The whole volume (OME-Zarr, a job)"]], e.saveInPlace, (v) => {
            e.saveInPlace = v as "edits" | "whole";
            e.changed();
          }, "Save"), {
            info: `Edits only: the edited chunks, in an OME-Zarr that names ${volume.original.layer}; Open edits… puts them back over it. The whole volume: every chunk, into a folder, as a job in Activity (edits made while it runs may or may not be in it).`,
          }),
          button("Save", () => void e.save(), "Save to this computer", "btn primary small"),
        ),
        size,
      );
    }
    const big = niftiBytes(volume) > MAX_NIFTI;
    return el(
      "div",
      { class: "stack" },
      el(
        "div",
        { class: "row sg-save" },
        field("Format", select([["nii.gz", "NIfTI (.nii.gz)"], ["zarr", "OME-Zarr folder"]], e.saveFormat, (v) => {
          e.saveFormat = v as "nii.gz" | "zarr";
          e.changed();
        }, "Format")),
        button("Save", () => void e.save(), "Save to this computer", "btn primary small"),
      ),
      checkbox("Only the painted box", e.saveCrop, (v) => {
        e.saveCrop = v;
        e.changed();
      }),
      big && e.saveFormat === "nii.gz" ? el("p", { class: "hint error" }, "Too large for one NIfTI: tick Only the painted box, or save as OME-Zarr.") : null,
      size,
    );
  }

  // ------------------------------------------------------------ segments

  private segmentList(session: Session): HTMLElement {
    const e = this.editor;
    const voxelMm3 = voxelVolume(session.placement()?.voxelToMm ?? session.volume.voxelToRas);
    const rows = e.rows();
    const vg = e.groups(session);
    const table = el("div", { class: "sg-segments", role: "list" });
    /** A segment dragged onto a group's head joins it ("No group": leaves its group). */
    const dropTarget = (target: HTMLElement, id: string | undefined) => {
      target.addEventListener("dragover", (ev) => {
        if (!ev.dataTransfer?.types.includes("application/x-ngp-segment")) return;
        ev.preventDefault();
        target.classList.add("sg-drop");
      });
      target.addEventListener("dragleave", () => target.classList.remove("sg-drop"));
      target.addEventListener("drop", (ev) => {
        target.classList.remove("sg-drop");
        const value = Number(ev.dataTransfer?.getData("application/x-ngp-segment"));
        if (!(value > 0)) return;
        ev.preventDefault();
        e.assignGroup([value], id);
      });
    };
    const head = (group: (typeof vg.groups)[number] | undefined, count: number, shown: number) => {
      if (group === undefined) {
        const h = el("div", { class: "sg-group-head sg-ungrouped", role: "listitem", title: "Segments in no group: drag one here to take it out of its group" }, el("span", { class: "sg-caret" }), el("span", { class: "sg-name faint" }, "No group"), el("span", { class: "sg-count" }, String(count)));
        dropTarget(h, undefined);
        return h;
      }
      const colour = el("input", { type: "color", class: "colour-input", value: group.colour, title: "The group's colour: given to every segment in it", "aria-label": `Colour of group ${group.name}` }) as HTMLInputElement;
      colour.addEventListener("change", () => e.recolourGroup(group.id, colour.value));
      const name = el("input", { class: "text-input sg-name", type: "text", value: group.name, "aria-label": `Name of group ${group.name}` }) as HTMLInputElement;
      name.addEventListener("change", () => e.renameGroup(group.id, name.value));
      name.addEventListener("keydown", (k) => {
        if (k.key === "Enter") name.blur();
      });
      const visible = shown > 0;
      const eye = iconButton(visible ? "eye" : "eyeOff", visible ? "Hide the group" : "Show the group", () => e.showGroup(group.id, !visible), visible);
      eye.disabled = count === 0;
      const h = el(
        "div",
        { class: "sg-group-head", role: "listitem", "data-group": group.id, title: "A group of segments: drag segments here to add them" },
        el("button", { type: "button", class: "sg-caret", title: group.collapsed ? "Show its segments" : "Fold its segments away", "aria-expanded": String(!group.collapsed), onclick: () => e.foldGroup(group.id, !group.collapsed) }, group.collapsed ? "▸" : "▾"),
        eye,
        colour,
        name,
        el("span", { class: "sg-count", title: `${count} segment${count === 1 ? "" : "s"}` }, String(count)),
        el("span", { class: "sg-actions" }, iconButton("trash", "Delete the group (its segments stay, in no group)", () => e.deleteGroup(group.id))),
      );
      dropTarget(h, group.id);
      return h;
    };
    const segmentRow = (r: (typeof rows)[number], grouped: boolean) => {
      const active = r.value === e.value;
      const colour = el("input", { type: "color", class: "colour-input", value: r.colour, title: "Colour", "aria-label": `Colour of segment ${r.value}` }) as HTMLInputElement;
      colour.addEventListener("change", () => e.recolour(r.value, colour.value));
      let name: Node;
      if (active) {
        const input = el("input", { class: "text-input sg-name", type: "text", value: r.name, placeholder: `Segment ${r.value}`, "aria-label": "Name of the active segment" }) as HTMLInputElement;
        input.addEventListener("change", () => e.rename(r.value, input.value));
        input.addEventListener("keydown", (k) => {
          if (k.key === "Enter") input.blur();
        });
        name = input;
      } else {
        name = el("span", { class: "sg-name" }, segmentName(r));
      }
      const row = el(
        "div",
        { class: `sg-segment${active ? " sg-active" : ""}${grouped ? " sg-in-group" : ""}`, role: "listitem", draggable: "true", title: active ? "The active segment: tools paint it" : "Click to paint with it; drag onto a group to put it there" },
        iconButton(r.visible ? "eye" : "eyeOff", r.visible ? "Hide" : "Show", () => e.show(session, r.value, !r.visible), r.visible),
        colour,
        el("span", { class: "sg-id" }, String(r.value)),
        name,
        el("span", { class: "sg-count", title: physical(r.voxels * voxelMm3, 3) }, r.voxels.toLocaleString()),
        el(
          "span",
          { class: "sg-actions" },
          iconButton("goto", "Go to", () => e.goTo(r.value)),
          active ? null : iconButton("merge", `Merge into segment ${e.value} (the active one)`, () => e.merge(r.value)),
          iconButton("trash", "Delete: erase its voxels", () => void e.deleteSegment(r.value)),
        ),
      );
      row.addEventListener("click", (ev) => {
        if ((ev.target as Element).closest("button, input")) return;
        e.activate(r.value);
      });
      row.addEventListener("dragstart", (ev) => {
        ev.dataTransfer?.setData("application/x-ngp-segment", String(r.value));
        if (ev.dataTransfer) ev.dataTransfer.effectAllowed = "move";
        this.dragging = true;
      });
      row.addEventListener("dragend", () => (this.dragging = false));
      return row;
    };
    // The list's items in order: group heads and segment rows.
    const items: (() => HTMLElement)[] = [];
    if (vg.groups.length === 0) {
      for (const r of rows) items.push(() => segmentRow(r, false));
    } else {
      for (const section of grouped(vg, rows)) {
        const shown = section.rows.filter((r) => r.visible).length;
        items.push(() => head(section.group, section.rows.length, shown));
        if (!section.group?.collapsed) for (const r of section.rows) items.push(() => segmentRow(r, true));
      }
    }
    if (items.length <= VIRTUAL_MIN) {
      for (const make of items) table.append(make());
    } else {
      this.virtualList(table, items, rows.findIndex((r) => r.value === e.value));
    }
    const max = LABEL_MAX[session.volume.type];
    return el(
      "div",
      { class: "stack" },
      el(
        "div",
        { class: "row" },
        button("+ New segment", () => e.newSegment(), "One more than the largest id used (C)"),
        button("+ New group", () => e.newGroup(), "A named group of segments: drag segments onto it"),
        el("span", { class: "spacer" }),
        el("label", { class: "row sg-active-value" }, el("span", { class: "faint" }, "Active"), numberInput(e.value, (v) => e.activate(v), { min: 1, max, step: 1, "aria-label": "Active segment" })),
      ),
      table,
      vg.groups.length
        ? field(`Group of segment ${e.value}`, select([["", "No group"], ...vg.groups.map((g): [string, string] => [g.id, g.name])], groupOf(vg, e.value)?.id ?? "", (v) => e.assignGroup([e.value], v || undefined), "Group of the active segment"))
        : null,
      rows.every((r) => r.voxels === 0) ? emptyState("Nothing painted yet.", { label: "Brush (B)", run: () => e.setTool("brush") }) : null,
    );
  }

  /** Where the long segment list was scrolled to (it is drawn again as segments change). */
  private listScroll = 0;

  /**
   * A long list drawn in view only: every item the same height, a spacer
   * as tall as all of them, and the rows in view (and a few each side)
   * drawn again as it scrolls.
   */
  private virtualList(table: HTMLElement, items: (() => HTMLElement)[], active: number): void {
    table.classList.add("sg-virtual");
    const spacer = el("div", { class: "sg-virtual-space", style: `height: ${items.length * ROW_HEIGHT}px` });
    const view = el("div", { class: "sg-virtual-window" });
    spacer.append(view);
    table.append(spacer);
    let drawn = "";
    const draw = () => {
      const top = table.scrollTop || 0;
      this.listScroll = top;
      const height = table.clientHeight || LIST_HEIGHT;
      const first = Math.max(0, Math.floor(top / ROW_HEIGHT) - OVERSCAN);
      const last = Math.min(items.length, Math.ceil((top + height) / ROW_HEIGHT) + OVERSCAN);
      const key = `${first}-${last}`;
      if (key === drawn) return;
      drawn = key;
      view.style.transform = `translateY(${first * ROW_HEIGHT}px)`;
      view.replaceChildren(...items.slice(first, last).map((make) => make()));
    };
    let queued = false;
    table.addEventListener("scroll", () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        draw();
      });
    });
    // Where it was, or at the active segment when that is out of view.
    let top = this.listScroll;
    if (active >= 0 && (active * ROW_HEIGHT < top || (active + 1) * ROW_HEIGHT > top + LIST_HEIGHT)) top = Math.max(0, active * ROW_HEIGHT - LIST_HEIGHT / 2);
    table.scrollTop = top;
    draw();
    // Once in the page its height is known: the rows in view drawn again for it.
    requestAnimationFrame(() => {
      table.scrollTop = top;
      draw();
    });
  }

  // ---------------------------------------------------------------- tool

  /** What the Tool card shows depends on. */
  private toolKey(): unknown {
    const e = this.editor;
    const m = e.sam;
    return [
      e.tool,
      e.editing,
      e.radius,
      e.unit,
      e.shape,
      e.overwrite,
      e.eraseOnly,
      e.lassoErase,
      e.fill3d,
      e.fillBy,
      e.reach,
      e.method,
      e.tolerance,
      e.quickMode,
      e.quickContext,
      e.quickStatus,
      e.pending?.voxels,
      e.spreadCount,
      e.canSpread(),
      [m.state, m.progress, m.kept, m.error, m.running, m.threads, m.encodeMs, m.decodeMs, m.provider],
    ];
  }

  private toolRow(): HTMLElement {
    const e = this.editor;
    const tools = el("div", { class: "segmented" });
    for (const t of TOOLS) {
      tools.append(el("button", { type: "button", title: `${t.hint} (${t.key})`, "aria-pressed": String(e.editing && e.tool === t.id), onclick: () => e.setTool(t.id) }, t.title));
    }
    return tools;
  }

  private toolOptions(): HTMLElement | null {
    const e = this.editor;
    const options = el("div", { class: "grid-2 sg-options" });
    const paintOver = () =>
      field("Paint over", select([["all", "Any segment"], ["empty", "Empty voxels only"]], e.overwrite, (v) => {
        e.overwrite = v as "all" | "empty";
        e.changed();
      }, "Paint over"));
    const erase = () =>
      field("Erase", select([["any", "Any segment"], ["only", "The active segment only"]], e.eraseOnly ? "only" : "any", (v) => {
        e.eraseOnly = v === "only";
        e.changed();
      }, "Erase"));
    if (brushes(e.tool)) {
      options.append(
        field("Radius", el("div", { class: "sg-inline" }, numberInput(e.radius, (v) => e.setRadius(Math.max(0.01, v)), { min: 0.01, step: "any", "aria-label": "Radius" }), select([["voxels", "voxels"], ["mm", "mm"], ["µm", "µm"]], e.unit, (v) => e.setUnit(v as "mm" | "µm" | "voxels"), "Unit")), "Alt+wheel, [ and ] in the views"),
        field("Shape", select([["disc", "Disc in the section"], ["ball", "Ball"]], e.shape, (v) => {
          e.shape = v as "ball" | "disc";
          e.changed();
        }, "Shape")),
        e.tool === "brush" ? paintOver() : erase(),
      );
    } else if (e.tool === "lasso") {
      options.append(
        field("Inside", select([["paint", "Paint the active segment"], ["erase", "Erase"]], e.lassoErase ? "erase" : "paint", (v) => {
          e.lassoErase = v === "erase";
          e.changed();
        }, "Inside the outline")),
        e.lassoErase ? erase() : paintOver(),
      );
    } else if (e.tool === "fill") {
      options.append(
        field("Fill", select([["2d", "2-D: the section"], ["3d", "3-D: a box round the click"]], e.fill3d ? "3d" : "2d", (v) => {
          e.fill3d = v === "3d";
          e.changed();
        }, "Fill in")),
        field("Region", select([["label", "The segment clicked, where joined"], ["image", "The image range, where joined"]], e.fillBy, (v) => {
          e.fillBy = v as "image" | "label";
          e.changed();
        }, "Fill by")),
        paintOver(),
      );
      if (e.fill3d) {
        options.append(
          field("Reach (voxels)", numberInput(e.reach, (v) => {
            e.reach = Math.max(1, Math.min(256, Math.round(v)));
            e.changed();
          }, { min: 1, max: 256, step: 1 }), { info: "The fill stays in a box this far round the click." }),
        );
      }
    } else if (e.tool === "quick") {
      const methods = e.quickSelect.methods();
      const method = e.quickMethod();
      options.append(
        field("Method", select(methods.map((m) => [m.id, m.title]), method.id, (v) => {
          e.method = v;
          e.changed();
        }, "Method"), method.description ? { info: method.description } : undefined),
      );
      if (method.id === MOBILE_SAM.id) options.append(this.model());
      else if (method.id === "threshold") {
        options.append(
          field("Tolerance", numberInput(e.tolerance, (v) => {
            e.tolerance = Math.max(0, Math.min(1, v));
            e.changed();
          }, { min: 0, max: 1, step: 0.01 }), { info: "For a click: how far from its value, as a fraction of the range." }),
        );
      }
      if (e.quickStatus) {
        options.append(
          el(
            "div",
            { class: "sg-wide stack" },
            el("div", { class: "row" }, el("span", { class: "muted" }, e.quickStatus.text), el("span", { class: "spacer" }), button("Stop", () => e.cancelPreview(), "Stop (Escape)")),
            e.quickStatus.fraction === undefined ? null : el("progress", { class: "sg-bar-progress", max: "1", value: String(e.quickStatus.fraction) }),
          ),
        );
      }
      options.append(
        field("Result", select([["preview", "Preview first (Enter paints, Escape drops)"], ["paint", "Paint at once"]], e.quickMode, (v) => {
          e.quickMode = v as "preview" | "paint";
          e.changed();
        }, "Result")),
        paintOver(),
      );
      if (e.pending) {
        options.append(
          el(
            "div",
            { class: "row sg-wide" },
            button(`Accept ${e.pending.voxels.toLocaleString()} voxels`, () => e.acceptPreview(), "Paint the mask with the active segment (Enter)", "btn primary small"),
            button("Cancel", () => e.cancelPreview(), "Drop the mask (Escape)"),
          ),
        );
      }
      options.append(
        field("Spread to sections", numberInput(e.spreadCount, (v) => {
          e.spreadCount = Math.max(1, Math.min(200, Math.round(v)));
          e.changed();
        }, { min: 1, max: 200, step: 1 }), { info: "Each way from the mask's section: each section's prompt is the box round the mask in the one before. Enter paints them all as one stroke." }),
      );
      if (e.canSpread()) options.append(el("div", { class: "row sg-wide" }, el("span", { class: "spacer" }), button(`Spread to ${e.spreadCount} sections each way`, () => e.spread(), "Propose the mask in the next sections too (the method chosen, a box prompt in each)")));
    } else if (e.tool === "move") {
      return el("p", { class: "hint" }, "Pick a tool to draw.");
    }
    return options.childElementCount ? options : null;
  }

  /** The model: kept in this browser or not (a progress bar while it comes), what it runs on, its last timings; its size and licence behind an info. */
  private model(): HTMLElement {
    const e = this.editor;
    const m = e.sam;
    const mb = (n: number) => `${(n / 1e6).toFixed(1)} MB`;
    const box = el(
      "div",
      { class: "sg-model stack" },
      el(
        "div",
        { class: "row" },
        el("span", {}, `${MOBILE_SAM.name}, ${mb(MODEL_BYTES)}`),
        info(
          `${MOBILE_SAM.name} (${MOBILE_SAM.licence}): an image encoder and a prompt decoder from Hugging Face (${MOBILE_SAM.files}), downloaded on first use and kept in this browser. It runs here with ONNX Runtime Web ${ORT_VERSION} (MIT), loaded from jsDelivr. Click to include, Shift+click to exclude, or drag a box: each click refines the mask in its section; the first in a region computes the image's embedding, later ones are quick.`,
          `About ${MOBILE_SAM.name}`,
        ),
      ),
    );
    if (m.state === "loading" && m.progress) {
      box.append(el("span", { class: "faint" }, `Downloading: ${mb(m.progress.loaded)} of ${mb(m.progress.total)}`), el("progress", { class: "sg-bar-progress", max: String(m.progress.total), value: String(m.progress.loaded) }));
    } else if (m.state === "loading") box.append(el("span", { class: "faint" }, "Loading the model…"));
    else if (m.state === "failed") box.append(el("span", { class: "error" }, `Could not load the model: ${m.error}`));
    const kept = m.kept > 0 ? `Kept in this browser: ${mb(m.kept)}` : "Not in this browser yet: the first prompt downloads it.";
    const running = m.running ? ` · runs on ${m.running === "webgpu" ? "WebGPU (the GPU)" : `WASM (the CPU, ${m.threads} thread${m.threads === 1 ? "" : "s"})`}` : "";
    box.append(
      el(
        "div",
        { class: "row" },
        el("span", { class: "faint" }, kept + running),
        el("span", { class: "spacer" }),
        m.kept === 0 && m.state !== "loading" ? button("Download now", () => void m.load().catch(() => {}), `Download ${MOBILE_SAM.name} (${mb(MODEL_BYTES)}) now`) : null,
        m.kept > 0 && m.state !== "loading" ? button("Forget", () => void m.forget(), "Delete the model's files from this browser") : null,
      ),
    );
    if (m.encodeMs !== undefined || m.decodeMs !== undefined) {
      const t = (ms: number | undefined) => (ms === undefined ? "–" : ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`);
      box.append(el("span", { class: "readout" }, `Last: embedding ${t(m.encodeMs)}, mask ${t(m.decodeMs)}`));
    }
    return el(
      "div",
      { class: "grid-2 sg-wide" },
      box,
      field("Run on", select([["auto", "WebGPU if there is a GPU, else WASM"], ["webgpu", "WebGPU"], ["wasm", "WASM (the CPU)"]], m.provider, (v) => m.setProvider(v as Provider), "Run on")),
      field("Context (voxels)", numberInput(e.quickContext, (v) => {
        e.quickContext = Math.max(32, Math.min(2048, Math.round(v)));
        e.changed();
      }, { min: 32, max: 2048, step: 32 }), { info: "How much of the section the model sees round the prompt." }),
    );
  }

  // --------------------------------------------------------- image values

  /** The image whose values limit the tools. */
  private intensity(session: Session): HTMLElement {
    const e = this.editor;
    const ref = session.reference;
    const images = readableImages(this.ctx).filter((n) => n !== session.layer);
    return el(
      "div",
      { class: "stack" },
      el(
        "div",
        { class: "grid-2" },
        field("Image", select([["", "None"], ...images.map((n): [string, string] => [n, n])], ref?.layer ?? "", (v) => {
          void e.chooseReference(session, v || undefined);
        }, "Image"), ref ? `Level ${ref.level}: ${physical(ref.levels[ref.level].voxelSize)} voxels` : undefined),
        field("Range", el("div", { class: "sg-inline" }, numberInput(e.low, (v) => {
          e.low = v;
          e.changed();
        }, { step: "any", "aria-label": "Low" }), el("span", { class: "faint" }, "to"), numberInput(e.high, (v) => {
          e.high = v;
          e.changed();
        }, { step: "any", "aria-label": "High" }))),
      ),
      checkbox("Only within the range", e.limit, (v) => {
        e.limit = v;
        e.changed();
      }, { info: "The brush, the eraser and the lasso change only voxels whose image value is within the range." }),
      el("div", { class: "row" }, button("Range from the cursor", () => void e.rangeFromCursor(), "The value under the pointer, ± the tolerance of the range there")),
    );
  }
}
