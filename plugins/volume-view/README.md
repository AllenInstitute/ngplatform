# Volume readers (shared)

Not a plugin. This folder was the Volume rendering tool, removed in favour
of [Anatomical rendering](../anatomical-rendering/); what other tools use
of it stays:

| File | What | Used by |
|---|---|---|
| `volume_reader.ts`, `volume_worker.ts`, `volume_client.ts` | Reads boxes of an OME-Zarr, precomputed or NIfTI image, at a level, in a worker | Annotations, Atlas, Segmentation, Registration, Time series, Orientations, Luxar, Anatomical rendering (in the browser) |
| `ome.ts` | OME-Zarr levels and their transforms; small matrix helpers | Orientations and the readers |
| `sources.ts` | Which store an image layer's source names | Annotations, Luxar, Registration, Segmentation, Orientations, offers |
| `solid.ts`, `bricks.ts` | Bricked volume upload and tissue window helpers | Luxar |
| `tools/` | Converting the MNI template to OME-Zarr | |
