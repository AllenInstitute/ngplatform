/**
 * The zarr-vectors plugin's manifest: what the platform shows and switches.
 * Its code is the neuroglancer-zarr-vectors package in this folder (src/),
 * which registers the data source with Neuroglancer; ../index.ts loads it and
 * ../workers.ts its worker halves.
 */
import type { Manifest } from "@ngplatform/sdk";

export const ZARR_VECTORS_MANIFEST: Manifest = {
  id: "org.ngplatform.zarr-vectors",
  name: "Zarr Vectors",
  version: "0.3.0",
  kind: "datatype",
  enabledByDefault: true,
  description:
    "Reads Zarr Vectors stores (format 0.9.0 to 0.9.4) into Neuroglancer: point clouds, lines, streamlines, skeletons, graphs and meshes, with multiscale levels and object attributes as segment properties. Sources look like https://…/store.zarrvectors/|zarr-vectors:",
  license: "Apache-2.0",
};
