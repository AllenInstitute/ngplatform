/**
 * Example workspaces offered in the Open dialog and the palette.
 *
 * The bundled excerpt ships inside the built app (public/examples/, made by
 * scripts/make_excerpt.py), so it opens wherever the app is hosted, including
 * hosts that cannot reach other sites.  The remote examples stream from
 * public buckets.
 */
import type { ExampleSpec } from "../platform/plugin_host.js";
import type { Json } from "../sdk/types.js";

// https:// rather than gs://: the fork's zarr-vectors reader finds no
// zarr.json through the GCS kvstore.  Over plain HTTPS one listing probe is
// refused cross-origin (a console error), and the reader carries on without it.
const HIP_CT =
  "https://storage.googleapis.com/hip_ct_zarr_vector_03987646472fethdsvdvdfg/zarr_vectors_test/" +
  "APEX_hackathon/sub-Ha1_sample-RightHemi_atlas-BGPathwaysMaffei2026_space-orig_track-ifod_tractogram.zarrvectors/";

function tractogramState(name: string, source: string): { ng: Json; app: Json } {
  return {
    ng: {
      layers: [{ type: "auto", source, name }],
      selectedLayer: { layer: name },
      layout: "xy-3d",
    },
    app: {},
  };
}

export const EXAMPLES: ExampleSpec[] = [
  {
    id: "hip-ct",
    title: "HiP-CT hemisphere, full tractogram",
    description: "sub-Ha1 right hemisphere, iFOD2: 79,648 streamlines, 39.4 M vertices, six pyramid levels, streamed from GCS.",
    remote: true,
    state: () => tractogramState("Ha1 right hemisphere", HIP_CT + "|zarr-vectors:"),
  },
  {
    id: "excerpt",
    title: "HiP-CT hemisphere, bundled excerpt",
    description:
      "1,947 of the 79,648 iFOD2 streamlines, drawn from all 44 bundles at full 0.1 mm resolution and shipped with the app. Opens anywhere it is built with the excerpt.",
    remote: false,
    state: () => tractogramState("Ha1 excerpt", new URL("examples/ha1-excerpt.zarrvectors/", location.href).href + "|zarr-vectors:"),
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
