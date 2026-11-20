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
 * zstd decoding in the async-computation worker, in place of Neuroglancer's handler (the same request, so every
 * zstd reader in the page goes through it).
 *
 * Neuroglancer's uses numcodecs' WebAssembly build. Out of memory on a large array (a store's object attributes,
 * say), its module aborts: that decode and every one after it fail, and its exception glue hides why ("getArg is
 * not a function"). Here a failed decode is done again by fzstd (plain JavaScript, its memory the worker's heap),
 * and fzstd decodes every frame after it: the WebAssembly module, once aborted, cannot be used again.
 */
import { decodeZstd } from "neuroglancer/unstable/async_computation/decode_zstd_request.js";
import { registerAsyncComputation } from "neuroglancer/unstable/async_computation/handler.js";
import { decodeZstdBytes } from "./zstd_bytes.js";

/** Registers this handler for zstd (again, after Neuroglancer's own: the last registered answers). */
export function registerZstd(): void {
  registerAsyncComputation(decodeZstd, handle);
}

async function handle(data: Uint8Array) {
  const out = await decodeZstdBytes(data);
  // Its own buffer, whole (fzstd's may be a view), so it can be transferred.
  const result = out.byteOffset === 0 && out.byteLength === out.buffer.byteLength ? (out as Uint8Array<ArrayBuffer>) : new Uint8Array(out);
  return { value: result, transfer: [result.buffer as ArrayBuffer] };
}

registerZstd();
