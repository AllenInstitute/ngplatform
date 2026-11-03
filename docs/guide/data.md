# Loading and exporting data

## Data from a URL

**Add → URL** (or **Open → a link**) takes anything Neuroglancer reads, with
its usual prefixes, plus Zarr Vectors stores:

| Data | Example source |
|---|---|
| OME-Zarr (0.4 to 0.6), Zarr v2 and v3, N5 | `zarr://https://example.org/brain.ome.zarr/` |
| Neuroglancer precomputed: images, segmentations, meshes, skeletons, annotations | `precomputed://gs://bucket/dataset` |
| NIfTI on a web server | `nifti://https://example.org/t1.nii.gz` |
| Zarr Vectors: streamlines, meshes, skeletons, points, graphs | `https://example.org/tracts.zarrvectors/|zarr-vectors:` |
| Others Neuroglancer supports (graphene, DVID, BOSS, render, deep zoom) | as in Neuroglancer |

`gs://` and `s3://` buckets are read directly. Private Google Cloud buckets
ask for a sign-in, kept in the **Auth** tab.

## Data on your computer

**Open → Open from device**, **Add → Local**, or dropping files or folders
anywhere on the window, takes files or a whole folder. Nothing is uploaded: the files are read in place, in your browser,
only where the views need them. Each one is presented to Neuroglancer as a
chunked store made from it on the fly, a *virtual store*, so a large file
is never loaded whole and coarser levels appear first.

| You open | It is shown as | Notes |
|---|---|---|
| NIfTI (`.nii`, `.nii.gz`), Analyze (`.hdr` + `.img`), FreeSurfer (`.mgz`, `.mgh`) | a virtual OME-Zarr image, with a pyramid | Placed by the sform (else qform). A `.nii.gz` is decompressed once and kept in the browser's private storage for later visits. Colour (RGB) NIfTI shows in colour. |
| TIFF stacks (`.tif`, `.tiff`), OME-TIFF, ImageJ hyperstacks | a virtual OME-Zarr image, with a pyramid | Classic and BigTIFF; channels and time points from OME and ImageJ metadata. |
| NumPy arrays (`.npy`, 2-D to 4-D) | a virtual OME-Zarr image, with a pyramid | Indexed [z, y, x] as Python imaging code does (the last axis is x); 1-unit voxels. |
| A FreeSurfer subject folder (with `mri/` and `surf/`) | its T1, aparc+aseg and white and pial surfaces | Surfaces in Freeview's colours, drawn as outlines on the slices. |
| Tractograms (`.trk`, `.tck`, `.trx`) | a virtual Zarr Vectors streamline store | Split into spatial cells, with a coarse level for large files; track groups work on them. |
| Meshes (`.obj`, `.stl`, `.ply`), GIFTI and FreeSurfer surfaces (`lh.pial` …) | a virtual Zarr Vectors mesh store | Surfaces are placed in scanner RAS. |
| Neurons (`.swc`, or a folder of them) | a virtual Zarr Vectors skeleton store | One object per tree, with cable length and branch points. |
| Graphs: GraphML (`.graphml`), or an edge list (`…edges.csv`, rows of `source, target`) dropped with its node table beside it (`…nodes.csv`, rows of `node_id, x, y, z`) | a virtual Zarr Vectors graph store | One object per connected component, every edge drawn (cycles too); node positions from `x`, `y`, `z`; each node's degree and other numeric values become properties. |
| Point tables (`.csv`, `.tsv`, `.xyz`, `.parquet`) and LAS point clouds (`.las`, and compressed `.laz`) | a virtual Zarr Vectors point store | x, y, z from columns named so (or `x_location`, `x_um` …, as Xenium writes transcripts); other numeric columns become properties. Large clouds get coarse levels. |
| A folder of OME-Zarr, Zarr Vectors or precomputed data | the stores themselves | Read file by file. |

Chrome and Edge remember local files between visits (you are asked to allow
reading them again); links to them work in the same browser while the tab
is open.

!!! note "Coming"
    CIFTI and surface values (thickness,
    curvature, parcellations) are on the
    [work plan](https://github.com/AllenInstitute/ngplatform/blob/main/TODO.md).

## Exporting

What can be saved today, and where:

| What | How | Format |
|---|---|---|
| A local image | Datasets → the row's ⋯ → **Export as…** | NIfTI (`.nii.gz`, `.nii`), FreeSurfer (`.mgz`, `.mgh`) or an OME-Zarr folder: the whole image at full resolution or a coarser level (up to 2 GB), or a box of 256 voxels a side around the position at any level; or, at any size, every level written into a folder chunk by chunk as OME-Zarr (gzip-compressed; in browsers that can write folders, such as Chrome and Edge) |
| A local tractogram | the same | TrackVis `.trk` or MRtrix `.tck` |
| A local mesh or surface | the same | OBJ, PLY, STL, or its vertices as CSV |
| A local point table or SWC | the same | CSV |
| A local graph (GraphML or edge list) | the same | GraphML, or its nodes as CSV |
| A track group's streamlines | Filtering → a group → **Save .trk** | TrackVis `.trk` |
| A track group's density | Filtering → **Density map** | NIfTI |
| Group statistics | Filtering → **CSV** | CSV |
| A transform | Registration → **Save transform** | FreeSurfer `.lta`, ITK / ANTs `.txt`, plain 4 × 4 |
| A moved (registered) image | Registration → **Save image…** | NIfTI (`.nii`, `.nii.gz`) or OME-Zarr |
| A picture of the views | Camera icon → **Picture…**: magnified, trimmed | PNG |
| A movie of the views | Camera icon → **Movie…**: a sweep through slices or time, or a turn of the 3-D view | GIF, WebM, MP4, PNG frames (zip or folder) |
| The workspace itself | the link in the address bar, or **Share** | link or JSON |

!!! note "Coming"
    Saving large data without making terabyte files: a whole pyramid
    written chunk by chunk to a folder, or only your edits as a small layer
    over the original; remote images; TIFF and `.trx` output.
