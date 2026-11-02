# Zarr Vectors

![Neurons from SWC files as a virtual Zarr Vectors store, in 2-D and 3-D](../images/plugins/zarr-vectors.png)

**Kind:** data type · **On by default** ·
[Source and developer README](https://github.com/AllenInstitute/ngplatform/tree/main/plugins/zarr-vectors)

[Zarr Vectors](https://github.com/AllenInstitute/zarr_vectors) is a chunked,
multiscale format for geometry: points, streamlines, polylines, skeletons,
graphs and meshes, with per-vertex and per-object attributes. This plugin
reads it into Neuroglancer as a segmentation layer, one segment per object,
so objects can be searched, shown, hidden and coloured like any segments.

## Using it

- Add a store by URL with the `|zarr-vectors:` suffix, for example
  `https://example.org/tracts.zarrvectors/|zarr-vectors:`.
- Open local files (`.trk`, `.tck`, `.trx`, `.obj`, `.stl`, `.ply`, GIFTI,
  FreeSurfer surfaces, `.swc`, `.csv`, `.tsv`, `.xyz`) with **Open from
  device**; they become virtual Zarr Vectors stores, made on the fly.
- Object properties (length, orientation, a neuron's cable length…) appear
  in the Layer → **Segments** tab, where they can be searched (`length>50`).
- Coarser levels load first and finer ones as you zoom in.

## Making stores

[zarr-vectors-tools](https://github.com/AllenInstitute/zarr-vectors-tools)
(`zvtools convert`) writes stores from tractograms, meshes, SWC, point
tables, LAS/LAZ point clouds, GraphML and more, with the levels and
attributes this plugin reads.

## Notes from users

*Add your tips, workflows and problems here (edit this page on GitHub).*
