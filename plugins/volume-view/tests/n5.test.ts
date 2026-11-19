import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { decodeN5Block, type N5Array } from "../n5.js";
import { n5Url, storeOf } from "../sources.js";

/** An N5 block as stored: the header (mode 0, 3 dimensions, their sizes, big-endian) and the payload. */
function block(dims: [number, number, number], payload: Uint8Array): Uint8Array {
  const head = new DataView(new ArrayBuffer(4 + 12));
  head.setUint16(0, 0);
  head.setUint16(2, 3);
  dims.forEach((d, i) => head.setUint32(4 + 4 * i, d));
  const out = new Uint8Array(head.byteLength + payload.length);
  out.set(new Uint8Array(head.buffer), 0);
  out.set(payload, head.byteLength);
  return out;
}

/** uint16 values, big-endian, x fastest. */
function bigEndian16(values: number[]): Uint8Array {
  const v = new DataView(new ArrayBuffer(2 * values.length));
  values.forEach((x, i) => v.setUint16(2 * i, x));
  return new Uint8Array(v.buffer);
}

describe("N5", () => {
  const array = (compression: N5Array["compression"]): N5Array => ({ dimensions: [5, 3, 2], blockSize: [4, 2, 2], dataType: "uint16", compression });

  it("decodes a full block: big-endian to the machine's order, x fastest", async () => {
    const values = Array.from({ length: 16 }, (_, i) => 1000 + i);
    const out = await decodeN5Block(block([4, 2, 2], bigEndian16(values)), array({ type: "raw" }), 2);
    expect(Array.from(new Uint16Array(out.buffer))).toEqual(values);
  });

  it("pads a block at the array's edge (stored at its own size) to the full block", async () => {
    // The last block along x of a 5-wide array in blocks of 4: one voxel wide, 2 × 2.
    const values = [7, 8, 9, 10];
    const out = new Uint16Array((await decodeN5Block(block([1, 2, 2], bigEndian16(values)), array({ type: "raw" }), 2)).buffer);
    expect(out.length).toBe(16);
    // x = 0 of each row (4 wide) holds the values, the rest 0.
    expect(Array.from(out)).toEqual([7, 0, 0, 0, 8, 0, 0, 0, 9, 0, 0, 0, 10, 0, 0, 0]);
  });

  it("decompresses gzip and blosc", async () => {
    const values = Array.from({ length: 16 }, (_, i) => i * 300);
    const gz = await decodeN5Block(block([4, 2, 2], gzipSync(bigEndian16(values))), array({ type: "gzip" }), 2);
    expect(Array.from(new Uint16Array(gz.buffer))).toEqual(values);
    const { default: Blosc } = await import("numcodecs/blosc");
    const packed = await Blosc.fromConfig({ id: "blosc", cname: "zstd", clevel: 5, shuffle: 1 } as never).encode(bigEndian16(values));
    const bl = await decodeN5Block(block([4, 2, 2], packed as Uint8Array), array({ type: "blosc", cname: "zstd" }), 2);
    expect(Array.from(new Uint16Array(bl.buffer))).toEqual(values);
  });

  it("names N5 sources as the reader takes them", () => {
    expect(n5Url("n5://gs://bucket/organ/6.5um/")).toBe("https://storage.googleapis.com/bucket/organ/6.5um/");
    expect(n5Url("https://host/a.n5")).toBe("https://host/a.n5/");
    expect(n5Url("zarr://gs://bucket/a.ome.zarr/")).toBeUndefined();
    expect(storeOf("n5://gs://bucket/organ/6.5um/")).toBe("n5:https://storage.googleapis.com/bucket/organ/6.5um/");
  });
});
