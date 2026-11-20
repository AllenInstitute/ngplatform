import { zstdCompressSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { decodeZstdBytes, resetZstdDecoder } from "./zstd_bytes.js";

const data = new Uint8Array(200_000).map((_, i) => (i * 7) % 251);
const frame = new Uint8Array(zstdCompressSync(data));

describe("zstd decoding", () => {
  afterEach(() => resetZstdDecoder());

  it("uses the WebAssembly decoder while it works", async () => {
    let calls = 0;
    const out = await decodeZstdBytes(frame, async () => (++calls, data));
    expect(calls).toBe(1);
    expect(out).toBe(data);
  });

  it("decodes in JavaScript where the WebAssembly decoder fails, and from then on", async () => {
    let calls = 0;
    const broken = async () => {
      ++calls;
      throw new TypeError("A.getArg is not a function");
    };
    expect(Array.from(await decodeZstdBytes(frame, broken))).toEqual(Array.from(data));
    expect(Array.from(await decodeZstdBytes(frame, broken))).toEqual(Array.from(data));
    expect(calls).toBe(1);
  });

  it("says plainly when the data is not zstd", async () => {
    const broken = async () => {
      throw new Error("x");
    };
    await expect(decodeZstdBytes(new Uint8Array([1, 2, 3, 4, 5]), broken)).rejects.toThrow(/zstd: the data could not be decoded/);
  });
});
