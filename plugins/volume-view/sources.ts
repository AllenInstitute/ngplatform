/** Which image sources the volume view reads, kept apart from the readers so the main thread loads no decoders. */
export { precomputedUrl } from "@ngplatform/sdk/sources";

/** A store given to the reader as `precomputed:<url>` is a Neuroglancer precomputed image; others are OME-Zarr. */
export const PRECOMPUTED = "precomputed:";
