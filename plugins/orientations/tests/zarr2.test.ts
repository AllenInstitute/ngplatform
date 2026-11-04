/** Zarr v2 arrays read as v3 (../zarr2.ts). */
import { describe, expect, it } from "vitest";
import { v3FromV2, withZarr2 } from "../zarr2.js";

describe("zarr v2 metadata as v3", () => {
  it("maps types, order, endianness, compressors and key encoding", () => {
    const v3 = v3FromV2({ shape: [4, 5, 6], chunks: [2, 5, 6], dtype: ">f4", order: "F", compressor: { id: "blosc", cname: "zstd", clevel: 3, shuffle: 2 }, fill_value: null, dimension_separator: "/" });
    expect(v3).toEqual({
      zarr_format: 3,
      node_type: "array",
      shape: [4, 5, 6],
      data_type: "float32",
      chunk_grid: { name: "regular", configuration: { chunk_shape: [2, 5, 6] } },
      chunk_key_encoding: { name: "v2", configuration: { separator: "/" } },
      fill_value: 0,
      codecs: [
        { name: "transpose", configuration: { order: [2, 1, 0] } },
        { name: "bytes", configuration: { endian: "big" } },
        { name: "blosc", configuration: { cname: "zstd", clevel: 3, shuffle: "bitshuffle", typesize: 4, blocksize: 0 } },
      ],
    });
    const plain = v3FromV2({ shape: [3], chunks: [3], dtype: "|u1", order: "C", compressor: null });
    expect(plain.codecs).toEqual([{ name: "bytes" }]);
    expect(plain.chunk_key_encoding.configuration.separator).toBe(".");
    expect(v3FromV2({ shape: [3], chunks: [3], dtype: "<i2", compressor: { id: "gzip", level: 6 } }).codecs).toEqual([
      { name: "bytes", configuration: { endian: "little" } },
      { name: "gzip", configuration: { level: 6 } },
    ]);
  });

  it("refuses what it cannot read", () => {
    expect(() => v3FromV2({ shape: [1], chunks: [1], dtype: "<c8" })).toThrow("data type");
    expect(() => v3FromV2({ shape: [1], chunks: [1], dtype: "<f4", filters: [{ id: "delta" }] })).toThrow("filters");
    expect(() => v3FromV2({ shape: [1], chunks: [1], dtype: "<f4", compressor: { id: "lzma" } })).toThrow("lzma");
  });

  it("answers an array's zarr.json from its .zarray, and leaves other keys alone", async () => {
    const files = new Map<string, Uint8Array>([
      ["a/.zarray", new TextEncoder().encode(JSON.stringify({ shape: [2], chunks: [2], dtype: "<u2", compressor: null }))],
      ["a/0", Uint8Array.from([1, 0, 2, 0])],
      ["b/zarr.json", new TextEncoder().encode('{"zarr_format":3}')],
    ]);
    const read = withZarr2(async (key) => files.get(key));
    const json = (bytes: Uint8Array | undefined) => JSON.parse(new TextDecoder().decode(bytes));
    expect(json(await read("a/zarr.json", {})).data_type).toBe("uint16");
    expect(json(await read("b/zarr.json", {}))).toEqual({ zarr_format: 3 });
    expect(await read("c/zarr.json", {})).toBeUndefined();
    expect([...(await read("a/0", {}))!]).toEqual([1, 0, 2, 0]);
  });
});
