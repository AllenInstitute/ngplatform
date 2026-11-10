/**
 * OME-Zarr metadata of an image with an axis of components per voxel (a
 * channel axis, or a NIfTI's fourth axis, read as `t`): the same metadata
 * without that axis, so it reads as a 3-D image (../volume-view/ome.ts).
 * Kept apart from the reader so the main thread can look at a store
 * without loading decoders.
 */

/** Axis names an OME axis list may give the components: a channel axis, else a NIfTI's t. */
function componentIndex(axes: { name: string; type?: string }[]): number {
  const channel = axes.findIndex((a) => a.type === "channel");
  if (channel !== -1) return channel;
  const named = axes.findIndex((a) => a.name === "c");
  if (named !== -1) return named;
  return axes.findIndex((a) => a.name === "t" || a.type === "time");
}

interface Transform {
  type: string;
  scale?: number[];
  translation?: number[];
  affine?: number[][] | number[];
  transformations?: Transform[];
  [key: string]: unknown;
}

/** A transform over n + 1 axes without axis `drop` (rows and columns of an affine). */
function without(t: Transform, drop: number, n: number): Transform {
  const out: Transform = { ...t };
  if (t.scale) out.scale = t.scale.filter((_, i) => i !== drop);
  if (t.translation) out.translation = t.translation.filter((_, i) => i !== drop);
  if (t.affine) {
    const rows = Array.isArray(t.affine[0]) ? (t.affine as number[][]) : Array.from({ length: n }, (_, r) => (t.affine as number[]).slice(r * (n + 1), (r + 1) * (n + 1)));
    out.affine = rows.filter((_, r) => r !== drop).map((row) => row.filter((_, c) => c !== drop));
  }
  if (t.transformations) out.transformations = t.transformations.map((s) => without(s, drop, n));
  return out;
}

/**
 * The group's metadata without its component axis, so it reads as a 3-D
 * image (../volume-view/ome.ts); and that axis's position and name.  Other
 * axes that are not space (a size-1 t beside c, as bioformats2raw writes
 * tczyx) stay: the volume view's levels keep them, and the reader reads
 * them at index 0 when they are size 1, which only the arrays can say.
 */
export function spatialGroup(group: any): { group: any; component: number; name: string } {
  const attributes = group?.attributes ?? group ?? {};
  const ome = attributes.ome ?? attributes;
  const multiscale = ome?.multiscales?.[0];
  if (multiscale === undefined) throw new Error("not an OME-Zarr image (no multiscales)");
  const systems: { name: string; axes: { name: string; type?: string }[] }[] = multiscale.coordinateSystems ?? [];
  const firstOutput = multiscale.datasets?.[0]?.coordinateTransformations?.[0]?.output;
  const outName = typeof firstOutput === "string" ? firstOutput : firstOutput?.name;
  const baseAxes = (systems.find((s) => s.name === outName) ?? systems[0])?.axes ?? multiscale.axes ?? [];
  const component = componentIndex(baseAxes);
  const spatial = baseAxes.filter((a) => a.name === "x" || a.name === "y" || a.name === "z");
  if (component === -1 || spatial.length !== 3 || baseAxes.length < 4) {
    throw new Error(`the image's axes are ${baseAxes.map((a: { name: string }) => a.name).join(", ")}; orientations need one axis of components (c) beside x, y and z`);
  }
  const n = baseAxes.length;
  const strip = (t: Transform) => without(t, component, n);
  const stripped = {
    ...multiscale,
    ...(multiscale.axes ? { axes: multiscale.axes.filter((_: unknown, i: number) => i !== component) } : {}),
    ...(multiscale.coordinateSystems
      ? {
          coordinateSystems: systems.map((s) => {
            const c = componentIndex(s.axes);
            return { ...s, axes: c === -1 ? s.axes : s.axes.filter((_, i) => i !== c) };
          }),
        }
      : {}),
    datasets: multiscale.datasets.map((d: { coordinateTransformations?: Transform[] }) => ({ ...d, coordinateTransformations: d.coordinateTransformations?.map(strip) })),
    ...(multiscale.coordinateTransformations ? { coordinateTransformations: multiscale.coordinateTransformations.map(strip) } : {}),
  };
  return { group: { attributes: { ome: { ...ome, multiscales: [stripped] } } }, component, name: baseAxes[component].name };
}
