/**
 * Files the Zarr Vectors plugin reads in place, as zarr-vectors stores made
 * from them as they are read (src/virtual/): tractograms, meshes, neuron
 * skeletons, graphs and point tables.  Local
 * data lists them and serves their keys from the worker.
 */
import type { VirtualFormat } from "../../sdk/types.js";
import { FREESURFER_SURFACE } from "./mesh_files.js";
import { surfaceRelated } from "./surfaces.js";

/** An edge list's name: edges.csv, graph_edges.csv, graph-edge.tsv … (its node table beside it: nodes.csv …). */
export const EDGE_LIST = /(^|[_\-. ])edges?\.(csv|tsv)$/i;

/** One worker serves every format here. */
let shared: Worker | undefined;
const worker = () => {
  if (shared === undefined) {
    shared = new Worker(new URL("./worker.ts", import.meta.url), { type: "module", name: "virtual zarr-vectors" });
    shared.postMessage({ type: "settings", settings: workerSettings() });
  }
  return shared;
};

/** The settings the worker is told (Settings › Storage). */
function workerSettings(): { cacheBytes?: number; diskBytes?: number } {
  const megabytes = vectorCacheMegabytes();
  const disk = tractogramDiskGigabytes();
  return { cacheBytes: megabytes > 0 ? megabytes * 2 ** 20 : undefined, diskBytes: disk === undefined ? undefined : disk * 2 ** 30 };
}

const DISK_KEY = "ngplatform.tractogramDiskGB";

/**
 * The most, GB, a tractogram on this computer may copy into the browser's
 * storage while it is open (undefined: the default, 4 GB; 0: nothing on
 * disk, a sample in memory).  Past it only a sample of the streamlines is
 * copied (`spillPlan`).  Kept in this browser.
 */
export function tractogramDiskGigabytes(): number | undefined {
  try {
    const raw = globalThis.localStorage?.getItem(DISK_KEY);
    const value = raw === null || raw === undefined ? NaN : Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Sets that limit (undefined: the default) and tells the worker. */
export function setTractogramDiskGigabytes(gigabytes: number | undefined): void {
  try {
    if (gigabytes !== undefined && gigabytes >= 0) globalThis.localStorage?.setItem(DISK_KEY, String(gigabytes));
    else globalThis.localStorage?.removeItem(DISK_KEY);
  } catch {
    // Storage refused: the setting holds for this visit.
  }
  shared?.postMessage({ type: "settings", settings: workerSettings() });
}

const CACHE_KEY = "ngplatform.vectorCacheMB";

/**
 * Memory, MB, for cells decoded from large tractograms on this computer
 * (0: chosen from the device's memory, 1/32 of it between 64 and 512 MB).
 * Kept in this browser.
 */
export function vectorCacheMegabytes(): number {
  try {
    const value = Number(globalThis.localStorage?.getItem(CACHE_KEY) ?? 0);
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

/** Sets that memory (0: the default) and tells the worker. */
export function setVectorCacheMegabytes(megabytes: number): void {
  try {
    if (megabytes > 0) globalThis.localStorage?.setItem(CACHE_KEY, String(Math.round(megabytes)));
    else globalThis.localStorage?.removeItem(CACHE_KEY);
  } catch {
    // Storage refused: the setting holds for this visit.
  }
  shared?.postMessage({ type: "settings", settings: workerSettings() });
}

export const ZARR_VECTORS_VIRTUAL: VirtualFormat[] = [
  {
    pattern: /\.trk$/i,
    extensions: [".trk"],
    format: "TrackVis tractogram",
    kind: "auto",
    source: (url) => `${url}/|zarr-vectors:`,
    worker,
  },
  {
    pattern: /\.trx$/i,
    extensions: [".trx"],
    format: "TRX tractogram",
    kind: "auto",
    source: (url) => `${url}/|zarr-vectors:`,
    worker,
  },
  {
    pattern: /\.(obj|stl|ply)$/i,
    extensions: [".obj", ".stl", ".ply"],
    format: "Mesh",
    kind: "auto",
    source: (url) => `${url}/|zarr-vectors:`,
    worker,
  },
  {
    // Surfaces only: shape, functional and label files are values on one (see `related`).
    pattern: /^(?!.*\.(shape|func|label|time)\.gii$).*\.gii$/i,
    extensions: [".gii"],
    format: "GIFTI surface",
    kind: "auto",
    source: (url) => `${url}/|zarr-vectors:`,
    worker,
    // Shape, functional and label files beside it, as values on its vertices.
    related: surfaceRelated,
  },
  {
    pattern: FREESURFER_SURFACE,
    extensions: [],
    format: "FreeSurfer surface",
    kind: "auto",
    source: (url) => `${url}/|zarr-vectors:`,
    worker,
    // Morphometry, overlays, annotations and labels beside it (and in ../label).
    related: surfaceRelated,
  },
  {
    pattern: /\.swc$/i,
    extensions: [".swc"],
    format: "SWC neuron skeletons",
    kind: "auto",
    source: (url) => `${url}/|zarr-vectors:`,
    worker,
    // A folder of neurons opens as one store, each neuron's file a property.
    collect: { extension: ".swc", label: "SWC files" },
  },
  {
    pattern: /\.graphml$/i,
    extensions: [".graphml"],
    format: "GraphML graph",
    kind: "auto",
    source: (url) => `${url}/|zarr-vectors:`,
    worker,
  },
  {
    // Before point tables: an edge list is a table too.
    pattern: EDGE_LIST,
    extensions: [],
    format: "Graph edge list",
    kind: "auto",
    source: (url) => `${url}/|zarr-vectors:`,
    worker,
    companion: (name) => ["nodes", "node", "vertices"].map((n) => name.replace(/edges?(\.(csv|tsv))$/i, `${n}$1`)),
  },
  {
    pattern: /\.(csv|tsv|xyz)$/i,
    extensions: [".csv", ".tsv", ".xyz"],
    format: "Point table",
    kind: "auto",
    source: (url) => `${url}/|zarr-vectors:`,
    worker,
  },
  {
    pattern: /\.parquet$/i,
    extensions: [".parquet"],
    format: "Parquet table of points",
    kind: "auto",
    source: (url) => `${url}/|zarr-vectors:`,
    worker,
  },
  {
    pattern: /\.(feather|arrow)$/i,
    extensions: [".feather", ".arrow"],
    format: "Feather (Arrow) table of points",
    kind: "auto",
    source: (url) => `${url}/|zarr-vectors:`,
    worker,
  },
  {
    pattern: /\.la[sz]$/i,
    extensions: [".las", ".laz"],
    format: "LAS point cloud",
    kind: "auto",
    source: (url) => `${url}/|zarr-vectors:`,
    worker,
  },
  {
    pattern: /\.tck$/i,
    extensions: [".tck"],
    format: "MRtrix tractogram",
    kind: "auto",
    source: (url) => `${url}/|zarr-vectors:`,
    worker,
  },
];
