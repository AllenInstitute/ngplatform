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

export const EXAMPLES: ExampleSpec[] = [
  {
    id: "hcp1065",
    title: "HCP-1065 whole brain, with track groups, in BigBrain",
    description:
      "The HCP-1065 population tractogram in MNI space: 503,085 streamlines, five levels. Three track groups (corpus callosum, left and right corticospinal tracts) are set up in the Filtering tab; the unfiltered view starts hidden. The volume view shows them in BigBrain (placed in MNI), cut open at the position.",
    remote: true,
    state: () => ({
      ng: {
        layers: [{ type: "auto", source: HCP1065 + "|zarr-vectors:", name: "HCP-1065", visible: false }],
        selectedLayer: { layer: "HCP-1065" },
        position: [0, -15, 10],
        layout: "xy",
      },
      app: {
        trackFiltering: HCP_GROUPS,
        // BigBrain in MNI in place of the 3-D panel (the volume view plugin).
        volumeView: { version: 1, data: { on: true, preset: "bigbrain-mni", layout: "xy-3d" } },
      },
    }),
  },
  {
    id: "fib25",
    title: "FIB-25 EM volume and segmentation",
    description: "Neuroglancer's classic Drosophila example: precomputed image plus ground-truth segmentation, to show any Neuroglancer data opens.",
    remote: true,
    state: () => ({
      ng: {
        dimensions: { x: [8e-9, "m"], y: [8e-9, "m"], z: [8e-9, "m"] },
        position: [2914.5, 3088.5, 4045.5],
        crossSectionScale: 3.5,
        projectionScale: 1024,
        layers: [
          { type: "image", source: "precomputed://gs://neuroglancer-public-data/flyem_fib-25/image", name: "image" },
          {
            type: "segmentation",
            source: "precomputed://gs://neuroglancer-public-data/flyem_fib-25/ground_truth",
            segments: ["158571", "21894", "22060", "24436", "2515"],
            name: "ground truth",
          },
        ],
        selectedLayer: { layer: "ground truth" },
        layout: "xy-3d",
      },
      app: {},
    }),
  },
];
