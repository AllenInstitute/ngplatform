/**
 * Serves files on this computer as virtual zarr-vectors stores (see
 * ./virtual.ts): a tractogram, mesh, SWC file or point table is read once, when its store is first
 * asked for, then every key is made from what was read.
 */
import { serveVirtualStores } from "@ngplatform/sdk/virtual";
import { FREESURFER_SURFACE, parseMeshFile } from "./src/virtual/mesh_files.js";
import { MeshStore } from "./src/virtual/meshes.js";
import { parsePointTable, parseSwc } from "./src/virtual/point_files.js";
import { pointStore, skeletonStore } from "./src/virtual/points.js";
import { openTractogram } from "./src/virtual/tractograms.js";

serveVirtualStores(async (file) => {
  if (/\.(obj|stl|ply|gii)$/i.test(file.name) || FREESURFER_SURFACE.test(file.name)) {
    return new MeshStore(await parseMeshFile(new Uint8Array(await file.arrayBuffer()), file.name), file.name.replace(/\.(surf\.gii|gii|obj|stl|ply)$/i, ""));
  }
  if (/\.swc$/i.test(file.name)) return skeletonStore(parseSwc(await file.text()), file.name.replace(/\.swc$/i, ""));
  if (/\.(csv|tsv|xyz)$/i.test(file.name)) return pointStore(parsePointTable(await file.text()), file.name.replace(/\.(csv|tsv|xyz)$/i, ""));
  return openTractogram(file, file.name);
});
