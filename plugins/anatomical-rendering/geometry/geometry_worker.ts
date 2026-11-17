/** Builds surfaces (surfaces.ts) off the page: the BVH and the sorted normals, handed back. */
import { type BuildRequest, buildSurfaces } from "./surfaces.js";

self.onmessage = (e: MessageEvent<{ id: number; req: BuildRequest }>) => {
  const { id, req } = e.data;
  try {
    const s = buildSurfaces(req, req.objectCount, req.kinds);
    const b = s.bvh;
    const buffers = [b.prims.buffer, b.kinds.buffer, b.objects.buffer, b.nodes.buffer, b.kids.buffer, b.order.buffer, s.normals.buffer] as ArrayBuffer[];
    (self as unknown as Worker).postMessage({ id, surfaces: s }, [...new Set(buffers)]);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: (err as Error).message });
  }
};
