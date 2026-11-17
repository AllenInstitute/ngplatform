/** Builds a block of surfaces (surfaces.ts) off the page: its BVH, collapsed, and its primitives in order, handed back. */
import { type BuildRequest, buildBlock } from "./surfaces.js";

self.onmessage = (e: MessageEvent<{ id: number; req: BuildRequest }>) => {
  const { id, req } = e.data;
  try {
    const b = buildBlock(req.primitives, req.objectCount);
    const buffers = [b.vertices.buffer, b.prims.buffer, b.nodes.buffer] as ArrayBuffer[];
    (self as unknown as Worker).postMessage({ id, block: b }, [...new Set(buffers)]);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: (err as Error).message });
  }
};
