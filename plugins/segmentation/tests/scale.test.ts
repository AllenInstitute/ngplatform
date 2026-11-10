/**
 * A label volume with 100k segments (a copied connectomics segmentation,
 * say): the state stays small (no colour per segment, hiding one segment
 * does not list every other), the segment list draws only the rows in
 * view, and the tool bar's segment picker builds no option per segment.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type FakeDom, fakeDocument } from "@ngplatform/sdk/testing";
import { Editor } from "../editor.js";
import { forgetPersist } from "../keep.js";
import { LabelVolume } from "../label_volume.js";
import { Panel } from "../panel.js";
import { Session } from "../session.js";
import { Toolbar } from "../toolbar.js";
import type { Voxels } from "../../annotations/voxels.js";
import { fakeContext, memoryStorage } from "./editor_context.js";

const PLACE = Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const N = 100_000;

let dom: FakeDom;
beforeEach(() => {
  dom = fakeDocument();
  forgetPersist();
  vi.stubGlobal("navigator", { storage: memoryStorage().storage });
  vi.stubGlobal("requestAnimationFrame", (f: () => void) => (f(), 0));
});
afterEach(() => {
  dom.restore();
  vi.unstubAllGlobals();
});

/** Every element under `e`, itself included. */
function nodes(e: Element): number {
  let n = 1;
  for (const c of e.children) n += nodes(c);
  return n;
}

/** An editor with one volume of N segments (one voxel each but the first) open, being edited. */
async function manySegments() {
  const f = fakeContext();
  const editor = new Editor(f.ctx, {} as Voxels);
  const volume = new LabelVolume([64, 64, 32], "uint32", PLACE, "t");
  const chunk = volume.chunk(0, true)!;
  for (let i = 0; i < N; ++i) chunk[i] = i + 1;
  const session = await Session.open(f.ctx, {} as Voxels, volume, "Labels");
  (editor as unknown as { adopt(s: Session, edit?: boolean): void }).adopt(session, true);
  return { ...f, editor, session };
}

describe(`${N.toLocaleString("en-GB")} segments`, () => {
  it("keep the state small, the list and the tool bar drawn in view only", async () => {
    const w = await manySegments();
    const layer = () => w.ng.layers[0] as { segmentColors?: Record<string, string>; segments?: string[] };
    const stateBytes = () => JSON.stringify(w.ng).length + JSON.stringify(w.ctx.state.get() ?? null).length;
    const opened = stateBytes();
    w.editor.show(w.session, 5, false);
    const hidden = stateBytes();
    const t0 = performance.now();
    const host = dom.host();
    const offPanel = new Panel(w.ctx, w.editor, {} as Voxels).render(host);
    const drawMs = performance.now() - t0;
    const list = host.querySelector(".sg-segments")!;
    const toolbar = new Toolbar(w.ctx, w.editor);
    const bar = w.overlays.map((o) => o.querySelector(".sg-bar")).find((b) => b !== null);
    const barNodes = bar ? nodes(bar) : NaN;
    console.log(
      `${N} segments: state ${opened.toLocaleString("en-GB")} bytes opened, ${hidden.toLocaleString("en-GB")} with one hidden ` +
        `(colours ${Object.keys(layer().segmentColors ?? {}).length}, segments listed ${(layer().segments ?? []).length}); ` +
        `panel drawn in ${drawMs.toFixed(0)} ms, the list ${nodes(list).toLocaleString("en-GB")} elements, the tool bar ${barNodes.toLocaleString("en-GB")}`,
    );
    expect(Object.keys(layer().segmentColors ?? {}).length).toBeLessThan(100);
    expect(hidden).toBeLessThan(10_000);
    expect(nodes(list)).toBeLessThan(2_000);
    expect(barNodes).toBeLessThan(500);
    // The segment hidden: the layer shows the others as a temporary set, and the list says so.
    const temporary = vi.mocked(w.ctx.viewer.setTemporaryVisibleSegments).mock.calls.at(-1)!;
    expect(temporary[0]).toBe("Labels");
    expect(temporary[1]!.length).toBe(N - 1);
    expect(temporary[1]!.includes(5n)).toBe(false);
    expect(w.editor.rows().find((r) => r.value === 5)!.visible).toBe(false);
    // Shown again: no temporary set, nothing kept.
    w.editor.show(w.session, 5, true);
    expect(vi.mocked(w.ctx.viewer.setTemporaryVisibleSegments).mock.calls.at(-1)![1]).toBeUndefined();
    // Scrolled far down, the rows there are drawn (and only about as many).
    const ids = () => [...list.querySelectorAll(".sg-id")].map((x) => Number(dom.text(x)));
    expect(ids()[0]).toBe(1);
    (list as HTMLElement).scrollTop = 27 * 80_000;
    dom.fire(list as HTMLElement, "scroll");
    expect(ids()).toContain(80_001);
    expect(nodes(list)).toBeLessThan(2_000);
    // The picker finds a segment by id among 100k, listing at most 50.
    const picker = bar!.querySelector("input.sg-segment-select") as HTMLInputElement;
    dom.fire(picker, "focus");
    picker.value = "5432";
    dom.fire(picker, "input");
    const options = bar!.querySelectorAll(".sg-picker-option");
    expect(options.length).toBe(11);
    expect(dom.text(options[0])).toContain("5432");
    const chosen = Number(dom.text(options[3].querySelector(".sg-id")!));
    dom.fire(options[3], "mousedown");
    expect(w.editor.value).toBe(chosen);
    toolbar.dispose();
    offPanel();
    await new Promise((resolve) => setTimeout(resolve, 0));
    w.editor.dispose();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }, 600_000);
});
