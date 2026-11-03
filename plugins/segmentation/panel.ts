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
import { iconButton } from "./icons.js";
import { LABEL_MAX, type LabelType } from "./label_volume.js";
import { niftiBytes } from "./save.js";
import { segmentName } from "./segments.js";
import type { Session } from "./session.js";
import { brushes, TOOLS } from "./tools.js";

export class Panel {
  // The New form's choices.
  private newLayer = "";
  private newLevel = 0;
  private newType: LabelType = "uint8";
  private newName = "";
  private newCopy = true;
  private showForm = false;
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
      el("span", { class: "an-faint sg-size" }, `${volume.size.join(" × ")} voxels of ${edges.map((x) => physical(x)).join(" × ")} · ${volume.type}`),
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
    const copy = isSegmentation && this.newCopy;
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
    const type = copy && levels[this.newLevel] ? labelTypeOf(levels[this.newLevel].type) : this.newType;
    const levelLabel = (l: ImageLevel, i: number) => {
      const n = l.size[0] * l.size[1] * l.size[2];
      const bytes = n * (type === "uint8" ? 1 : type === "uint16" ? 2 : 4);
      return `${i}: ${l.size.join(" × ")}, ${physical(l.voxelSize)} (${copy ? (n > MAX_COPY ? "too large to copy" : `${fmtBytes(bytes)} at most`) : `${fmtBytes(bytes)} if all painted`})`;
    };
    const defaultName = copy ? `${this.newLayer} (edited)` : "Segmentation";
    const name = el("input", { class: "text-input", type: "text", value: this.newName, placeholder: defaultName, "aria-label": "Name" }) as HTMLInputElement;
    name.addEventListener("change", () => (this.newName = name.value.trim()));
    const create = button(copy ? "Copy and edit" : "Create", () => {
      create.disabled = true;
      void e.create({ layer: this.newLayer, level: this.newLevel, type: this.newType, name: this.newName || defaultName, copy }).then((made) => {
        if (made) {
          this.showForm = false;
          this.newName = "";
        }
        e.changed();
      });
    }, copy ? "A copy of this segmentation's labels at this level, to edit (the original is hidden and not changed)" : "An empty label volume on this layer's grid", "btn primary small");
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
            field("Level", select(levels.map((l, i) => [String(i), levelLabel(l, i)]), String(this.newLevel), (v) => {
              this.newLevel = Number(v);
              e.changed();
            }, "Level")),
            isSegmentation
              ? field("Start", select([["copy", "A copy of its labels"], ["empty", "Empty"]], this.newCopy ? "copy" : "empty", (v) => {
                  this.newCopy = v === "copy";
                  e.changed();
                }, "Start"))
              : null,
            copy
              ? null
              : field("Labels", select([["uint8", "8-bit (to 255)"], ["uint16", "16-bit (to 65,535)"], ["uint32", "32-bit"]], this.newType, (v) => {
                  this.newType = v as LabelType;
                  e.changed();
                }, "Type")),
          ),
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
                el("span", { class: "an-faint" }, `${k.size.join(" × ")}, ${new Date(k.time).toLocaleString()}`),
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
        e.current
          ? button("Cancel", () => {
              this.showForm = false;
              e.changed();
            })
          : null,
      ),
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
      el("p", { class: "an-hint" }, `In the page: ${volume.chunkCount} chunks, ${fmtBytes(volume.bytes)}. ${session.unsaved ? `${session.unsaved} change${session.unsaved === 1 ? "" : "s"} not saved.` : "Nothing unsaved."}`),
      e.editing ? null : el("p", { class: "an-hint" }, "Edit shows the tool bar over the views; B, E, F, I, Q pick tools there."),
    );
  }

  private saveRow(session: Session): HTMLElement {
    const e = this.editor;
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
    const table = el("div", { class: "sg-segments", role: "list" });
    for (const r of rows) {
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
        { class: `sg-segment${active ? " sg-active" : ""}`, role: "listitem", title: active ? "The active segment: tools paint it" : "Click to paint with it" },
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
      table.append(row);
    }
    const max = LABEL_MAX[session.volume.type];
    return el(
      "div",
      { class: "sg-list" },
      el(
        "div",
        { class: "an-row" },
        button("+ New segment", () => e.newSegment(), "One more than the largest id used (C)"),
        el("span", { class: "an-spacer" }),
        el("span", { class: "an-faint" }, "Active"),
        numberInput(e.value, (v) => e.activate(v), { min: 1, max, step: 1, "aria-label": "Active segment" }),
      ),
      table,
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
      );
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
      el("label", { class: "field check" }, limit, el("span", {}, "Brush and eraser only within the range")),
      el("div", { class: "an-row" }, button("Range from the cursor", () => void e.rangeFromCursor(), "The value under the pointer, ± the tolerance of the range there")),
    );
  }
}
