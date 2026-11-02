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
| Tractograms (`.trk`, `.tck`, `.trx`) | a virtual Zarr Vectors streamline store | Split into spatial cells, with a coarse level for large files; track groups work on them. |
| Meshes (`.obj`, `.stl`, `.ply`), GIFTI and FreeSurfer surfaces (`lh.pial` …) | a virtual Zarr Vectors mesh store | Surfaces are placed in scanner RAS. |
| Neurons (`.swc`, or a folder of them) | a virtual Zarr Vectors skeleton store | One object per tree, with cable length and branch points. |
| Point tables (`.csv`, `.tsv`, `.xyz`) | a virtual Zarr Vectors point store | Numeric columns become properties. |
| A folder of OME-Zarr, Zarr Vectors or precomputed data | the stores themselves | Read file by file. |

Chrome and Edge remember local files between visits (you are asked to allow
reading them again); links to them work in the same browser while the tab
is open.

!!! note "Coming"
    LAS/LAZ point clouds, Parquet tables and GraphML are on the
    [work plan](https://github.com/AllenInstitute/ngplatform/blob/main/TODO.md).

## Exporting

What can be saved today, and where:

| What | How | Format |
|---|---|---|
| A local image | Datasets → the row's ⋯ → **Export as…** | NIfTI (`.nii.gz`, `.nii`), FreeSurfer (`.mgz`, `.mgh`) or an OME-Zarr folder, at full resolution or a coarser level (up to 2 GB) |
| A local tractogram | the same | TrackVis `.trk` or MRtrix `.tck` |
| A local mesh or surface | the same | OBJ, PLY, STL, or its vertices as CSV |
| A local point table or SWC | the same | CSV |
| A track group's streamlines | Filtering → a group → **Save .trk** | TrackVis `.trk` |
| A track group's density | Filtering → **Density map** | NIfTI |
| Group statistics | Filtering → **CSV** | CSV |
| A transform | Registration → **Save transform** | FreeSurfer `.lta`, ITK / ANTs `.txt`, plain 4 × 4 |
| A moved (registered) image | Registration → **Save image…** | NIfTI (`.nii`, `.nii.gz`) or OME-Zarr |
| A picture of the views | Camera icon in the top bar | PNG |
| The workspace itself | the link in the address bar, or **Share** | link or JSON |

!!! note "Coming"
    Saving large data without making terabyte files: a region or level
    within a size limit, a whole pyramid written chunk by chunk to a folder,
    or only your edits as a small layer over the original; TIFF and `.trx`
    output.
