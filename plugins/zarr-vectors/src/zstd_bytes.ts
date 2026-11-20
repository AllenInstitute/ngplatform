/**
 * @license
 * Copyright 2026 Google Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * zstd decoding (zstd_decode.ts registers it in the async-computation worker), in place of Neuroglancer's handler (the same request, so every
 * zstd reader in the page goes through it).
 *
 * Neuroglancer's uses numcodecs' WebAssembly build. Out of memory on a large array (a store's object attributes,
 * say), its module aborts: that decode and every one after it fail, and its exception glue hides why ("getArg is
 * not a function"). Here a failed decode is done again by fzstd (plain JavaScript, its memory the worker's heap),
 * and fzstd decodes every frame after it: the WebAssembly module, once aborted, cannot be used again.
 */
import { decompress } from "fzstd";

let wasmBroken = false;

/** A zstd stream's bytes decoded: numcodecs' WebAssembly first, fzstd where it fails (and from then on). */
export async function decodeZstdBytes(data: Uint8Array, wasm: (data: Uint8Array) => Promise<Uint8Array> = numcodecsDecode): Promise<Uint8Array> {
  if (!wasmBroken) {
    try {
      return await wasm(data);
    } catch {
      wasmBroken = true;
    }
  }
  try {
    return decompress(data);
  } catch (e) {
    throw new Error(`zstd: the data could not be decoded (${(e as Error).message || String(e)})`);
  }
}

/** For tests: the WebAssembly decoder tried again. */
export function resetZstdDecoder(): void {
  wasmBroken = false;
}

async function numcodecsDecode(data: Uint8Array): Promise<Uint8Array> {
  const { default: Zstd } = await import("numcodecs/zstd");
  const codec = Zstd.fromConfig({ id: "zstd" });
  return (await codec.decode(data)) as Uint8Array;
}
