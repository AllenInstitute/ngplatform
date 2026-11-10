/**
 * The editor's sessions over their life: a label layer removed from its
 * scene lets its volume go once the browser keeps it (Activity says so,
 * and that undo brings it back), stays open when the browser cannot keep
 * it, and is not let go when another scene is shown.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type FakeDom, fakeDocument } from "@ngplatform/sdk/testing";
import { Editor, RELEASE_WAIT, SAM_RELEASE_WAIT } from "../editor.js";
import { History, Stroke } from "../history.js";
import { forgetPersist } from "../keep.js";
import { LabelVolume } from "../label_volume.js";
import { Session } from "../session.js";
import type { Voxels } from "../../annotations/voxels.js";
import { fakeContext, memoryStorage } from "./editor_context.js";

const PLACE = Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

let dom: FakeDom;
beforeEach(() => {
  dom = fakeDocument();
  forgetPersist();
});
afterEach(() => {
  vi.useRealTimers();
  dom.restore();
  vi.unstubAllGlobals();
});

/** An editor with one label volume open, painted (2 unsaved changes). */
async function withVolume(full = false) {
  const { files, storage } = memoryStorage(full);
  vi.stubGlobal("navigator", { storage });
  const f = fakeContext();
  const editor = new Editor(f.ctx, {} as Voxels);
  const volume = new LabelVolume([64, 64, 64], "uint8", PLACE, "t");
  volume.chunk(0, true)![1] = 3;
  const session = await Session.open(f.ctx, {} as Voxels, volume, "Labels");
  (editor as unknown as { adopt(s: Session, edit?: boolean): void }).adopt(session, false);
  session.unsaved = 2;
  session.changed([0]);
  const dispose = vi.spyOn(session, "dispose");
  return { ...f, files, editor, session, dispose };
}

/** Lets the editor's wait pass, and what it writes settle. */
async function afterWait() {
  await vi.advanceTimersByTimeAsync(RELEASE_WAIT + 10);
  for (let i = 0; i < 20; ++i) await Promise.resolve();
}

describe("a label layer removed", () => {
  it("lets its volume go once the browser keeps it, and says so in Activity", async () => {
    vi.useFakeTimers();
    const w = await withVolume();
    expect(w.editor.sessions).toHaveLength(1);
    w.layers.splice(0);
    w.fireLayers();
    await afterWait();
    await vi.waitFor(() => expect(w.editor.sessions).toHaveLength(0));
    expect(w.dispose).toHaveBeenCalledWith();
    // Its chunk is kept (the stroke not yet kept was written first).
    expect([...w.files.keys()].some((k) => k.endsWith("/c0"))).toBe(true);
    expect(w.log.info.mock.calls.map((c) => c[0]).join("\n")).toContain("“Labels” was removed: its label volume is closed, and its 2 unsaved changes kept in this browser. Undo brings the layer back");
    expect(w.editor.current).toBeUndefined();
  });

  it("stays open when the browser cannot keep its changes, and Activity says so", async () => {
    vi.useFakeTimers();
    const w = await withVolume(true);
    w.layers.splice(0);
    w.fireLayers();
    await afterWait();
    await vi.waitFor(() => expect(w.log.error.mock.calls.map((c) => c[0]).join("\n")).toContain("“Labels” was removed, but this browser could not keep its 2 unsaved changes"));
    expect(w.editor.sessions).toHaveLength(1);
    expect(w.dispose).not.toHaveBeenCalled();
  });

  it("is not let go when another scene is shown, or when the layer comes back within the wait", async () => {
    vi.useFakeTimers();
    const w = await withVolume();
    const shown = [...w.layers];
    // Another scene: its layers are others.
    w.scenes[0].active = false;
    w.scenes[1].active = true;
    w.layers.splice(0);
    w.fireLayers();
    await afterWait();
    expect(w.editor.sessions).toHaveLength(1);
    // Back, then removed and put back at once (a layer replaced).
    w.scenes[0].active = true;
    w.scenes[1].active = false;
    w.layers.push(...shown);
    w.fireLayers();
    w.layers.splice(0);
    w.fireLayers();
    w.layers.push(...shown);
    w.fireLayers();
    await afterWait();
    expect(w.editor.sessions).toHaveLength(1);
    expect(w.dispose).not.toHaveBeenCalled();
  });
});

describe("undo past its budget", () => {
  it("tells Activity once that the oldest strokes can no longer be undone", async () => {
    const w = await withVolume();
    // A budget of one stroke's chunk.
    Object.defineProperty(w.session, "history", { value: new History(64 ** 3) });
    const commit = (x: number) => {
      const s = new Stroke(w.session.volume);
      s.set(x, 0, 0, 1);
      (w.editor as unknown as { commit(s: Stroke, session: Session, value: number): void }).commit(s, w.session, 1);
    };
    commit(1);
    expect(w.log.info).not.toHaveBeenCalled();
    commit(2);
    commit(3);
    const told = w.log.info.mock.calls.map((c) => c[0]).filter((m) => m.includes("can no longer be undone"));
    expect(told).toEqual(["“Labels”: undo keeps the last 256 KB of strokes; the oldest can no longer be undone. Save to keep a copy."]);
    w.editor.dispose();
  });
});

describe("the model's worker", () => {
  it("is let go a while after Quick select is left, kept when it is taken again at once, and stopped when the plugin is", async () => {
    vi.useFakeTimers();
    const workers: { terminated: boolean }[] = [];
    vi.stubGlobal(
      "Worker",
      class {
        terminated = false;
        onmessage: unknown;
        onerror: unknown;
        constructor() {
          workers.push(this);
        }
        postMessage() {}
        terminate() {
          this.terminated = true;
        }
      },
    );
    const w = await withVolume();
    w.editor.setTool("quick");
    void w.editor.sam.load().catch(() => {});
    expect(w.editor.sam.started).toBe(true);
    // Left, and taken again within the wait: kept.
    w.editor.setTool("brush");
    await vi.advanceTimersByTimeAsync(SAM_RELEASE_WAIT / 2);
    w.editor.setTool("quick");
    await vi.advanceTimersByTimeAsync(SAM_RELEASE_WAIT);
    expect(workers[0].terminated).toBe(false);
    // Left for good (editing stopped): let go after the wait.
    w.editor.setEditing(false);
    await vi.advanceTimersByTimeAsync(SAM_RELEASE_WAIT + 10);
    expect(workers[0].terminated).toBe(true);
    expect(w.editor.sam.started).toBe(false);
    // Started again, then the plugin switched off: stopped at once.
    w.editor.setTool("quick");
    void w.editor.sam.load().catch(() => {});
    expect(workers).toHaveLength(2);
    w.editor.dispose();
    expect(workers[1].terminated).toBe(true);
  });
});
