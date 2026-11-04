import { describe, expect, it } from "vitest";
import { StateHistory } from "../src/core/history.js";
import { HistoryKeep, linkDigest, MemoryHistoryBackend } from "../src/platform/history_keep.js";

const tree = (...states: string[]) => {
  const h = new StateHistory();
  for (const s of states) h.record(s, s);
  return h.export();
};

describe("keeping the history in the browser", () => {
  it("finds the tree saved last for a link, and only for that link", async () => {
    const backend = new MemoryHistoryBackend();
    const page = new HistoryKeep(backend);
    await page.save("#!{a}", tree('"a"'), 1);
    await page.save("#!{b}", tree('"a"', '"b"'), 2);
    // The page's one record follows the link it ends at.
    expect(backend.records.size).toBe(1);
    const reloaded = new HistoryKeep(backend);
    expect(await reloaded.find("#!{a}")).toBeUndefined();
    const found = await reloaded.find("#!{b}");
    expect(StateHistory.import(found!)!.rows().map((r) => r.label)).toEqual(['"a"', '"b"']);
    // Saving replaces the record it resumed from.
    await reloaded.save("#!{b}", found!, 3);
    expect([...backend.records.keys()]).toEqual([reloaded.id]);
  });

  it("matches a link however the address bar escapes it", () => {
    expect(linkDigest('#!{"a":1}')).toBe(linkDigest("#!%7B%22a%22:1%7D"));
    expect(linkDigest('#!{"a":1}')).not.toBe(linkDigest('#!{"a":2}'));
  });

  it("keeps the trees of the latest workspaces only", async () => {
    const backend = new MemoryHistoryBackend();
    for (let i = 0; i < 5; i++) await new HistoryKeep(backend, 3).save(`#!${i}`, tree(`${i}`), i);
    expect([...backend.records.values()].map((r) => r.saved).sort()).toEqual([2, 3, 4]);
  });
});
