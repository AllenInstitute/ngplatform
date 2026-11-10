/**
 * Per-object values put on vertices for shaders (`fillObjectValues`): read
 * from the store's object table; when they cannot be read, no value (NaN)
 * rather than 0, which looks like data; a network error fails the chunk
 * (read again later) and is not kept.
 */

import { describe, expect, it } from "vitest";
import { fillObjectValues } from "./chunk_pipeline.js";
import {
  readObjectTable,
  readSegmentProperties,
  readShaderObjectValueColumns,
  readShaderObjectValues,
  setShaderValueSource,
  shaderObjectValues,
} from "./objects.js";
import type { ZarrVectorsStoreAccess } from "./store.js";
import { fixtureRead } from "./test_fixtures.js";
import { ShardIndexCache } from "./zarr_array.js";

const read = fixtureRead("props_types");

function access(fail: (path: string) => boolean, error: () => Error = () => Object.assign(new Error("Network or CORS error"), { status: 0 })): ZarrVectorsStoreAccess {
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
const description: any = { attributes: [{ name: "obj_length", id: "obj_length", objectValue: { column: "length" } }], objectValuesPath: "0" };

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

describe("object values a shader reads", () => {
  it("are found by name or through prop_", () => {
    const description: any = {
      attributes: [
        { id: "obj_length", objectValue: { column: "length" } },
        { id: "obj_group", objectValue: { column: undefined } },
        { id: "obj_tortuosity", objectValue: { column: "tortuosity" } },
        { id: "fa" },
      ],
    };
    const used = (shader: string) => shaderObjectValues(description, shader);
    expect(used("void main() { emitRGB(vec3(obj_length)); }")).toEqual(["obj_length"]);
    expect(used("float t = prop_obj_tortuosity(); float g = obj_group;")).toEqual([
      "obj_group",
      "obj_tortuosity",
    ]);
    // Neither part of a longer name nor a vertex attribute.
    expect(used("float obj_lengths = fa; emitDefault();")).toEqual([]);
  });

  it("are the only ones read and put on vertices", async () => {
    const reads: string[] = [];
    const counted = access((p) => {
      reads.push(p);
      return false;
    });
    const values = [new Float32Array(2).fill(NaN)];
    await fillObjectValues(counted, description, values, await vertices(), 2, new Set());
    expect(reads).toEqual([]);
    expect(Array.from(values[0]).every(Number.isNaN)).toBe(true);
    await fillObjectValues(counted, description, values, await vertices(), 2, new Set(["obj_length"]));
    expect(reads.some((p) => p.includes("object_attributes/length"))).toBe(true);
    expect(Number.isFinite(values[0][0])).toBe(true);
  });
});

describe("object columns read for the Segments tab and for shaders", () => {
  it("are downloaded once on the thread that reads both", async () => {
    const reads: string[] = [];
    const counted: ZarrVectorsStoreAccess = {
      read: async (path, options) => {
        reads.push(path);
        return read(path, options);
      },
      listDirectories: async (path) => (path.endsWith("object_attributes") ? ["length"] : []),
      shardIndexes: new ShardIndexCache(),
    };
    const table = (await readObjectTable(counted, "0"))!;
    const properties = readSegmentProperties(counted, "0", table, []);
    const values = readShaderObjectValueColumns(counted, "0", [{ column: "length" }]);
    const [map, columns] = await Promise.all([properties, values]);
    expect(map?.properties.some((p) => p.id === "length")).toBe(true);
    expect(Number.isFinite(columns![0][0])).toBe(true);
    const chunkReads = reads.filter((p) => p.startsWith("0/object_attributes/length/c"));
    expect(chunkReads.length).toBeGreaterThan(0);
    expect(new Set(chunkReads).size).toBe(chunkReads.length);
  });

  it("reach a chunk worker from the main thread, not from the store again", async () => {
    const reads: string[] = [];
    const worker = access((p) => {
      reads.push(p);
      return false;
    });
    const sent = new Float32Array(10_000).fill(42);
    setShaderValueSource(async () => [sent]);
    try {
      const values = await readShaderObjectValues(worker, "0", [{ column: "length" }]);
      expect(values!.values[0]).toBe(sent);
      expect(reads.some((p) => p.includes("object_attributes/length"))).toBe(false);
    } finally {
      setShaderValueSource(undefined);
    }
  });
});
