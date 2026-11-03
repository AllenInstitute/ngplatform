/**
 * LAZ (compressed LAS) to LAS, with laz-perf (LASzip compiled to
 * WebAssembly, Apache-2.0): the header and records before the points kept,
 * the points decompressed after them, and the compression bit cleared, so
 * the LAS reader reads the result.  The decoder is passed in (its build
 * differs between a browser worker and Node).
 */

/** The laz-perf module, as `createLazPerf()` resolves it. */
export interface LazPerfModule {
  HEAPU8: Uint8Array;
  _malloc(size: number): number;
  _free(pointer: number): void;
  LASZip: new () => {
    open(data: number, length: number): void;
    getPoint(dest: number): void;
    getCount(): number;
    getPointLength(): number;
    delete(): void;
  };
}

export function lazToLas(bytes: Uint8Array, module: LazPerfModule): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (String.fromCharCode(...bytes.subarray(0, 4)) !== "LASF") throw new Error("not a LAZ file (no LASF mark)");
  const offset = view.getUint32(96, true);
  const file = module._malloc(bytes.length);
  module.HEAPU8.set(bytes, file);
  const zip = new module.LASZip();
  let point = 0;
  try {
    zip.open(file, bytes.length);
    const count = zip.getCount();
    const length = zip.getPointLength();
    const out = new Uint8Array(offset + count * length);
    out.set(bytes.subarray(0, offset));
    point = module._malloc(length);
    for (let i = 0, at = offset; i < count; ++i, at += length) {
      zip.getPoint(point);
      // HEAPU8 is looked up each time: the heap's buffer can be replaced as it grows.
      out.set(module.HEAPU8.subarray(point, point + length), at);
    }
    // Point format byte: the top two bits mark compression.
    out[104] &= 0x3f;
    return out;
  } finally {
    zip.delete();
    if (point !== 0) module._free(point);
    module._free(file);
  }
}
