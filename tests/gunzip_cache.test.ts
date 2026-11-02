/** .nii.gz files kept decompressed between visits: made once, read back, the oldest dropped. */
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { type CacheDirectory, cachedFile, gunzipSource } from "../src/virtual/images/store.js";

/** An in-memory stand-in for an OPFS directory. */
function fakeDirectory() {
  const files = new Map<string, { data: Uint8Array; lastModified: number }>();
  let clock = 1;
  const dir: CacheDirectory = {
    async getFileHandle(name, options) {
      if (!files.has(name)) {
        if (!options?.create) throw new DOMException("missing", "NotFoundError");
        files.set(name, { data: new Uint8Array(0), lastModified: clock++ });
      }
      return {
        async getFile() {
          const f = files.get(name)!;
          return new File([f.data as BlobPart], name, { lastModified: f.lastModified });
        },
        async createWritable() {
          const parts: Uint8Array[] = [];
          return new WritableStream<Uint8Array>({
            write: (chunk) => void parts.push(chunk),
            close: () => {
              const data = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
              parts.reduce((at, p) => (data.set(p, at), at + p.length), 0);
              files.set(name, { data, lastModified: clock++ });
            },
          }) as WritableStream<Uint8Array> & { close(): Promise<void> };
        },
      };
    },
    async removeEntry(name) {
      files.delete(name);
    },
    async *keys() {
      yield* [...files.keys()];
    },
  };
  return { dir, files };
}

const gz = (text: string) => new Blob([gzipSync(Buffer.from(text))]);

describe("decompressed .gz files kept between visits", () => {
  it("decompresses once, then reads the kept copy", async () => {
    const { dir } = fakeDirectory();
    let runs = 0;
    const decompress = () => {
      runs++;
      return gz("hello, brain").stream().pipeThrough(new DecompressionStream("gzip"));
    };
    expect(await (await cachedFile(dir, "t1.nii.gz|20|5", decompress)).text()).toBe("hello, brain");
    expect(await (await cachedFile(dir, "t1.nii.gz|20|5", decompress)).text()).toBe("hello, brain");
    expect(runs).toBe(1);
  });

  it("keeps the six most recently used", async () => {
    const { dir, files } = fakeDirectory();
    for (let i = 0; i < 8; ++i) await cachedFile(dir, `f${i}`, () => gz(`file ${i}`).stream().pipeThrough(new DecompressionStream("gzip")));
    expect([...files.keys()].filter((k) => k.endsWith(".done")).length).toBe(6);
    expect(files.size).toBe(12);
  });

  it("reads through the cache from a source, and without one", async () => {
    const { dir } = fakeDirectory();
    const kept = await gunzipSource(gz("0123456789"), "k", Promise.resolve(dir))();
    expect(new TextDecoder().decode(await kept.read(2, 5))).toBe("234");
    const plain = await gunzipSource(gz("0123456789"))();
    expect(new TextDecoder().decode(await plain.read(7, 10))).toBe("789");
  });
});
