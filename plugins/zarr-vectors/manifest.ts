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
  description: "Opens Zarr Vectors stores in Neuroglancer, and tractograms, meshes, SWC neurons and point tables as if they were one.",
  guide: `Zarr Vectors stores vector geometry (point clouds, lines, streamlines, skeletons, graphs and meshes) as a multiscale Zarr store, with per-object and per-vertex attributes. This plugin teaches Neuroglancer to read format 0.9.0 to 0.9.4.

## Opening a store
Add it as a dataset with \`|zarr-vectors:\` after the store's URL:
\`\`\`
https://storage.googleapis.com/bucket/tracts.zarrvectors/|zarr-vectors:
\`\`\`
Stores ending in \`.zarrvectors\` are recognised without it. A store on this computer opens with Add → Local file or folder.

## Tractograms on this computer
A tractogram (TrackVis \`.trk\`, MRtrix \`.tck\` or \`.trx\`) opens in place (Open → Open from device), with nothing converted: the file is read once, in a worker, and served as a zarr-vectors store made from it, so it draws, selects and filters like any store. Points are in RAS+ millimetres, as nibabel reads them.

## Meshes on this computer
A mesh or surface (\`.obj\`, \`.stl\`, \`.ply\`, GIFTI \`.gii\`, FreeSurfer \`lh.pial\` and the like) opens in place too; anatomical GIFTI and FreeSurfer surfaces are moved into scanner RAS as zarr-vectors-tools does: each \`.obj\` object (\`o\`/\`g\`) or the whole file is one object, ids from 1, at the file's coordinates (millimetres, or nanometres when it spans more than 50,000).

## Neurons and points on this computer
An SWC file opens as skeletons, one object per tree, in micrometres, with each node's radius and type. A point table (\`.csv\`, \`.tsv\`, \`.xyz\`; x, y, z columns by name or the first three) opens as points, its other numeric columns as values; up to 250,000 points each point is an object, so it can be selected and filtered. Columns named \`x_um\`, \`x_mm\` or \`x_nm\` give the unit.

## What you see
- **Overview**: every object, drawn from the spatial chunks at the level of detail the view needs. With no segments selected, all objects show.
- **Selected objects**: click an object (or tick it in the Segments tab) to load it whole, at full resolution.
- **Attributes**: object attributes are segment properties: filter and sort them in the Segments tab, or colour by them in the Render tab's shader with \`prop_<name>()\` and \`obj_<name>\`.
- **Levels**: "Resolution (slice)" and "Resolution (mesh)" in the Render tab trade detail for speed.

## Writing stores
[zarr-vectors-py](https://github.com/AllenInstitute/zarr-vectors-py) writes stores from Python; [zarr-vectors-tools](https://github.com/AllenInstitute/zarr-vectors-tools) converts TRK, TRX, TCK, precomputed skeletons, meshes and point clouds (\`zvtools convert\`) and builds the levels (\`zvtools pyramid\`).`,
  links: [
    { title: "zarr-vectors-py (format and Python library)", url: "https://github.com/AllenInstitute/zarr-vectors-py" },
    { title: "zarr-vectors-tools (conversion and pyramids)", url: "https://github.com/AllenInstitute/zarr-vectors-tools" },
    { title: "This plugin's source", url: "https://github.com/Andrew-Keenlyside/ngplatform/tree/platform-gui/plugins/zarr-vectors" },
  ],
  license: "Apache-2.0",
};
