/**
 * The Segmentation tab: the label volumes open (one edited at a time), a
 * new segmentation layer, saving, the segment list, the active tool's
 * settings, and the image whose values limit the tools.  The tools
 * themselves are also on the tool bar over the views (./toolbar.ts).
 */
import type { Disposer, PlatformContext } from "@ngplatform/sdk";
import { voxelEdges, voxelVolume } from "../annotations/geometry.js";
import { button, el, field, numberInput, physical, select } from "../annotations/ui.js";
import { layerStore, readableImages, type Voxels } from "../annotations/voxels.js";
import { type Editor, fmtBytes, type ImageLevel, labelTypeOf, MAX_COPY, MAX_NIFTI } from "./editor.js";
import { CowVolume } from "./cow_volume.js";
import { iconButton } from "./icons.js";
import { LABEL_MAX, type LabelType } from "./label_volume.js";
import { niftiBytes } from "./save.js";
import { groupOf, grouped } from "./segment_groups.js";
import { segmentName } from "./segments.js";
import type { Session } from "./session.js";
import { brushes, TOOLS } from "./tools.js";

export class Panel {
  // The New form's choices.
  private newLayer = "";
  private newLevel = 0;
  private newType: LabelType = "uint8";
  private newName = "";
  /** A segmentation's new layer starts as a copy of its labels, edits it in place, or starts empty. */
  private newStart: "copy" | "inPlace" | "empty" = "copy";
  private showForm = false;
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
    const draw = () => {
      const children: Node[] = [];
      const e = this.editor;
      if (e.current) children.push(this.head(e.current));
      if (e.current === undefined || this.showForm) children.push(this.newForm());
      if (e.current) children.push(this.sessionView(e.current));
      // Taking out a field that has the focus fires its change event, whose
      // handler asks for a redraw: that one waits until this one is done.
      busy = true;
      try {
        host.replaceChildren(el("div", { class: "sg" }, ...children));
      } finally {
        busy = false;
      }
    };
    let busy = false;
    let queued = false;
    // Redrawn at most once a frame, and not while a field in it is being typed in.
    const update = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        const active = document.activeElement;
        if (active instanceof HTMLInputElement && active.type === "text" && host.contains(active)) {
          active.addEventListener("blur", () => update(), { once: true });
          return;
        }
        // Not while a segment is dragged onto a group: the row dragged must stay.
        if (this.dragging) {
          document.addEventListener("dragend", () => update(), { once: true });
          return;
        }
        if (busy) queueMicrotask(update);
        else draw();
      });
    };
    draw();
    const off = this.editor.onChanged(update);
    return () => off();
  }

  private head(session: Session): HTMLElement {
    const e = this.editor;
    const volume = session.volume;
    const edges = voxelEdges(session.placement()?.voxelToMm ?? volume.voxelToRas);
    const editing = e.editing;
    return el(
      "div",
      { class: "sg-head" },
      el(
        "div",
        { class: "an-row" },
        e.inScene().length > 1
          ? select(e.inScene().map((s) => [s.fileName, s.layer]), session.fileName, (v) => {
              const s = e.inScene().find((x) => x.fileName === v);
              if (s) e.setCurrent(s);
            }, "Label volume")
          : el("strong", {}, session.layer),
        el("span", { class: "an-spacer" }),
        button(editing ? "Editing" : "Edit", () => e.setEditing(!editing), editing ? "Hide the tool bar: the views are Neuroglancer's again" : "Show the tool bar over the views", editing ? "btn primary small" : "btn outline small"),
        button("New…", () => {
          this.showForm = true;
          e.changed();
        }, "A new segmentation layer"),
        button("Close", () => void e.close(session), "Remove it from the scene"),
      ),
      el("span", { class: "an-faint sg-size" }, `${volume.size.join(" × ")} voxels of ${edges.map((x) => physical(x)).join(" × ")} · ${volume.type}${volume instanceof CowVolume ? ` · ${volume.original.layer} edited in place` : ""}`),
    );
  }

  private newForm(): HTMLElement {
    const e = this.editor;
    const open = new Set(e.inScene().map((s) => s.layer));
    const images = readableImages(this.ctx).filter((n) => !open.has(n));
    const segmentations = readableImages(this.ctx, ["segmentation"]).filter((n) => !open.has(n));
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
      create.disabled = true;
      void e.create({ layer: this.newLayer, level: inPlace ? 0 : this.newLevel, type: this.newType, name: this.newName || defaultName, copy, inPlace }).then((made) => {
        if (made) {
          this.showForm = false;
          this.newName = "";
        }
        e.changed();
      });
    }, inPlace ? "Edit this segmentation at its finest level without copying it: chunks are read from it until changed (it is hidden and never written)" : copy ? "A copy of this segmentation's labels at this level, to edit (the original is hidden and not changed)" : "An empty label volume on this layer's grid", "btn primary small");
    create.disabled = !this.newLayer || levels.length === 0;
    return el(
      "div",
      { class: "an-form" },
      el("h4", { class: "an-sub" }, "New segmentation layer"),
      layers.length === 0
        ? el("p", { class: "empty" }, "Add an image or a segmentation (OME-Zarr, NIfTI, MGH or precomputed) to draw on its grid, or open a NIfTI label image.")
        : el(
            "div",
            { class: "an-grid2" },
            field("On the grid of", select(layers.map((n) => [n, segmentations.includes(n) ? `${n} (segmentation)` : n]), this.newLayer, (v) => {
              this.newLayer = v;
              this.newLevel = 0;
              e.changed();
            }, "Layer")),
            field("Name", name),
            inPlace && !tooLarge
              ? field("Level", el("span", { class: "an-faint" }, levels[0] ? `0: ${levels[0].size.join(" × ")}, ${physical(levels[0].voxelSize)} (the finest)` : "…"))
              : field("Level", select(levels.map((l, i) => [String(i), levelLabel(l, i)]), String(this.newLevel), (v) => {
                  this.newLevel = Number(v);
                  e.changed();
                }, "Level")),
            isSegmentation
              ? field("Start", select([["copy", "A copy of its labels"], ["inPlace", "Edit it in place (nothing copied)"], ["empty", "Empty"]], this.newStart, (v) => {
                  this.newStart = v as "copy" | "inPlace" | "empty";
                  e.changed();
                }, "Start"))
              : null,
            copy || inPlace
              ? null
              : field("Labels", select([["uint8", "8-bit (to 255)"], ["uint16", "16-bit (to 65,535)"], ["uint32", "32-bit"]], this.newType, (v) => {
                  this.newType = v as LabelType;
                  e.changed();
                }, "Type")),
          ),
      inPlace ? this.inPlaceHint(tooLarge ? levels[this.newLevel] : undefined) : null,
      e.keptHere.length
        ? el(
            "div",
            { class: "an-kept" },
            el("p", { class: "an-hint" }, "Kept in this browser (as drawn, not saved):"),
            ...e.keptHere.map((k) =>
              el(
                "div",
                { class: "an-row" },
                el("span", {}, k.name),
                el("span", { class: "an-faint" }, `${k.size.join(" × ")}${k.original ? `, edits of ${k.original.layer}` : ""}, ${new Date(k.time).toLocaleString()}`),
                el("span", { class: "an-spacer" }),
                button("Open", () => void e.reopen(k).then(() => e.refreshKept(), (err) => this.ctx.ui.toast(`Could not open it: ${(err as Error).message}`, "error")), "Open it again as a new layer"),
                button("Discard", () => void e.discardKept(k.id), "Forget it"),
              ),
            ),
          )
        : null,
      el(
        "div",
        { class: "an-row" },
        layers.length ? create : null,
        button("Open NIfTI…", () => e.pickNifti(), "Edit a label image from this computer (.nii, .nii.gz)"),
        button("Open edits…", () => e.pickEdits(), "Edits of a segmentation saved here (Save → Edits only, an OME-Zarr folder), opened over the original again"),
        e.current
          ? button("Cancel", () => {
              this.showForm = false;
              e.changed();
            })
          : null,
      ),
    );
  }

  /** What editing in place keeps, and where. */
  private inPlaceHint(level: ImageLevel | undefined): HTMLElement {
    const layer = this.newLayer;
    return el(
      "p",
      { class: "an-hint sg-inplace" },
      level ? `Level ${this.newLevel} is ${level.size.join(" × ")} voxels, more than a copy holds (${MAX_COPY / 2 ** 20} M), so it is edited in place. ` : "",
      `Edit in place copies nothing first: ${layer}'s chunks (64³ voxels) are read at its finest level as they are shown or drawn on, and a chunk is copied when you first change it. Only the changed chunks are kept: in this page (up to 512 MB), and in this browser's storage (OPFS) a moment after each stroke, beyond which they are read back from there. ${layer} itself is hidden and never written. Save writes the edits alone (an OME-Zarr that names ${layer}) or the whole volume.`,
    );
  }

  private sessionView(session: Session): HTMLElement {
    const e = this.editor;
    const volume = session.volume;
    return el(
      "div",
      { class: "sg-session" },
      this.saveRow(session),
      el("h4", { class: "an-sub" }, "Segments"),
      this.segmentList(session),
      el("h4", { class: "an-sub" }, "Tool"),
      this.toolRow(),
      this.toolOptions(),
      el("h4", { class: "an-sub" }, "Image values"),
      this.intensity(session),
      el(
        "p",
        { class: "an-hint" },
        volume instanceof CowVolume
          ? `Edited in place over ${volume.original.layer}: ${volume.chunkCount} chunk${volume.chunkCount === 1 ? "" : "s"} of 64³ edited (${fmtBytes(volume.bytes)} in this page${volume.spilledCount ? `, ${volume.spilledCount} more kept only in this browser` : ""}); the rest is read from ${volume.original.store}. Segment voxels are counted in the edited chunks. `
          : `In the page: ${volume.chunkCount} chunks, ${fmtBytes(volume.bytes)}. `,
        session.unsaved ? `${session.unsaved} change${session.unsaved === 1 ? "" : "s"} not saved.` : "Nothing unsaved.",
      ),
      e.editing ? null : el("p", { class: "an-hint" }, "Edit shows the tool bar over the views; B, E, L, F, I, Q pick tools there."),
    );
  }

  private saveRow(session: Session): HTMLElement {
    const e = this.editor;
    if (session.volume instanceof CowVolume) {
      return el(
        "div",
        { class: "sg-save" },
        el(
          "div",
          { class: "an-row" },
          select([["edits", "Edits only (OME-Zarr)"], ["whole", "The whole volume (OME-Zarr, a job)"]], e.saveInPlace, (v) => {
            e.saveInPlace = v as "edits" | "whole";
            e.changed();
          }, "Save"),
          el("span", { class: "an-spacer" }),
          button("Save", () => void e.save(), "Save to this computer", "btn primary small"),
        ),
        el(
          "p",
          { class: "an-hint" },
          e.saveInPlace === "edits"
            ? `The edited chunks only, on ${session.volume.original.layer}'s levels, with a note of where it is; Open edits… opens them over it again.`
            : "Every chunk, into a folder, as a job: the original's copied a block at a time, the edited ones as edited.",
        ),
        e.note ? el("p", { class: "an-hint" }, e.note) : null,
      );
    }
    const saveBox = el("input", { type: "checkbox", "aria-label": "Only the painted box" }) as HTMLInputElement;
    saveBox.checked = e.saveCrop;
    saveBox.addEventListener("change", () => (e.saveCrop = saveBox.checked));
    const big = niftiBytes(session.volume) > MAX_NIFTI;
    return el(
      "div",
      { class: "sg-save" },
      el(
        "div",
        { class: "an-row" },
        select([["nii.gz", "NIfTI (.nii.gz)"], ["zarr", "OME-Zarr folder"]], e.saveFormat, (v) => {
          e.saveFormat = v as "nii.gz" | "zarr";
          e.changed();
        }, "Format"),
        el("label", { class: "field check" }, saveBox, el("span", {}, "Only the painted box")),
        el("span", { class: "an-spacer" }),
        button("Save", () => void e.save(), "Save to this computer", "btn primary small"),
      ),
      big && e.saveFormat === "nii.gz" ? el("p", { class: "an-hint" }, "This grid is too large for one NIfTI: save the painted box, or as OME-Zarr (only painted chunks are written).") : null,
      e.note ? el("p", { class: "an-hint" }, e.note) : null,
    );
  }

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
        const h = el("div", { class: "sg-group-head sg-ungrouped", role: "listitem", title: "Segments in no group: drag one here to take it out of its group" }, el("span", { class: "sg-caret" }), el("span", { class: "sg-name an-faint" }, "No group"), el("span", { class: "sg-count" }, String(count)));
        dropTarget(h, undefined);
        return h;
      }
      const colour = el("input", { type: "color", value: group.colour, title: "The group's colour: given to every segment in it", "aria-label": `Colour of group ${group.name}` }) as HTMLInputElement;
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
      const colour = el("input", { type: "color", value: r.colour, title: "Colour", "aria-label": `Colour of segment ${r.value}` }) as HTMLInputElement;
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
    if (vg.groups.length === 0) {
      for (const r of rows) table.append(segmentRow(r, false));
    } else {
      for (const section of grouped(vg, rows)) {
        table.append(head(section.group, section.rows.length, section.rows.filter((r) => r.visible).length));
        if (!section.group?.collapsed) for (const r of section.rows) table.append(segmentRow(r, true));
      }
    }
    const max = LABEL_MAX[session.volume.type];
    return el(
      "div",
      { class: "sg-list" },
      el(
        "div",
        { class: "an-row" },
        button("+ New segment", () => e.newSegment(), "One more than the largest id used (C)"),
        button("+ New group", () => e.newGroup(), "A named group of segments: drag segments onto it"),
        el("span", { class: "an-spacer" }),
        el("span", { class: "an-faint" }, "Active"),
        numberInput(e.value, (v) => e.activate(v), { min: 1, max, step: 1, "aria-label": "Active segment" }),
      ),
      table,
      vg.groups.length
        ? el(
            "div",
            { class: "an-row" },
            el("span", { class: "an-faint" }, `Segment ${e.value} in`),
            select([["", "No group"], ...vg.groups.map((g): [string, string] => [g.id, g.name])], groupOf(vg, e.value)?.id ?? "", (v) => e.assignGroup([e.value], v || undefined), "Group of the active segment"),
          )
        : null,
      rows.every((r) => r.voxels === 0) ? el("p", { class: "an-hint" }, "Nothing painted yet: choose Brush (B) and draw in a view.") : null,
    );
  }

  private toolRow(): HTMLElement {
    const e = this.editor;
    const tools = el("div", { class: "segmented an-tools" });
    for (const t of TOOLS) {
      tools.append(el("button", { type: "button", title: `${t.hint} (${t.key})`, "aria-pressed": String(e.editing && e.tool === t.id), onclick: () => e.setTool(t.id) }, t.title));
    }
    return tools;
  }

  private toolOptions(): HTMLElement | null {
    const e = this.editor;
    const options = el("div", { class: "an-grid2" });
    if (brushes(e.tool)) {
      options.append(
        field("Radius", el("div", { class: "an-inline" }, numberInput(e.radius, (v) => e.setRadius(Math.max(0.01, v)), { min: 0.01, step: "any", "aria-label": "Radius" }), select([["voxels", "voxels"], ["mm", "mm"], ["µm", "µm"]], e.unit, (v) => {
          e.unit = v as "mm" | "µm" | "voxels";
          e.changed();
        }, "Unit")), "Alt+wheel, [ and ] in the views"),
        field("Shape", select([["disc", "Disc in the section"], ["ball", "Ball"]], e.shape, (v) => (e.shape = v as "ball" | "disc"), "Shape")),
        e.tool === "brush"
          ? field("Paint over", select([["all", "Any segment"], ["empty", "Empty voxels only"]], e.overwrite, (v) => {
              e.overwrite = v as "all" | "empty";
              e.changed();
            }, "Paint over"))
          : field("Erase", select([["any", "Any segment"], ["only", "The active segment only"]], e.eraseOnly ? "only" : "any", (v) => (e.eraseOnly = v === "only"), "Erase")),
      );
    } else if (e.tool === "lasso") {
      options.append(
        field("Inside", select([["paint", "Paint the active segment"], ["erase", "Erase"]], e.lassoErase ? "erase" : "paint", (v) => {
          e.lassoErase = v === "erase";
          e.changed();
        }, "Inside the outline")),
        e.lassoErase
          ? field("Erase", select([["any", "Any segment"], ["only", "The active segment only"]], e.eraseOnly ? "only" : "any", (v) => (e.eraseOnly = v === "only"), "Erase"))
          : field("Paint over", select([["all", "Any segment"], ["empty", "Empty voxels only"]], e.overwrite, (v) => {
              e.overwrite = v as "all" | "empty";
              e.changed();
            }, "Paint over")),
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
        field("Paint over", select([["all", "Any segment"], ["empty", "Empty voxels only"]], e.overwrite, (v) => {
          e.overwrite = v as "all" | "empty";
          e.changed();
        }, "Paint over")),
      );
      if (e.fill3d) options.append(field("Reach (voxels)", numberInput(e.reach, (v) => (e.reach = Math.max(1, Math.min(256, Math.round(v)))), { min: 1, max: 256, step: 1 }), "The fill stays in a box this far round the click"));
    } else if (e.tool === "quick") {
      const methods = e.quickSelect.methods();
      options.append(
        field("Method", select(methods.map((m) => [m.id, m.title]), e.method, (v) => {
          e.method = v;
          e.changed();
        }, "Method"), methods.find((m) => m.id === e.method)?.description),
        field("Tolerance", numberInput(e.tolerance, (v) => (e.tolerance = Math.max(0, Math.min(1, v))), { min: 0, max: 1, step: 0.01 }), "For a click: how far from its value, as a fraction of the range"),
        field("Result", select([["preview", "Preview first (Enter paints, Escape drops)"], ["paint", "Paint at once"]], e.quickMode, (v) => {
          e.quickMode = v as "preview" | "paint";
          e.changed();
        }, "Result")),
        field("Paint over", select([["all", "Any segment"], ["empty", "Empty voxels only"]], e.overwrite, (v) => {
          e.overwrite = v as "all" | "empty";
          e.changed();
        }, "Paint over")),
      );
      if (e.pending) {
        options.append(
          el(
            "div",
            { class: "an-row" },
            el("span", { class: "an-faint" }, `Proposed: ${e.pending.voxels.toLocaleString()} voxels`),
            el("span", { class: "an-spacer" }),
            button("Accept", () => e.acceptPreview(), "Paint the mask with the active segment (Enter)", "btn primary small"),
            button("Cancel", () => e.cancelPreview(), "Drop the mask (Escape)"),
          ),
        );
      }
    } else if (e.tool === "move") {
      return el("p", { class: "an-hint" }, "Move: the views as Neuroglancer moves them. Pick a tool to draw; Escape comes back here.");
    }
    return options.childElementCount ? options : null;
  }

  /** The image whose values limit the tools. */
  private intensity(session: Session): HTMLElement {
    const e = this.editor;
    const ref = session.reference;
    const images = readableImages(this.ctx).filter((n) => n !== session.layer);
    const limit = el("input", { type: "checkbox", "aria-label": "Limit to an intensity range" }) as HTMLInputElement;
    limit.checked = e.limit;
    limit.addEventListener("change", () => {
      e.limit = limit.checked;
      e.changed();
    });
    return el(
      "div",
      { class: "an-limit" },
      el(
        "div",
        { class: "an-grid2" },
        field("Image", select([["", "None"], ...images.map((n): [string, string] => [n, n])], ref?.layer ?? "", (v) => {
          void e.chooseReference(session, v || undefined);
        }, "Image"), ref ? `Level ${ref.level}: ${physical(ref.levels[ref.level].voxelSize)} voxels` : undefined),
        field("Range", el("div", { class: "an-inline" }, numberInput(e.low, (v) => (e.low = v), { step: "any", "aria-label": "Low" }), el("span", { class: "an-faint" }, "to"), numberInput(e.high, (v) => (e.high = v), { step: "any", "aria-label": "High" }))),
      ),
      el("label", { class: "field check" }, limit, el("span", {}, "Brush, eraser and lasso only within the range")),
      el("div", { class: "an-row" }, button("Range from the cursor", () => void e.rangeFromCursor(), "The value under the pointer, ± the tolerance of the range there")),
    );
  }
}
