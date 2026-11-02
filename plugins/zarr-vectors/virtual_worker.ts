/**
 * Serves files on this computer as virtual zarr-vectors stores (see
 * ./virtual.ts): a tractogram or mesh is read once, when its store is first
 * asked for, then every key is made from what was read.
 */
import { serveVirtualStores } from "@ngplatform/sdk/virtual";
import { parseMeshFile } from "./src/virtual/mesh_files.js";
import { MeshStore } from "./src/virtual/meshes.js";
import { openTractogram } from "./src/virtual/tractograms.js";

serveVirtualStores(async (file) => {
  if (/\.(obj|stl|ply)$/i.test(file.name)) return new MeshStore(parseMeshFile(new Uint8Array(await file.arrayBuffer()), file.name), file.name.replace(/\.[^.]+$/, ""));
  return openTractogram(file, file.name);
});
