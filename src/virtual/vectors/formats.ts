/**
 * Files the Zarr Vectors plugin reads in place, as zarr-vectors stores made
 * from them as they are read (src/virtual/): tractograms, meshes, neuron
 * skeletons and point tables.  Local
 * data lists them and serves their keys from the worker.
 */
import type { VirtualFormat } from "../../sdk/types.js";
import { FREESURFER_SURFACE } from "./mesh_files.js";
import { surfaceRelated } from "./surfaces.js";

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
    pattern: /\.(csv|tsv|xyz)$/i,
    extensions: [".csv", ".tsv", ".xyz"],
    format: "Point table",
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
