/**
 * A Zarr Vectors layer's Colour by look (the Display tab's Vertex colour
 * section), for plugins that draw a layer themselves in its colours: the
 * look read from the layer's state, the attributes it reads, and its
 * colours (a group's palette colour or stored one, a colour map's table).
 * See src/engine/colour_shader.ts.
 */
export { attributeShaderId, type ColourByLook, colourLookOf, groupPalette, layerColourLook, lookAttributes, unpackRgb } from "../engine/colour_shader.js";
export { colormapSamples } from "../engine/colormaps.js";
