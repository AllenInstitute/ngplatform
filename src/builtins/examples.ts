/**
 * Example workspaces offered in the Open dialog and the palette.  Every one
 * streams public data.
 */
import type { ExampleSpec } from "../platform/plugin_host.js";

const BUCKET = "https://storage.googleapis.com/hip_ct_zarr_vector_03987646472fethdsvdvdfg/zarr_vectors_test";

// S-21-46, a whole brain imaged by HiP-CT at 50 µm: BRIDGE's anatomically
// constrained tractogram, registered to MNI space (RAS mm): 3,308,503
// streamlines, about 420 M vertices, five levels.  https:// rather than
// gs://: the zarr-vectors reader finds no zarr.json through the GCS kvstore.
const S2146 = `${BUCKET}/BRIDGE_outputs/S-21-46_res-50um_space-MNI152_desc-bridgeanatomical.zarrvectors/`;

// The HCP-1065 population tractogram (MNI space, RAS mm): 503,085
// streamlines, 102 M vertices, five levels.
const HCP1065 = `${BUCKET}/hcp1065_whole_brain.zarrvectors/`;

const sphere = (id: string, center: [number, number, number], radius: number) => ({
  id,
  shape: "sphere",
  center,
  radius,
  size: [radius * 2, radius * 2, radius * 2],
  op: "and",
});

/** A store as Track filtering tells datasets apart (its sourceKey). */
const sourceKey = (url: string) => url.replace("https://storage.googleapis.com/", "gs://").replace(/\/$/, "");

/** Three track groups of a tractogram in MNI space, by regions, as a TrackVis user would draw them. */
const mniGroups = (store: string) => {
  const source = sourceKey(store);
  return {
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
          source,
        },
        {
          id: "cst-l",
          name: "Left corticospinal",
          colour: "#3fb6c9",
          // Posterior limb of the internal capsule, then the pons.
          rois: [sphere("cst-l-1", [-24, -15, 8], 6), sphere("cst-l-2", [-10, -27, -30], 6)],
          filter: { ranges: {}, includeTags: [], excludeTags: [] },
          source,
        },
        {
          id: "cst-r",
          name: "Right corticospinal",
          colour: "#d4a72c",
          rois: [sphere("cst-r-1", [24, -15, 8], 6), sphere("cst-r-2", [10, -27, -30], 6)],
          filter: { ranges: {}, includeTags: [], excludeTags: [] },
          source,
        },
      ],
    },
  };
};

// SRB 2026a, the Synchrotron Reference Brain: a HiP-CT template of ten
// brains at 100 µm in MNI 2009b space (OME-Zarr 0.6, five levels); outside
// the brain 0, shown black (transparent, its edge would show as an outline).
const SRB2026A =
  "zarr://https://storage.googleapis.com/hip_ct_zarr_vector_03987646472fethdsvdvdfg/zarr_vectors_test/cohort_MNI2009b_2026/cohort_template_N10_100um_MNI_simclip_masked.ome.zarr/";
const SRB_SHADER = `#uicontrol invlerp normalized(range=[0, 255])
void main() {
  emitGrayscale(normalized());
}
`;

const MICRONS = "precomputed://gs://iarpa_microns/minnie/minnie65";

/** A tractogram on the SRB 2026a template, with three track groups set up in Filtering. */
const onTemplate = (store: string, name: string) => () => ({
  ng: {
    dimensions: { x: [0.001, "m"], y: [0.001, "m"], z: [0.001, "m"] },
    position: [0, -15, 10],
    crossSectionScale: 0.6,
    projectionScale: 260,
    layers: [
      { type: "image", source: SRB2026A, name: "SRB 2026a", shader: SRB_SHADER },
      { type: "auto", source: store + "|zarr-vectors:", name, visible: false },
    ],
    selectedLayer: { layer: name },
    layout: "xy-3d",
  },
  app: { trackFiltering: mniGroups(store) },
});

export const EXAMPLES: ExampleSpec[] = [
  {
    id: "s2146-mni",
    title: "S-21-46 HiP-CT tractogram on the SRB 2026a template",
    description:
      "3.3 million streamlines (zarr-vectors) from a whole brain imaged at 50 µm by HiP-CT, anatomically constrained (BRIDGE) and registered to MNI space, on SRB 2026a, with three track groups set up in Filtering.",
    remote: true,
    state: onTemplate(S2146, "S-21-46"),
  },
  {
    id: "mni-hcp1065",
    title: "HCP-1065 tractogram on the SRB 2026a template",
    description: "503,085 streamlines (zarr-vectors) of the HCP-1065 population tractogram on SRB 2026a, with three track groups set up in Filtering.",
    remote: true,
    state: onTemplate(HCP1065, "HCP-1065"),
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
