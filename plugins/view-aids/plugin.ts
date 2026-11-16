/**
 * The view aids, after Siemens' Cinematic Anatomy, for every scene: the
 * orientation cube (./cube.ts), labels with leader lines (./labels.ts),
 * Hide graphics, and bookmarks of the camera (./strip.ts), over
 * Neuroglancer's 3-D view.  Its three switches sit beside Sections (in the
 * 3-D-only layout, where Neuroglancer has no Sections, in a group of their
 * own in that place); every action is also a command.
 *
 * Only the labels go into screenshots and captures: the cube and the strip
 * are page elements over the view, which Neuroglancer's canvas does not
 * hold.
 */
import type { Disposer, PlatformContext, PluginModule, ViewPanelInfo } from "@ngplatform/sdk";
import { el } from "@ngplatform/sdk/dom";
import { CameraMover, cameraNow } from "./camera.js";
import { CUBE_SIZE, OrientationCube } from "./cube.js";
import { type Axes, axesOf, FACES, lookingFrom, nearestStandard, quarterTurn, type QuarterTurn, readQuat, targetLetters, targetWords, type Vec3 } from "./geometry.js";
import { PointLabels } from "./labels.js";
import { type Bookmark, graphicsNow, graphicsOff, nextName, readSaved, type Saved, THUMB } from "./state.js";
import { BookmarkStrip } from "./strip.js";
import { STYLE } from "./style.js";

/** Below Neuroglancer's own buttons in the panel's top right. */
const CUBE_TOP = 32;
const EDGE = 8;
/** The cube with its buttons, and room under them. */
const CUBE_BLOCK = CUBE_SIZE + 4 + 24 + 8;
/** Time to turn to a face, and to fly to a bookmark; a hold at each while playing (ms). */
const TURN_MS = 300;
const FLY_MS = 800;
const PLAY_FLY_MS = 1600;
const PLAY_HOLD_MS = 1200;

class ViewAids {
  private saved: Saved;
  private readonly overlay: { element: HTMLElement; dispose(): void };
  private readonly style = document.createElement("style");
  private readonly cube: OrientationCube;
  private readonly labels: PointLabels;
  private readonly strip: BookmarkStrip;
  private readonly mover: CameraMover;
  private readonly toggles: { cube: { set(v: boolean): void; dispose(): void }; labels: { set(v: boolean): void; dispose(): void }; graphics: { set(v: boolean): void; dispose(): void } };
  private axes: Axes = axesOf(undefined, undefined);
  private axesKey = "";
  private faceCommands: Disposer[] = [];
  private bookmarkCommands: Disposer[] = [];
  private bookmarksKey = "";
  /** The bookmark last gone to. */
  private current: string | undefined;
  private playing = 0;
  private holdCancel: (() => void) | undefined;
  private panelRect: DOMRect | undefined;
  /** The three switches, for a 3-D view that has no Sections group of its own (Neuroglancer's 3-D-only layout). */
  private readonly fallback: { element: HTMLElement; inputs: Record<"cube" | "labels" | "graphics", HTMLInputElement> };
  private queued = false;
  private readonly offs: Disposer[] = [];

  constructor(private readonly ctx: PlatformContext) {
    this.saved = readSaved(ctx.state.get());
    this.style.textContent = STYLE;
    document.head.append(this.style);
    this.overlay = ctx.ui.overlay();
    this.mover = new CameraMover(ctx);
    this.cube = new OrientationCube({
      pick: (target) => void this.lookFrom(target),
      realign: () => void this.realign(),
      turn: (how) => void this.turn(how),
      bookmark: () => void this.addBookmark(),
    });
    this.labels = new PointLabels(ctx);
    this.strip = new BookmarkStrip({
      go: (id) => void this.go(id, FLY_MS),
      rename: (id) => void this.rename(id),
      update: (id) => void this.replace(id),
      remove: (id) => this.remove(id),
      play: () => void this.play(),
    });
    this.fallback = this.makeFallback();
    this.overlay.element.append(this.labels.canvas, this.cube.element, this.strip.element, this.fallback.element);
    this.toggles = {
      cube: ctx.ui.viewToggle({ label: "Cube", title: "The orientation cube (View aids)", value: this.saved.cube, order: 10, onChange: (v) => this.write({ cube: v }) }),
      labels: ctx.ui.viewToggle({ label: "Labels", title: "Point annotations' descriptions, at the sides (View aids)", value: this.saved.labels, order: 11, onChange: (v) => this.write({ labels: v }) }),
      graphics: ctx.ui.viewToggle({
        label: "Graphics",
        title: "Off hides the axis lines, the box, the scale bar and the view aids, for a clean picture (View aids)",
        value: this.saved.hidden === undefined,
        order: 12,
        onChange: (v) => this.setGraphics(v),
      }),
    };
    // Labels off hides every name drawn in the views: the zoom boxes' and other plugins' shapes' too.
    ctx.views.setLabelsHidden?.(!this.saved.labels);
    this.offs.push(
      ctx.state.onChanged(() => {
        this.saved = readSaved(ctx.state.get());
        this.toggles.cube.set(this.saved.cube);
        this.toggles.labels.set(this.saved.labels);
        this.toggles.graphics.set(this.saved.hidden === undefined);
        this.ctx.views.setAllHidden(this.saved.hidden !== undefined);
        this.ctx.views.setLabelsHidden?.(!this.saved.labels);
        this.schedule();
      }),
      ctx.viewer.onRendered(() => this.schedule()),
      ctx.viewer.onStateChanged(() => this.schedule()),
      ctx.ui.screenshotOverlay((context, canvas) => {
        if (this.panelRect !== undefined) this.labels.paint(context, canvas, this.panelRect);
      }),
    );
    const resize = () => this.schedule();
    window.addEventListener("resize", resize);
    this.offs.push(() => window.removeEventListener("resize", resize));
    this.registerCommands();
    this.schedule();
  }

  dispose(): void {
    this.stopPlaying();
    this.mover.dispose();
    this.offs.splice(0).forEach((off) => off());
    this.faceCommands.splice(0).forEach((off) => off());
    this.bookmarkCommands.splice(0).forEach((off) => off());
    for (const toggle of Object.values(this.toggles)) toggle.dispose();
    this.ctx.views.setLabelsHidden?.(false);
    this.strip.dispose();
    this.fallback.element.remove();
    this.overlay.dispose();
    this.style.remove();
  }

  // ------------------------------------------------------------- state

  private write(patch: Partial<Saved>): void {
    const next: Saved = { ...this.saved, ...patch };
    if ("hidden" in patch && patch.hidden === undefined) delete next.hidden;
    this.saved = next;
    this.ctx.state.set(next);
    this.schedule();
  }

  private part(key: string): unknown {
    return this.ctx.viewer.statePart ? this.ctx.viewer.statePart(key) : (this.ctx.viewer.getState() as Record<string, unknown>)[key];
  }

  /** Hides Neuroglancer's graphics and the aids (keeping what was on), or puts them back. */
  private setGraphics(shown: boolean): void {
    if (!shown && this.saved.hidden === undefined) {
      const before = graphicsNow((k) => this.part(k));
      // The state first, then the plugin's record: one undo step.
      this.ctx.viewer.patchState((ng) => void Object.assign(ng, graphicsOff()));
      this.write({ hidden: before });
    } else if (shown && this.saved.hidden !== undefined) {
      const before = this.saved.hidden;
      this.ctx.viewer.patchState((ng) => void Object.assign(ng, before));
      this.write({ hidden: undefined });
    }
    this.toggles.graphics.set(this.saved.hidden === undefined);
    this.ctx.views.setAllHidden(this.saved.hidden !== undefined);
  }

  // ---------------------------------------------------------- per frame

  private schedule(): void {
    if (this.queued) return;
    this.queued = true;
    requestAnimationFrame(() => {
      this.queued = false;
      this.place();
    });
  }

  /** Places and draws the aids over the 3-D panel (the first, when there are several). */
  private place(): void {
    const panel = this.ctx.viewer.panels().find((p) => p.kind === "3d");
    const axes = axesOf(this.part("dimensions"), this.part("displayDimensions"));
    this.setAxes(axes);
    this.syncBookmarkCommands();
    const base = this.overlay.element.getBoundingClientRect();
    const rect = panel?.element.getBoundingClientRect();
    // Neuroglancer's switches, else the aids' own in their place.
    let switches = panel && this.switchesLeft(panel);
    const fallback = this.fallback;
    fallback.element.hidden = panel === undefined || switches !== undefined;
    if (!fallback.element.hidden && rect !== undefined) {
      fallback.inputs.cube.checked = this.saved.cube;
      fallback.inputs.labels.checked = this.saved.labels;
      fallback.inputs.graphics.checked = this.saved.hidden === undefined;
      fallback.element.style.right = `${base.right - rect.right + 4}px`;
      fallback.element.style.bottom = `${base.bottom - rect.bottom + 4}px`;
      switches = fallback.element.getBoundingClientRect().left;
    }
    const clean = this.saved.hidden !== undefined;
    if (panel === undefined || rect === undefined || clean) {
      this.panelRect = undefined;
      this.cube.element.hidden = true;
      this.strip.element.hidden = true;
      this.labels.canvas.hidden = true;
      this.labels.clear();
      return;
    }
    this.panelRect = rect;
    const left = rect.left - base.left;
    const top = rect.top - base.top;
    // The cube: under Neuroglancer's buttons, when the view has room for it.
    const showCube = this.saved.cube && rect.width >= 220 && rect.height >= 200;
    this.cube.element.hidden = !showCube;
    if (showCube) {
      this.cube.element.style.left = `${left + rect.width - EDGE - CUBE_SIZE}px`;
      this.cube.element.style.top = `${top + CUBE_TOP}px`;
      this.cube.update(readQuat(this.part("projectionOrientation")), axes);
    }
    // The strip: along the bottom edge, left of the 3-D view's switches.
    const bookmarks = this.saved.bookmarks;
    this.strip.element.hidden = bookmarks.length === 0;
    if (bookmarks.length > 0) {
      const right = switches !== undefined ? switches - base.left - EDGE : left + rect.width * 0.6;
      this.strip.element.style.left = `${left + 4}px`;
      this.strip.element.style.bottom = `${base.bottom - rect.bottom + 4}px`;
      this.strip.element.style.maxWidth = `${Math.max(0, right - left - 4)}px`;
      this.strip.update(bookmarks, this.current, this.playing !== 0);
    }
    // The labels: over the whole panel.
    const canvas = this.labels.canvas;
    canvas.hidden = !this.saved.labels;
    if (this.saved.labels) {
      canvas.style.left = `${left}px`;
      canvas.style.top = `${top}px`;
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      this.labels.update((p) => panel.project(p), rect.width, rect.height, {
        top: 64,
        rightTop: showCube ? CUBE_TOP + CUBE_BLOCK : 64,
        bottom: bookmarks.length > 0 ? 56 : 36,
      });
    } else this.labels.clear();
  }

  private makeFallback(): { element: HTMLElement; inputs: Record<"cube" | "labels" | "graphics", HTMLInputElement> } {
    const make = (label: string, title: string, onChange: (on: boolean) => void) => {
      const input = el("input", { type: "checkbox" }) as HTMLInputElement;
      input.addEventListener("change", () => onChange(input.checked));
      return { input, label: el("label", { class: "view-aids-switch", title }, label, input) };
    };
    const cube = make("Cube", "The orientation cube", (v) => this.write({ cube: v }));
    const labels = make("Labels", "Point annotations' descriptions, at the sides", (v) => this.write({ labels: v }));
    const graphics = make("Graphics", "Off hides the axis lines, the box, the scale bar and the view aids", (v) => this.setGraphics(v));
    const element = el("div", { class: "view-aids-switches view-aids-control over-3d" }, cube.label, labels.label, graphics.label);
    element.hidden = true;
    return { element, inputs: { cube: cube.input, labels: labels.input, graphics: graphics.input } };
  }

  /** Where the 3-D view's switches (Sections and the others) start, in page pixels. */
  private switchesLeft(panel: ViewPanelInfo): number | undefined {
    const group = panel.element.querySelector<HTMLElement>("div.perspective-panel-show-slice-views");
    const r = group?.getBoundingClientRect();
    return r !== undefined && r.width > 0 ? r.left : undefined;
  }

  // ------------------------------------------------------------- the cube

  private orientation() {
    return readQuat(this.part("projectionOrientation"));
  }

  private lookFrom(target: Vec3): Promise<boolean> {
    this.stopPlaying();
    return this.mover.to({ projectionOrientation: lookingFrom(target, this.axes) }, TURN_MS);
  }

  /** A quarter turn of the object as seen, from where the view is turning to (else is). */
  private turn(how: QuarterTurn): Promise<boolean> {
    // Clicked again while turning: on from where the turn was going, so turns add up to whole quarters.
    const going = this.mover.target?.projectionOrientation;
    const from = going !== undefined ? readQuat(going) : this.orientation();
    this.stopPlaying();
    return this.mover.to({ projectionOrientation: quarterTurn(from, how) }, TURN_MS);
  }

  private realign(): Promise<boolean> {
    this.stopPlaying();
    const view = nearestStandard(this.orientation(), this.axes);
    return this.mover.to({ projectionOrientation: view.orientation }, TURN_MS);
  }

  /** Keeps the axes, and the commands that look from each face (named by them). */
  private setAxes(axes: Axes): void {
    this.axes = axes;
    const key = JSON.stringify(axes.words);
    if (key === this.axesKey) return;
    this.axesKey = key;
    this.faceCommands.splice(0).forEach((off) => off());
    FACES.forEach((face, i) => {
      this.faceCommands.push(
        this.ctx.commands.register(`viewAids.from.${i}`, () => this.lookFrom(face), {
          title: `3-D view: look from ${targetWords(face, axes)} (${targetLetters(face, axes)})`,
          group: "View",
        }),
      );
    });
  }

  // ---------------------------------------------------------- bookmarks

  private async addBookmark(): Promise<void> {
    const camera = cameraNow(this.ctx);
    const thumbnail = await this.ctx.viewer.thumbnail?.(THUMB.width, THUMB.height, "3d").catch(() => undefined);
    const bookmark: Bookmark = { id: crypto.randomUUID().slice(0, 8), name: nextName(this.saved.bookmarks), camera, ...(thumbnail ? { thumbnail } : {}) };
    this.current = bookmark.id;
    this.write({ bookmarks: [...this.saved.bookmarks, bookmark] });
    if (this.saved.hidden !== undefined || this.ctx.viewer.panels().every((p) => p.kind !== "3d")) this.ctx.ui.toast(`Bookmarked as “${bookmark.name}”.`);
  }

  private async replace(id: string): Promise<void> {
    const camera = cameraNow(this.ctx);
    const thumbnail = await this.ctx.viewer.thumbnail?.(THUMB.width, THUMB.height, "3d").catch(() => undefined);
    this.write({ bookmarks: this.saved.bookmarks.map((b) => (b.id === id ? { ...b, camera, ...(thumbnail ? { thumbnail } : {}) } : b)) });
    this.current = id;
  }

  private async rename(id: string): Promise<void> {
    const b = this.saved.bookmarks.find((x) => x.id === id);
    if (b === undefined) return;
    const answer = await this.ctx.ui.form<{ name: string }>("Rename the bookmark", { type: "object", properties: { name: { type: "string", title: "Name" } }, required: ["name"] }, { name: b.name });
    const name = answer?.name?.trim();
    if (!name) return;
    this.write({ bookmarks: this.saved.bookmarks.map((x) => (x.id === id ? { ...x, name } : x)) });
  }

  private remove(id: string): void {
    if (this.current === id) this.current = undefined;
    this.write({ bookmarks: this.saved.bookmarks.filter((b) => b.id !== id) });
  }

  private go(id: string, ms: number): Promise<boolean> {
    const b = this.saved.bookmarks.find((x) => x.id === id);
    if (b === undefined) return Promise.resolve(false);
    this.current = id;
    this.schedule();
    return this.mover.to(b.camera, ms);
  }

  private step(by: number): void {
    const list = this.saved.bookmarks;
    if (list.length === 0) return this.ctx.ui.toast("No bookmarks yet: Bookmark this view first.");
    this.stopPlaying();
    const at = list.findIndex((b) => b.id === this.current);
    const next = at < 0 ? (by > 0 ? 0 : list.length - 1) : (at + by + list.length) % list.length;
    void this.go(list[next].id, FLY_MS);
  }

  /** Moves through the bookmarks in order, holding at each; again stops. */
  private async play(): Promise<void> {
    if (this.playing !== 0) return this.stopPlaying();
    const list = this.saved.bookmarks;
    if (list.length < 2) return this.ctx.ui.toast("Two bookmarks or more to play through.");
    const token = Date.now();
    this.playing = token;
    this.schedule();
    for (const b of list) {
      if (this.playing !== token) return;
      const arrived = await this.go(b.id, PLAY_FLY_MS);
      if (!arrived || this.playing !== token) break;
      if (b !== list[list.length - 1] && !(await this.hold(PLAY_HOLD_MS))) break;
    }
    if (this.playing === token) this.playing = 0;
    this.schedule();
  }

  private hold(ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.holdCancel = undefined;
        resolve(true);
      }, ms);
      this.holdCancel = () => {
        clearTimeout(timer);
        this.holdCancel = undefined;
        resolve(false);
      };
    });
  }

  private stopPlaying(): void {
    if (this.playing === 0) return;
    this.playing = 0;
    this.holdCancel?.();
    this.mover.stop();
    this.schedule();
  }

  /** A command to go to each bookmark, by name. */
  private syncBookmarkCommands(): void {
    const key = JSON.stringify(this.saved.bookmarks.map((b) => [b.id, b.name]));
    if (key === this.bookmarksKey) return;
    this.bookmarksKey = key;
    this.bookmarkCommands.splice(0).forEach((off) => off());
    this.saved.bookmarks.forEach((b, i) => {
      this.bookmarkCommands.push(this.ctx.commands.register(`viewAids.go.${b.id}`, () => this.go(b.id, FLY_MS), { title: `Go to bookmark ${i + 1}: ${b.name}`, group: "Bookmarks" }));
    });
  }

  /** Asks which bookmark (by name) for a command; undefined when there are none or it was cancelled. */
  private async chooseBookmark(title: string, extra: Record<string, { type: "string"; title: string }> = {}): Promise<{ bookmark: Bookmark; answer: Record<string, string> } | undefined> {
    const list = this.saved.bookmarks;
    if (list.length === 0) {
      this.ctx.ui.toast("No bookmarks yet: Bookmark this view first.");
      return undefined;
    }
    const names = list.map((b, i) => `${i + 1}: ${b.name}`);
    const current = list.findIndex((b) => b.id === this.current);
    const answer = await this.ctx.ui.form<Record<string, string>>(
      title,
      { type: "object", properties: { bookmark: { type: "string", title: "Bookmark", enum: names }, ...extra }, required: ["bookmark", ...Object.keys(extra)] },
      { bookmark: names[Math.max(0, current)] },
    );
    const index = answer === undefined ? -1 : names.indexOf(answer.bookmark);
    return index < 0 ? undefined : { bookmark: list[index], answer: answer! };
  }

  // ----------------------------------------------------------- commands

  private registerCommands(): void {
    const { commands } = this.ctx;
    this.offs.push(
      commands.register("viewAids.realign", () => this.realign()),
      commands.register("viewAids.cube", () => this.write({ cube: !this.saved.cube })),
      commands.register("viewAids.labels", () => this.write({ labels: !this.saved.labels })),
      commands.register("viewAids.graphics", () => this.setGraphics(this.saved.hidden !== undefined)),
      commands.register("viewAids.bookmark", () => this.addBookmark()),
      commands.register("viewAids.play", () => this.play()),
      commands.register("viewAids.next", () => this.step(1)),
      commands.register("viewAids.previous", () => this.step(-1)),
      commands.register("viewAids.rename", async () => {
        const chosen = await this.chooseBookmark("Rename a bookmark", { name: { type: "string", title: "New name" } });
        const name = chosen?.answer.name?.trim();
        if (chosen && name) this.write({ bookmarks: this.saved.bookmarks.map((x) => (x.id === chosen.bookmark.id ? { ...x, name } : x)) });
      }),
      commands.register("viewAids.delete", async () => {
        const chosen = await this.chooseBookmark("Delete a bookmark");
        if (chosen) this.remove(chosen.bookmark.id);
      }),
    );
  }
}

let aids: ViewAids | undefined;

export const plugin: PluginModule = {
  activate(ctx: PlatformContext) {
    aids = new ViewAids(ctx);
  },
  deactivate() {
    aids?.dispose();
    aids = undefined;
  },
};
