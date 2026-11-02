/**
 * Fine sections on the cut's faces: three cross-sections of the layout's
 * own (Neuroglancer's `crossSections`, drawn in the 3-D view), xy, xz and
 * yz through the position, at a zoom of their own.  Neuroglancer loads
 * their data at the level that zoom needs, as for any section, so the faces
 * are as sharp as the 3-D view can show, down to the image's finest level,
 * while the solid stays coarse.
 */

export interface SectionPlan {
  /** The image's finest voxel, mm. */
  finestMm: number;
  /** The image's largest extent, mm. */
  extentMm: number;
  /** One canonical unit of the view (the smallest display scale), metres. */
  canonicalMetres: number;
  /** The 3-D view's height in canonical units (Neuroglancer's projectionScale). */
  projectionScale: number | undefined;
  /** The 3-D panel's larger side, CSS pixels. */
  panelPixels: number;
}

/** Most pixels a section has a side: a section texture each, three of them. */
export const MAX_SECTION = 2048;
const MIN_SECTION = 256;

/** The fixed turns of the xz and yz sections from the xy one, as Neuroglancer's layouts have them. */
const H = Math.SQRT1_2;
export const SECTION_TURNS: Record<string, [number, number, number, number] | undefined> = {
  xy: undefined,
  xz: [H, 0, 0, H],
  yz: [0, H, 0, H],
};

/** The layout's type, whether the state keeps it as a name or as an object with cross-sections. */
export function layoutType(layout: unknown): string {
  if (typeof layout === "string") return layout;
  if (typeof layout === "object" && layout !== null && typeof (layout as { type?: unknown }).type === "string") return (layout as { type: string }).type;
  return "xy-3d";
}

/**
 * The cross-sections: each a square of pixels at a zoom (canonical units a
 * pixel) no finer than the finest voxel and no finer than the 3-D view's
 * pixels, stepped by √2 so small zooms do not reload them, and as many
 * pixels as cover the image (half again, for a position off its centre),
 * within MAX_SECTION.
 */
export function fineSections(plan: SectionPlan): Record<string, unknown> {
  const toCanonical = (mm: number) => (mm * 1e-3) / plan.canonicalMetres;
  const finest = toCanonical(plan.finestMm);
  const viewPixel = plan.projectionScale !== undefined && plan.panelPixels > 0 ? plan.projectionScale / plan.panelPixels : finest;
  const wanted = Math.max(finest, viewPixel);
  const steps = Math.max(0, Math.ceil(Math.log2(wanted / finest) * 2 - 1e-9));
  const scale = finest * 2 ** (steps / 2);
  const extent = toCanonical(plan.extentMm) * 1.5;
  const size = Math.max(MIN_SECTION, Math.min(MAX_SECTION, Math.ceil(extent / scale / 64) * 64));
  const sections: Record<string, unknown> = {};
  for (const [axes, turn] of Object.entries(SECTION_TURNS)) {
    sections[`volume-${axes}`] = {
      width: size,
      height: size,
      position: { link: "linked" },
      orientation: turn === undefined ? { link: "linked" } : { link: "relative", value: turn },
      scale: { link: "unlinked", value: Number(scale.toPrecision(6)) },
    };
  }
  return sections;
}
