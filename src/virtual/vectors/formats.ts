/**
 * Files the Zarr Vectors plugin reads in place, as zarr-vectors stores made
 * from them as they are read (src/virtual/): tractograms, meshes, neuron
 * skeletons, graphs and point tables.  Local
 * data lists them and serves their keys from the worker.
 */
import type { VirtualFormat } from "../../sdk/types.js";
import { FREESURFER_SURFACE } from "./mesh_files.js";

/** An edge list's name: edges.csv, graph_edges.csv, graph-edge.tsv … (its node table beside it: nodes.csv …). */
export const EDGE_LIST = /(^|[_\-. ])edges?\.(csv|tsv)$/i;

/** One worker serves every format here. */
let shared: Worker | undefined;
const worker = () => (shared ??= new Worker(new URL("./worker.ts", import.meta.url), { type: "module", name: "virtual zarr-vectors" }));

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
    pattern: /\.gii$/i,
    extensions: [".gii"],
    format: "GIFTI surface",
    kind: "auto",
    source: (url) => `${url}/|zarr-vectors:`,
    worker,
  },
  {
    pattern: FREESURFER_SURFACE,
    extensions: [],
    format: "FreeSurfer surface",
    kind: "auto",
    source: (url) => `${url}/|zarr-vectors:`,
    worker,
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
    pattern: /\.las$/i,
    extensions: [".las"],
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
