/**
 * Per-object values put on vertices for shaders (`fillObjectValues`): read
 * from the store's object table; when they cannot be read, no value (NaN)
 * rather than 0, which looks like data; a network error fails the chunk
 * (read again later) and is not kept.
 */

import { describe, expect, it } from "vitest";
import { fillObjectValues } from "./chunk_pipeline.js";
import { readObjectTable } from "./objects.js";
import type { ZarrVectorsStoreAccess } from "./store.js";
import { fixtureRead } from "./test_fixtures.js";
import { ShardIndexCache } from "./zarr_array.js";

const read = fixtureRead("props_types");

function access(fail: (path: string) => boolean, error = () => Object.assign(new Error("Network or CORS error"), { status: 0 })): ZarrVectorsStoreAccess {
  return {
    read: async (path, options) => {
      if (fail(path)) throw error();
      return read(path, options);
    },
    listDirectories: async () => [],
    shardIndexes: new ShardIndexCache(),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const description: any = { attributes: [{ name: "obj_length", objectValue: { column: "length" } }], objectValuesPath: "0" };

/** Two vertices of the first object (segment ids as two uint32 each). */
async function vertices() {
  const table = (await readObjectTable(access(() => false), "0"))!;
  const id = table.segmentIds[0];
  return Uint32Array.from([Number(id & 0xffffffffn), Number(id >> 32n), Number(id & 0xffffffffn), Number(id >> 32n)]);
}

describe("object values on vertices", () => {
  it("are no value (NaN), not 0, when the object table cannot be read", async () => {
    const values = [new Float32Array(2)];
    const unreadable = access((p) => p.includes("object_index"), () => new Error("not JSON"));
    await fillObjectValues(unreadable, description, values, await vertices(), 2);
    expect(Array.from(values[0]).every(Number.isNaN)).toBe(true);
  });

  it("fail the chunk, rather than show no value, when the network fails", async () => {
    const values = [new Float32Array(2)];
    await expect(
      fillObjectValues(access((p) => p.includes("object_index")), description, values, await vertices(), 2),
    ).rejects.toMatchObject({ status: 0 });
  });

  it("are read again after a network error in a column", async () => {
    let failing = true;
    const flaky = access((p) => {
      if (failing && p.includes("object_attributes/length")) {
        failing = false;
        return true;
      }
      return false;
    });
    const first = [new Float32Array(2)];
    await expect(fillObjectValues(flaky, description, first, await vertices(), 2)).rejects.toMatchObject({ status: 0 });
    const again = [new Float32Array(2)];
    await fillObjectValues(flaky, description, again, await vertices(), 2);
    expect(Number.isFinite(again[0][0])).toBe(true);
    expect(again[0][1]).toBe(again[0][0]);
  });
});
