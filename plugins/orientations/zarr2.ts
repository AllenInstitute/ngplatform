/**
 * Zarr v2 arrays (`.zarray`), as OME-Zarr 0.4 stores keep them (ome-zarr-py
 * and zarr-python 2 write these), read through the v3 reader: each array's
 * `.zarray` is answered as the `zarr.json` it would be in v3, with v2 chunk
 * keys ("0.1.2.3"), so the chunks themselves are read as they are.
 */
import type { ZarrArrayRead } from "neuroglancer-zarr-vectors/reader";

const TYPES: Record<string, string> = {
  b1: "bool",
  i1: "int8",
  u1: "uint8",
  i2: "int16",
  u2: "uint16",
  i4: "int32",
  u4: "uint32",
  i8: "int64",
  u8: "uint64",
  f4: "float32",
  f8: "float64",
};

/** A v2 array's metadata as v3's. */
export function v3FromV2(zarray: any): any {
  const match = /^([<>|])([biuf]\d)$/.exec(String(zarray?.dtype ?? ""));
  if (match === null || TYPES[match[2]] === undefined) throw new Error(`zarr v2 data type ${JSON.stringify(zarray?.dtype)} is not read`);
  const rank = zarray.shape.length;
  const bytes = Number(match[2].slice(1));
  const codecs: unknown[] = [];
  // Fortran order: the chunk's bytes run first index fastest.
  if (zarray.order === "F") codecs.push({ name: "transpose", configuration: { order: [...Array(rank).keys()].reverse() } });
  codecs.push(bytes === 1 ? { name: "bytes" } : { name: "bytes", configuration: { endian: match[1] === ">" ? "big" : "little" } });
  if (Array.isArray(zarray.filters) && zarray.filters.length > 0) throw new Error("zarr v2 filters are not read");
  const c = zarray.compressor;
  if (c !== null && c !== undefined) {
    switch (c.id) {
      case "blosc":
        codecs.push({
          name: "blosc",
          configuration: { cname: c.cname ?? "lz4", clevel: c.clevel ?? 5, shuffle: ["noshuffle", "shuffle", "bitshuffle"][c.shuffle] ?? "shuffle", typesize: bytes, blocksize: c.blocksize ?? 0 },
        });
        break;
      case "zlib":
        codecs.push({ name: "zlib", configuration: { level: c.level ?? 1 } });
        break;
      case "gzip":
        codecs.push({ name: "gzip", configuration: { level: c.level ?? 1 } });
        break;
      case "zstd":
        codecs.push({ name: "zstd", configuration: { level: c.level ?? 0, checksum: false } });
        break;
      default:
        throw new Error(`zarr v2 compressor ${JSON.stringify(c.id)} is not read`);
    }
  }
  return {
    zarr_format: 3,
    node_type: "array",
    shape: zarray.shape,
    data_type: TYPES[match[2]],
    chunk_grid: { name: "regular", configuration: { chunk_shape: zarray.chunks } },
    chunk_key_encoding: { name: "v2", configuration: { separator: zarray.dimension_separator ?? "." } },
    fill_value: zarray.fill_value ?? 0,
    codecs,
  };
}

/** A store read where an array without `zarr.json` but with `.zarray` reads as v3. */
export function withZarr2(read: ZarrArrayRead): ZarrArrayRead {
  return async (key, options) => {
    const bytes = await read(key, options);
    if (bytes !== undefined || !key.endsWith("zarr.json")) return bytes;
    const v2 = await read(`${key.slice(0, -"zarr.json".length)}.zarray`, { signal: options.signal });
    if (v2 === undefined) return undefined;
    return new TextEncoder().encode(JSON.stringify(v3FromV2(JSON.parse(new TextDecoder().decode(v2)))));
  };
}
