/** vzip archives (refkv), against refkv 0.2.0's own reader: every key resolves to the same bytes. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Vzip } from "../src/virtual/refkv/vzip.js";

const DIR = new URL("./testdata/vzip/", import.meta.url);
const expected: Record<string, Record<string, string>> = JSON.parse(readFileSync(new URL("expected.json", DIR), "utf8"));

/** Sources by file name: the archives name the TIFFs by where they were made. */
const resolve = async (url: string, offset: number, length: number) => {
  const name = url.split("/").pop()!;
  return new Uint8Array(readFileSync(new URL(name, DIR))).subarray(offset, offset + length);
};

describe("vzip", () => {
  for (const name of ["tiles", "strips"]) {
    it(`resolves every key of ${name}.vzip as refkv does`, async () => {
      const zip = await Vzip.open(new Blob([readFileSync(new URL(`${name}.vzip`, DIR))]), resolve);
      expect(zip.keys().sort()).toEqual(Object.keys(expected[name]).sort());
      for (const [key, sha] of Object.entries(expected[name])) {
        const bytes = await zip.get(key);
        expect(createHash("sha256").update(bytes!).digest("hex"), key).toBe(sha);
      }
      expect(await zip.get("no/such/key")).toBeUndefined();
      expect(await zip.get("__vz__/sources")).toBeUndefined();
    });
  }

  it("says what it cannot read", async () => {
    await expect(Vzip.open(new Blob([new Uint8Array(100)]), resolve)).rejects.toThrow(/not a vzip/);
  });
});
