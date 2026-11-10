# Volume readers (shared)

Not a plugin. This folder was the Volume rendering tool, removed in favour
of [Anatomical rendering](../anatomical-rendering/); what other tools use
of it stays:

| File | What | Used by |
|---|---|---|
| `volume_reader.ts`, `volume_worker.ts`, `volume_client.ts` | Reads boxes of an OME-Zarr, precomputed (any integer or float type) or NIfTI image, at a level, in a worker; one read past 1 GB is refused with the coarser levels that fit | Annotations, Atlas, Segmentation, Registration, Time series, Orientations, Luxar, Anatomical rendering (in the browser) |
| `shared_chunks.ts`, `image_chunk_worker.ts`, `chunk_host.ts` | One cache of decoded chunks (384 MB) for every tool's reader: the page starts one image chunk worker and gives each tool's worker a port to it (`withSharedChunks`), so two tools reading one image read and hold it once | The tools above |
| `ome.ts` | OME-Zarr levels and their transforms; small matrix helpers | Orientations and the readers |
| `zarr2.ts` | Zarr v2 arrays (OME-Zarr 0.4) read as v3 | The readers, Orientations, Time series |
| `sources.ts` | Which store an image layer's source names | Annotations, Luxar, Registration, Segmentation, Orientations, offers |
| `solid.ts` | A coarse level's background (`borderMean`) and RAS to display coordinates (`displayOfRas`) | Luxar |
| `tools/` | Converting the MNI template to OME-Zarr | |
