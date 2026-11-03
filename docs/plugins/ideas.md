# Ideas for new plugins

Plugins that would be worth having, with the tools people use for the same
work today, so a plugin can borrow what works there and skip what does not.
The first group is on the
[work plan](https://github.com/AllenInstitute/ngplatform/blob/main/TODO.md);
the rest are open. To take one on, or to suggest another, open an issue with
the *Plugin idea* template.

## Planned

| Plugin | What it would do | People use today |
|---|---|---|
| **Annotations** (from Labels; begun, see [Annotations](annotations.md)) | Labels, measuring (lengths, areas, line profiles), contours, statistics per label or region, and manual segmentation | Freeview's measure tools, ITK-SNAP, WebKnossos |
| **Segmentation** (in Annotations; begun, see the [survey](segmentation-survey.md)) | Draw and erase labels: sphere brush, threshold-limited brush, 2-D/3-D fill, interpolation between slices; AI-assisted selection later; save masks locally | WebKnossos, ITK-SNAP, Freeview voxel edit, napari, 3D Slicer |
| **Luxar** | Views through [Luxar](https://github.com/royerlab/luxar): HDR points, lines and meshes, Gaussian-splat volumes, straight from OME-Zarr and Zarr Vectors | Luxar's own viewer |
| **Orientations** (begun, see [Orientations](orientations.md)) | Vector fields, DTI tensors and FA colour, spherical-harmonic ODF glyphs that refine as you zoom (multiscale) | FURY / DIPY, MRtrix `mrview`, DSI Studio, TrackVis |
| **Filters** | Mean, median, Gaussian and Frangi (vesselness) computed on the fly, chunk by chunk, at every level | Fiji, napari, ITK, Freeview's filters |
| **Collections** | A tab for an OME-Zarr collection (RFC-8): its images, coordinate systems and transforms | — |
| **Capture** | GIFs, movies, slice sweeps, rotations, magnified screenshots | Freeview movie frames, Neuroglancer's Python video tool |

## Open ideas

| Plugin | What it would do | People use today |
|---|---|---|
| **Neuron tracing and review** | Trace axons and dendrites as skeletons, edit them (split, join, reroot), mark synapses and review a neuron node by node | CATMAID, WebKnossos, Knossos, neuTube, Vaa3D |
| **Proofreading** | Merge and split segments of a segmentation, with history and multi-user locks | CAVE / FlyWire, WebKnossos, NeuTu |
| **Atlas** (begun, see [Atlas](atlas.md)) | An atlas's hierarchy (Allen CCF, Waxholm, DK/Destrieux): search a region, show it and its children, read the region under the cursor | Allen Brain Explorer, brainrender, ITK-SNAP label tables |
| **Surfaces** | Cortical surfaces with curvature, thickness, overlays, `.annot` and `.label`; outlines on the slices; inflated and sphere views | Freeview, Connectome Workbench, SurfIce |
| **Tract statistics** | Profiles along a tract (FA, length), bundle comparison, tract-to-region connectivity | DIPY AFQ, TractSeg, DSI Studio |
| **Connectome** | Region-by-region matrices and graphs linked to the regions in the views | Freeview's connectome view, BrainNet Viewer, NetworkX |
| **Time series** | Plot a voxel's or region's time course; play time-lapses; fMRI statistics overlays | Freeview's time course, FSLeyes, napari |
| **Spatial transcriptomics** | Gene expression points (MERFISH, Xenium, Visium) by gene, cluster and cell type, from AnnData | napari-spatialdata, Vitessce, TissUUmaps |
| **Probe tracks** | Electrode and Neuropixels trajectories, with the regions each channel passes | IBL's atlas tools, Pinpoint, HERBS |
| **DICOM** | Read a DICOM series as a virtual OME-Zarr | 3D Slicer, Horos, OHIF |
| **Side by side** | Two scenes linked (position, zoom, rotation) for comparing datasets or time points | Freeview's synced windows, napari's grid |
| **Quality control** | Checklists and ratings per dataset or subject (FreeSurfer recon, registration), saved as a table | FreeSurfer QA tools, MRIQC reports |
| **AI models** | Run segmentation or detection models in the browser (ONNX, WebGPU) on the visible chunks | WebKnossos AI jobs, napari plugins (micro-SAM, StarDist) |
| **Story** | Guided tours: saved views with text, played as a presentation or a video | Luxar story waypoints, Neuroglancer's Python video tool |
