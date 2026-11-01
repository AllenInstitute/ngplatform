const e="volumeView.panel",t="volumeView",o={id:"org.ngplatform.volume-view",name:"Volume rendering",version:"0.2.0",kind:"tool",enabledByDefault:!1,description:"Draws an image as a solid in Neuroglancer's 3-D view, cut open at the position so the sections show inside it.",guide:`Switch it on with **Volume**, beside **Sections** in the 3-D panel (or in the Volume tab). The first OME-Zarr image in the scene is drawn as a solid: a coarse level of it, ray-marched on this computer's GPU to the tissue surface.

## What you see
- The octant facing the camera is cut away at the current position, so the three sections (Neuroglancer's own, at full resolution) show the inside. Turn Sections off and the cut faces show the coarse volume instead.
- Everything else in the 3-D view (tracts, meshes, annotations) is drawn with it and hidden where tissue is in front, so tracts show through the cut.
- Hiding the image's layer hides the solid.

## Settings (the Volume tab)
- **Image**: which OME-Zarr image layer to draw.
- **Detail**: the level used for the solid; finer looks smoother and takes longer to load (up to 384 voxels on a side).
- **Tissue threshold**: how different from the background a voxel must be to count as tissue. It works for dark backgrounds (MRI) and pale ones (stains): the volume's border decides which.
- **Cut away the octant facing the camera**: off shows the whole surface.

Only OME-Zarr images are drawn for now (\`zarr://https://…\`); the 3-D view must show x, y and z.`,license:"Apache-2.0",activation:["onStartup"],contributes:{panels:[{id:e,title:"Volume",slot:"left",order:50}],commands:[{id:"volumeView.toggle",title:"Volume rendering on or off (in the 3-D view)",group:"View"}],appState:{key:t,version:2}}};export{o as V,e as a};
