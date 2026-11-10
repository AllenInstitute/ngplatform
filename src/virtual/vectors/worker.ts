/**
 * Serves files on this computer as virtual zarr-vectors stores (see
 * ./virtual.ts): a tractogram, mesh, SWC file, graph or point table is read once, when its store is first
 * asked for, then every key is made from what was read.
 */
import { serveVirtualStores } from "../../sdk/virtual.js";
import { featherPoints } from "./feather.js";
import { EDGE_LIST } from "./formats.js";
import { lazToLas } from "./laz.js";
import { lazPerf } from "./laz_module.js";
import { FREESURFER_SURFACE, parseMeshFile } from "./mesh_files.js";
import { openMeshStore } from "./mesh_cells.js";
import { graphStore, parseEdgeList, parseGraphml, splitEdgeList } from "./graphs.js";
import { parseLas, parsePointParquet, parsePointTable, parseSwc, parseSwcCollection } from "./point_files.js";
import { surfaceCompanions } from "./surfaces.js";
import { pointStore, skeletonStore } from "./points.js";
import { openTractogram } from "./tractograms.js";
import { setSpillSettings, type SpillSettings } from "./spill.js";

// The page's limits (Settings › Storage): memory for decoded cells, storage for a tractogram's spill.
self.addEventListener("message", (event: MessageEvent<{ type?: string; settings?: SpillSettings }>) => {
  if (event.data?.type === "settings" && event.data.settings !== undefined) setSpillSettings(event.data.settings);
});

serveVirtualStores(async (file, related, progress) => {
  if (/\.(obj|stl|ply|gii)$/i.test(file.name) || FREESURFER_SURFACE.test(file.name)) {
    const mesh = await parseMeshFile(new Uint8Array(await file.arrayBuffer()), file.name);
    // A surface's values on its vertices, from the files beside it.
    const companions = await surfaceCompanions(file.name, related, mesh.positions.length / 3);
    if (companions.skipped.length > 0) console.info(`${file.name}: files beside it left out: ${companions.skipped.join("; ")}`);
    // Past a million triangles (and not a surface with values beside it), in cells with coarser levels.
    return openMeshStore(mesh, file.name.replace(/\.(surf\.gii|gii|obj|stl|ply)$/i, ""), companions);
  }
  if (/^@all\.swc$/i.test(file.name)) {
    // A folder's SWC files, which local data hands over as one text.
    const { nodes, files, fileOf, skipped } = parseSwcCollection(await file.text());
    if (skipped.length > 0) console.warn(`SWC files left out (they did not parse): ${skipped.join(", ")}`);
    return skeletonStore(nodes, "neurons", { names: files, fileOf });
  }
  if (/\.swc$/i.test(file.name)) return skeletonStore(parseSwc(await file.text()), file.name.replace(/\.swc$/i, ""));
  if (/\.graphml$/i.test(file.name)) return graphStore(parseGraphml(await file.text()), file.name.replace(/\.graphml$/i, ""));
  if (EDGE_LIST.test(file.name)) {
    const { edges, nodes } = splitEdgeList(await file.text());
    return graphStore(parseEdgeList(edges, nodes), file.name.replace(/[_\-. ]?edges?\.(csv|tsv)$/i, "") || "graph");
  }
  if (/\.parquet$/i.test(file.name)) return pointStore(await parsePointParquet(file), file.name.replace(/\.parquet$/i, ""));
  if (/\.(feather|arrow)$/i.test(file.name)) return pointStore(featherPoints(new Uint8Array(await file.arrayBuffer())), file.name.replace(/\.(feather|arrow)$/i, ""));
  if (/\.las$/i.test(file.name)) return pointStore(parseLas(new Uint8Array(await file.arrayBuffer())), file.name.replace(/\.las$/i, ""));
  if (/\.laz$/i.test(file.name)) return pointStore(parseLas(lazToLas(new Uint8Array(await file.arrayBuffer()), await lazPerf())), file.name.replace(/\.laz$/i, ""));
  if (/\.(csv|tsv|xyz)$/i.test(file.name)) return pointStore(parsePointTable(await file.text()), file.name.replace(/\.(csv|tsv|xyz)$/i, ""));
  return openTractogram(file, file.name, progress);
});
