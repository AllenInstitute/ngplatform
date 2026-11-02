/**
 * Serves files on this computer as virtual zarr-vectors stores (see
 * ./virtual.ts): a tractogram, mesh, SWC file or point table is read once, when its store is first
 * asked for, then every key is made from what was read.
 */
import { serveVirtualStores } from "../../sdk/virtual.js";
import { FREESURFER_SURFACE, parseMeshFile } from "./mesh_files.js";
import { MeshStore } from "./meshes.js";
import { parseLas, parsePointTable, parseSwc, parseSwcCollection } from "./point_files.js";
import { pointStore, skeletonStore } from "./points.js";
import { openTractogram } from "./tractograms.js";

serveVirtualStores(async (file) => {
  if (/\.(obj|stl|ply|gii)$/i.test(file.name) || FREESURFER_SURFACE.test(file.name)) {
    return new MeshStore(await parseMeshFile(new Uint8Array(await file.arrayBuffer()), file.name), file.name.replace(/\.(surf\.gii|gii|obj|stl|ply)$/i, ""));
  }
  if (/^@all\.swc$/i.test(file.name)) {
    // A folder's SWC files, which local data hands over as one text.
    const { nodes, files, fileOf, skipped } = parseSwcCollection(await file.text());
    if (skipped.length > 0) console.warn(`SWC files left out (they did not parse): ${skipped.join(", ")}`);
    return skeletonStore(nodes, "neurons", { names: files, fileOf });
  }
  if (/\.swc$/i.test(file.name)) return skeletonStore(parseSwc(await file.text()), file.name.replace(/\.swc$/i, ""));
  if (/\.las$/i.test(file.name)) return pointStore(parseLas(new Uint8Array(await file.arrayBuffer())), file.name.replace(/\.las$/i, ""));
  if (/\.(csv|tsv|xyz)$/i.test(file.name)) return pointStore(parsePointTable(await file.text()), file.name.replace(/\.(csv|tsv|xyz)$/i, ""));
  return openTractogram(file, file.name);
});
