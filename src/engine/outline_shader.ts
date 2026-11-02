/**
 * Segmentation outlines without changing Neuroglancer: an image layer that
 * reads the same labels and draws, in the 2-D views, only the pixels whose
 * label differs from a neighbour's a set number of screen pixels away, in
 * the segment's own colour.  Neuroglancer's segmentation layer cannot draw
 * outlines itself; its image layer's shader can read neighbouring voxels
 * (`getDataValueAt`, with `vChunkPosition` and `uChunkDataSize`, the names
 * its chunk formats give the shader), and the screen-space derivatives of
 * the voxel position give the section's own axes, so the outline lies in
 * the section, at any angle and zoom.
 *
 * The colours are the segmentation's: its stated colours (a lookup table's)
 * written into the shader, else Neuroglancer's hash of the id with the
 * layer's seed (the same murmur3 mix and HSV mapping as its
 * segment_color.ts, Apache-2.0), and its saturation.  Its visible segments,
 * when it shows only some, are written in too.  A shader is regenerated
 * when any of these change (./outlines.ts).
 *
 * Limits: a boundary that lies exactly on a chunk's face is not drawn (a
 * chunk's shader sees only its own voxels; at its faces the neighbour is
 * the voxel itself), and more than MAX_EMBEDDED stated colours or visible
 * segments are not written in (hashed colours, all segments, instead).
 *
 * Pure text, tested in Node (tests/outlines.test.ts).
 */

export const MAX_EMBEDDED = 4096;

/** The first line of an outline layer's shader, naming its segmentation layer. */
export const OUTLINE_MARKER = "// Outlines of the segmentation layer ";

export interface OutlineOptions {
  /** The segmentation layer's name. */
  layer: string;
  /** Neuroglancer's data type name, lower case ("uint8" … "uint64"). */
  dataType: string;
  seed: number;
  saturation: number;
  hideSegmentZero: boolean;
  /** Stated colours (ids and 0..1 RGB). */
  stated: [bigint, [number, number, number]][];
  /** One colour for segments without their own (`segmentDefaultColor`). */
  fixed?: [number, number, number];
  /** Only these segments, when the layer shows only some. */
  visible?: bigint[];
  /** The segmentation's 2-D opacity before outlines took over, to give back. */
  fill: [number, number];
}

const f = (v: number) => {
  const s = String(Number(v.toFixed(4)));
  return s.includes(".") || s.includes("e") ? s : `${s}.0`;
};
const u = (v: bigint) => `${v}u`;
const uvec2Of = (id: bigint) => `uvec2(${u(id & 0xffffffffn)}, ${u(id >> 32n)})`;

/** The label at a chunk position, as (low, high) 32-bit words. */
function labelAccess(dataType: string): string {
  const read = dataType === "uint64" ? "getDataValueAt(p).value" : "uvec2(uint(toRaw(getDataValueAt(p))), 0u)";
  return `uvec2 outlineLabelAt(vec3 q) {
  ivec3 p = ivec3(clamp(floor(q), vec3(0.0), uChunkDataSize - 1.0));
  return ${read};
}`;
}

/** A sorted table of ids as GLSL, with a binary search returning its index or -1. */
function idTable(name: string, ids: bigint[]): string {
  const n = ids.length;
  return `const uvec2 ${name}[${n}] = uvec2[${n}](
  ${ids.map(uvec2Of).join(",\n  ")});
int ${name}Index(uvec2 v) {
  int lo = 0;
  int hi = ${n - 1};
  while (lo <= hi) {
    int mid = (lo + hi) / 2;
    uvec2 k = ${name}[mid];
    if (k == v) return mid;
    if (k.y < v.y || (k.y == v.y && k.x < v.x)) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}`;
}

const compare = (a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0);

export function outlineShader(o: OutlineOptions): string {
  const stated = [...o.stated].sort((a, b) => compare(a[0], b[0]));
  const useStated = stated.length > 0 && stated.length <= MAX_EMBEDDED;
  const visible = o.visible !== undefined && o.visible.length > 0 && o.visible.length <= MAX_EMBEDDED ? [...o.visible].sort(compare) : undefined;
  const parts: string[] = [
    `${OUTLINE_MARKER}${JSON.stringify(o.layer)}.`,
    `// Written by the app from that layer's colours, and rewritten when they change. Fill before: ${f(o.fill[0])} ${f(o.fill[1])}.`,
    "#uicontrol float outline_width slider(min=0.5, max=6, default=1, step=0.5)",
    "#uicontrol float outline_opacity slider(min=0, max=1, default=1, step=0.05)",
    "#uicontrol float fill_opacity slider(min=0, max=1, default=0, step=0.05)",
    labelAccess(o.dataType),
  ];
  if (o.fixed === undefined) {
    parts.push(`uint outlineHashCombine(uint state, uint value) {
  value *= 0xcc9e2d51u;
  value = (value << 15u) | (value >> 17u);
  value *= 0x1b873593u;
  state ^= value;
  state = (state << 13u) | (state >> 19u);
  state = (state * 5u) + 0xe6546b64u;
  return state;
}
vec3 outlineHashColour(uvec2 v) {
  uint h = outlineHashCombine(outlineHashCombine(${u(BigInt(o.seed >>> 0))}, v.x), v.y);
  float hue = float(h & 0xFFu) / 255.0;
  float saturation = 0.5 + float((h >> 8u) & 0xFFu) / 255.0 * 0.5;
  vec3 rgb = clamp(vec3(abs(hue * 6.0 - 3.0) - 1.0, 2.0 - abs(hue * 6.0 - 2.0), 2.0 - abs(hue * 6.0 - 4.0)), 0.0, 1.0);
  return (rgb - 1.0) * saturation + 1.0;
}`);
  }
  if (useStated) {
    parts.push(idTable("outlineStated", stated.map(([id]) => id)));
    parts.push(`const vec3 outlineStatedRgb[${stated.length}] = vec3[${stated.length}](
  ${stated.map(([, c]) => `vec3(${c.map(f).join(", ")})`).join(",\n  ")});`);
  }
  if (visible !== undefined) parts.push(idTable("outlineVisible", visible));
  const colour = [
    "vec3 outlineColour(uvec2 v) {",
    ...(useStated ? ["  int i = outlineStatedIndex(v);", "  if (i >= 0) return outlineStatedRgb[i];"] : []),
    o.fixed !== undefined ? `  return vec3(${o.fixed.map(f).join(", ")});` : "  return outlineHashColour(v);",
    "}",
  ];
  parts.push(colour.join("\n"));
  parts.push(`void main() {
  // The section's axes in voxels per screen pixel: outlines lie in the section at any angle.
  vec3 p = vChunkPosition;
  vec3 dx = dFdx(p) * outline_width;
  vec3 dy = dFdy(p) * outline_width;
  uvec2 v = outlineLabelAt(p);
${o.hideSegmentZero ? "  if (v == uvec2(0u)) {\n    emitTransparent();\n    return;\n  }\n" : ""}${visible !== undefined ? "  if (outlineVisibleIndex(v) < 0) {\n    emitTransparent();\n    return;\n  }\n" : ""}  bool edge = outlineLabelAt(p + dx) != v || outlineLabelAt(p - dx) != v || outlineLabelAt(p + dy) != v || outlineLabelAt(p - dy) != v;
  float alpha = edge ? outline_opacity : fill_opacity;
  if (alpha <= 0.0) {
    emitTransparent();
    return;
  }
  emitRGBA(vec4(mix(vec3(1.0), outlineColour(v), ${f(o.saturation)}), alpha));
}
`);
  return parts.join("\n");
}

/** The segmentation layer an outline shader belongs to, and the fill it took over; undefined if not one. */
export function outlineOf(shader: string): { layer: string; fill: [number, number] } | undefined {
  if (!shader.startsWith(OUTLINE_MARKER)) return undefined;
  const line = shader.slice(OUTLINE_MARKER.length, shader.indexOf("\n"));
  let layer: unknown;
  try {
    layer = JSON.parse(line.replace(/\.$/, ""));
  } catch {
    return undefined;
  }
  if (typeof layer !== "string") return undefined;
  const fill = /Fill before: ([\d.e-]+) ([\d.e-]+)\./.exec(shader);
  return { layer, fill: fill ? [Number(fill[1]), Number(fill[2])] : [0.5, 0] };
}
