# Luxar rendering

![The HCP-1065 tractogram drawn Luxar-style over the SRB 2026a template, in a 2-D section and inside a volume-rendered solid](../images/plugins/luxar.png)

**Kind:** tool · **Off by default** (switch it on in the Plugins tab) · a
**Luxar** tab, and a command ·
[Source and developer README](https://github.com/AllenInstitute/ngplatform/tree/main/plugins/luxar)

Draws a Zarr Vectors layer (a tractogram, skeletons, a point cloud, or a
`.trk`, `.tck`, `.trx` or SWC file opened in place) the way the
[Luxar](https://github.com/royerlab/luxar) viewer draws lines: as light,
added up and tone mapped, with smooth thick lines and mitred joins. It
does this inside Neuroglancer's own 2-D and 3-D views, for the layers you
choose, so a Luxar tractogram sits on a plain or volume-rendered image in
one viewer. The data is read in place, level by level as you zoom; nothing
is converted.

## Using it

- Switch the plugin on, open the **Luxar** tab and tick a layer. Or select
  the layer and run *Luxar rendering of the selected layer on or off* from
  the command palette.
- **Blending**: *Glow* adds the light of overlapping lines (bundles glow),
  hidden by what is in front of it; *Glow through* shows it over everything;
  *Emission and absorption* also darkens what is behind dense bundles;
  *Solid tubes* draws opaque, shaded lines.
- **Colour**: by direction (x red, y green, z blue), each streamline its own
  colour, a vertex attribute through a colormap (with its range), or one
  colour.
- **Width** in pixels, **Brightness** in stops, **Sharpness** (soft glow to
  hard edge) and the **Tone map**. **Automatic brightness** dims lines where
  many crowd the view, so a whole brain glows rather than turning white and
  zooming in (finer levels, more lines) keeps the picture's brightness.
- **2-D slab**: in a 2-D view, lines within half this distance of the
  section show, fading away from it, as Luxar slices by proximity.
- **Detail**: about how many vertices a view reads. The coarsest level shows
  first; finer levels replace it as you zoom in, only for the chunks in view.
- **Momentum** (at the bottom): let go of a rotation in the 3-D view while
  moving and it keeps turning, slowing to a stop.
- Hiding the layer hides its Luxar drawing too. A link opened where the
  plugin is off shows the layer drawn by Neuroglancer as usual.

Not yet: meshes, a layer's selected segments and track filtering's groups
by id (a group layer that has its own store is drawn whole, which is the
group), Luxar's bloom, and fitted Gaussian splats (Luxar's GPU fit, which
makes new files).

## Images as splats

Tick an image layer and it is drawn as Gaussian splats made from its voxels
as they are read, in place of Neuroglancer's drawing of it: in the 3-D view
as a glowing or absorbing cloud, and in the 2-D views as the splats cut by
each section, which look like the image itself. Untick it and Neuroglancer
draws it again. The link keeps the layer as it was (its opacity
included).

## Notes from users

*Add your tips, workflows and problems here (edit this page on GitHub).*
