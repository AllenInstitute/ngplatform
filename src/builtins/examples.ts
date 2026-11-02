/**
 * Example workspaces offered in the Open dialog and the palette.  Every one
 * streams public data.
 */
import type { ExampleSpec } from "../platform/plugin_host.js";

// The HCP-1065 population tractogram (MNI space, RAS mm): 503,085
// streamlines, 102 M vertices, five levels.  https:// rather than gs://: the
// zarr-vectors reader finds no zarr.json through the GCS kvstore.
const HCP1065 =
  "https://storage.googleapis.com/hip_ct_zarr_vector_03987646472fethdsvdvdfg/zarr_vectors_test/hcp1065_whole_brain.zarrvectors/";

const sphere = (id: string, center: [number, number, number], radius: number) => ({
  id,
  shape: "sphere",
  center,
  radius,
  size: [radius * 2, radius * 2, radius * 2],
  op: "and",
});

/** Three track groups, by regions in MNI space, as a TrackVis user would draw them. */
const HCP_GROUPS = {
  version: 2,
  data: {
    editing: "cc",
    groups: [
      {
        id: "cc",
        name: "Corpus callosum",
        colour: "#e4572e",
        // A thin slab across the midline, over the body of the callosum.
        rois: [{ id: "cc-1", shape: "box", center: [0, -5, 21], radius: 5, size: [4, 70, 16], op: "and" }],
        filter: { ranges: {}, includeTags: [], excludeTags: [] },
      },
      {
        id: "cst-l",
        name: "Left corticospinal",
        colour: "#3fb6c9",
        // Posterior limb of the internal capsule, then the pons.
        rois: [sphere("cst-l-1", [-24, -15, 8], 6), sphere("cst-l-2", [-10, -27, -30], 6)],
        filter: { ranges: {}, includeTags: [], excludeTags: [] },
      },
      {
        id: "cst-r",
        name: "Right corticospinal",
        colour: "#d4a72c",
        rois: [sphere("cst-r-1", [24, -15, 8], 6), sphere("cst-r-2", [10, -27, -30], 6)],
        filter: { ranges: {}, includeTags: [], excludeTags: [] },
      },
    ],
  },
};

// The MNI152 2009a asymmetric T1w template (brain), as OME-Zarr in RAS mm,
// hosted beside the app (see plugins/volume-view/tools/).
const MNI2009A = "zarr://https://andrew-keenlyside.github.io/ngplatform/data/MNI152NLin2009aAsym_T1w_brain.ome.zarr/";

const MICRONS = "precomputed://gs://iarpa_microns/minnie/minnie65";

export const EXAMPLES: ExampleSpec[] = [
  {
    id: "mni-hcp1065",
    title: "HCP-1065 tractogram on the MNI template",
    description:
      "503,085 streamlines (zarr-vectors) on the MNI152 2009a T1w template, with three track groups set up in Filtering.",
    remote: true,
    state: () => ({
      ng: {
        dimensions: { x: [0.001, "m"], y: [0.001, "m"], z: [0.001, "m"] },
        position: [0, -15, 10],
        crossSectionScale: 0.6,
        projectionScale: 260,
        layers: [
          { type: "image", source: MNI2009A, name: "MNI152 2009a" },
          { type: "auto", source: HCP1065 + "|zarr-vectors:", name: "HCP-1065", visible: false },
        ],
        selectedLayer: { layer: "HCP-1065" },
        layout: "xy-3d",
      },
      app: { trackFiltering: HCP_GROUPS },
    }),
  },
  {
    id: "microns",
    title: "MICrONS cubic millimetre, mouse visual cortex",
    description:
      "Electron microscopy and the v1300 segmentation of minnie65, with a few cells in 3-D.",
    remote: true,
    state: () => ({
      ng: {
        dimensions: { x: [4e-9, "m"], y: [4e-9, "m"], z: [4e-8, "m"] },
        position: [240640, 207872, 21360],
        crossSectionScale: 12,
        projectionScale: 120000,
        layers: [
          { type: "image", source: `${MICRONS}/em`, name: "EM" },
          {
            type: "segmentation",
            source: `${MICRONS}/seg_m1300`,
            segments: ["864691135610744327", "864691135849440862", "864691135565846039", "864691135454281322"],
            name: "Cells (v1300)",
          },
        ],
        selectedLayer: { layer: "Cells (v1300)" },
        layout: "xy-3d",
      },
      app: {},
    }),
  },
];
