/**
 * Makes a large mesh's levels (`mesh_levels.ts`) away from the worker that
 * serves stores, which hands it the parsed mesh and gets the levels back
 * (their buffers transferred, not copied).
 */
import type { MeshData } from "./mesh_files.js";
import { buildMeshLevels, meshLevelBuffers } from "./mesh_levels.js";

self.onmessage = (event: MessageEvent<{ mesh: MeshData }>) => {
  try {
    const levels = buildMeshLevels(event.data.mesh, {
      inPlace: true,
      progress: (level) => console.info(`mesh levels: ${level.faceCount} faces in ${level.cells.length} cells of ${level.chunk} (${Math.round(level.ms)} ms)`),
    });
    postMessage({ levels }, { transfer: meshLevelBuffers(levels) });
  } catch (e) {
    postMessage({ error: e instanceof Error ? e.message : String(e) });
  }
};
