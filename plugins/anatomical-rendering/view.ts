/** The view a frame is rendered from, as the render service takes it: pure functions of Neuroglancer's frame. */

export type Axis = "x" | "y" | "z";

/** A cut through the position, across one axis, keeping one side. */
export interface Cut {
  axis: Axis;
  /** 1 keeps the side towards +axis, -1 the side towards -axis. */
  keep: 1 | -1;
  /** Millimetres from the position along the axis. */
  offset: number;
  on: boolean;
}

export interface Dimensions {
  names: string[];
  scales: number[];
  units: string[];
}

/** Metres in one unit Neuroglancer gives (its dimensions are in metres, "m"; anything else counts as mm). */
function metresPer(unit: string): number {
  return unit === "m" ? 1 : 1e-3;
}

/**
 * Physical millimetres (x, y, z: OME-Zarr's axes as Neuroglancer shows
 * them by default) to display coordinates, column-major; undefined when
 * the view does not show x, y and z.
 */
export function displayFromPhysical(d: Dimensions): number[] | undefined {
  const rows = new Array(16).fill(0);
  rows[15] = 1;
  for (let i = 0; i < 3; ++i) {
    const axis = ["x", "y", "z"].indexOf(d.names[i]);
    if (axis === -1) return undefined;
    rows[4 * i + axis] = 1e-3 / (d.scales[i] * metresPer(d.units[i]));
  }
  return columnMajor(rows);
}

/** How many mm one display unit is (the first displayed dimension's). */
export function unitMm(d: Dimensions): number {
  return d.scales[0] * metresPer(d.units[0]) * 1e3;
}

export function columnMajor(rowMajor: ArrayLike<number>): number[] {
  const out = new Array(16);
  for (let r = 0; r < 4; ++r) for (let c = 0; c < 4; ++c) out[4 * c + r] = rowMajor[4 * r + c];
  return out;
}

/** World planes (nx, ny, nz, d), kept where n.x + d >= 0, for the cuts that are on, through `position` (display). */
export function clipPlanes(cuts: Cut[], position: ArrayLike<number>, d: Dimensions): [number, number, number, number][] {
  const out: [number, number, number, number][] = [];
  for (const c of cuts) {
    if (!c.on) continue;
    const i = d.names.indexOf(c.axis);
    if (i === -1 || i > 2) continue;
    const n: [number, number, number] = [0, 0, 0];
    n[i] = c.keep;
    const at = position[i] + c.offset / unitMm(d);
    out.push([n[0], n[1], n[2], -c.keep * at]);
  }
  return out;
}

/** The camera's forward direction (display coordinates) from its inverse view-projection (column-major). */
export function viewForward(inv: ArrayLike<number>): [number, number, number] {
  const un = (z: number) => {
    const x = inv[8] * z + inv[12], y = inv[9] * z + inv[13], zz = inv[10] * z + inv[14], w = inv[11] * z + inv[15];
    return [x / w, y / w, zz / w];
  };
  const a = un(-1), b = un(1);
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const l = Math.hypot(...d) || 1;
  return [d[0] / l, d[1] / l, d[2] / l];
}

/** A cut facing the camera: the plane across the view `offsetMm` past the position, keeping what lies beyond it. */
export function viewCutPlane(inv: ArrayLike<number>, position: ArrayLike<number>, offsetMm: number, d: Dimensions): [number, number, number, number] {
  const f = viewForward(inv);
  const u = offsetMm / unitMm(d);
  const p = [position[0] + f[0] * u, position[1] + f[1] * u, position[2] + f[2] * u];
  return [f[0], f[1], f[2], -(f[0] * p[0] + f[1] * p[1] + f[2] * p[2])];
}

/** Lighting styles: the light map and how strong it is, and the key light's strength. */
export const LIGHTING: Record<string, { name: string; map: string; envScale: number; key: number }> = {
  studio: { name: "Studio", map: "photo-studio", envScale: 1.0, key: 1.0 },
  soft: { name: "Soft (diffuse, faint shadows)", map: "studio", envScale: 1.7, key: 0.25 },
  hard: { name: "Hard (one strong light, deep shadows)", map: "studio", envScale: 0.2, key: 2.2 },
  sky: { name: "Sky (daylight)", map: "sky", envScale: 1.0, key: 1.2 },
  plain: { name: "The preset's own (sky colours)", map: "", envScale: 1.0, key: 1.0 },
};

/** A direction in camera space (x right, y up, z towards the viewer) from azimuth and elevation in degrees. */
export function lightDirection(azimuth: number, elevation: number): [number, number, number] {
  const a = (azimuth * Math.PI) / 180, e = (elevation * Math.PI) / 180;
  return [Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e)];
}

/** The OME-Zarr store a layer's source names, as the service reads it (http(s), gs:// or s3:// kept); undefined for other formats. */
export function omeZarrSource(source: string | undefined): string | undefined {
  if (source === undefined) return undefined;
  let url = source.trim();
  // An N5 multiscale (the Human Organ Atlas serves most scans so): passed on as n5://…, which the host reads.
  const n5 = /^n5:\/\/(.*?)(\|n5:?)?\/?$/i.exec(url);
  if (n5) return /^(https?|gs|s3):\/\//.test(n5[1]) || n5[1].startsWith("/") ? `n5://${n5[1].replace(/\/+$/, "")}` : undefined;
  const scheme = /^(zarr2?|zarr3):\/\//i.exec(url);
  const pipe = /\|zarr[23]?(:[^|]*)?$/i.exec(url);
  if (scheme === null && pipe === null && !/\.ome\.zarr\/?$/i.test(url)) return undefined;
  if (scheme) url = url.slice(scheme[0].length);
  if (pipe) url = url.slice(0, pipe.index);
  if (!/^(https?|gs|s3):\/\//.test(url) && !url.startsWith("/")) return undefined;
  return url.replace(/\/+$/, "");
}

/**
 * Neuroglancer's 3-D orientation (a quaternion x, y, z, w) for a camera looking along `forward`
 * with `up` up, in display coordinates (its view frame: x right, y down, z forward).
 */
export function orientationLooking(forward: [number, number, number], up: [number, number, number]): [number, number, number, number] {
  const n = (v: number[]) => {
    const l = Math.hypot(...v);
    return v.map((x) => x / l);
  };
  const f = n(forward);
  const u = n(up);
  const r = n([f[1] * u[2] - f[2] * u[1], f[2] * u[0] - f[0] * u[2], f[0] * u[1] - f[1] * u[0]]);
  const dn = [f[1] * r[2] - f[2] * r[1], f[2] * r[0] - f[0] * r[2], f[0] * r[1] - f[1] * r[0]]; // forward × right = down
  // Rotation matrix columns: right, down, forward.
  const m = [
    [r[0], dn[0], f[0]],
    [r[1], dn[1], f[1]],
    [r[2], dn[2], f[2]],
  ];
  const tr = m[0][0] + m[1][1] + m[2][2];
  let x: number, y: number, z: number, w: number;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    w = s / 4;
    x = (m[2][1] - m[1][2]) / s;
    y = (m[0][2] - m[2][0]) / s;
    z = (m[1][0] - m[0][1]) / s;
  } else if (m[0][0] > m[1][1] && m[0][0] > m[2][2]) {
    const s = Math.sqrt(1 + m[0][0] - m[1][1] - m[2][2]) * 2;
    w = (m[2][1] - m[1][2]) / s;
    x = s / 4;
    y = (m[0][1] + m[1][0]) / s;
    z = (m[0][2] + m[2][0]) / s;
  } else if (m[1][1] > m[2][2]) {
    const s = Math.sqrt(1 + m[1][1] - m[0][0] - m[2][2]) * 2;
    w = (m[0][2] - m[2][0]) / s;
    x = (m[0][1] + m[1][0]) / s;
    y = s / 4;
    z = (m[1][2] + m[2][1]) / s;
  } else {
    const s = Math.sqrt(1 + m[2][2] - m[0][0] - m[1][1]) * 2;
    w = (m[1][0] - m[0][1]) / s;
    x = (m[0][2] + m[2][0]) / s;
    y = (m[1][2] + m[2][1]) / s;
    z = s / 4;
  }
  return [x, y, z, w];
}

/** Standard views of a brain in RAS display coordinates (x right, y anterior, z superior). */
export const ANATOMICAL_VIEWS: { name: string; forward: [number, number, number]; up: [number, number, number] }[] = [
  { name: "Left", forward: [1, 0, 0], up: [0, 0, 1] },
  { name: "Right", forward: [-1, 0, 0], up: [0, 0, 1] },
  { name: "Anterior", forward: [0, -1, 0], up: [0, 0, 1] },
  { name: "Posterior", forward: [0, 1, 0], up: [0, 0, 1] },
  { name: "Superior", forward: [0, 0, -1], up: [0, 1, 0] },
  { name: "Inferior", forward: [0, 0, 1], up: [0, 1, 0] },
];

/** The sides +axis and -axis point to (words of OME-Zarr's anatomical orientations: "right", "left"), per axis. */
export type AxisSides = Record<Axis, { pos: string; neg: string }>;

/** The letters a side's button shows, in the order the buttons come. */
const SIDE_LETTERS: [string, string][] = [
  ["left", "L"], ["right", "R"], ["anterior", "A"], ["posterior", "P"], ["superior", "S"], ["inferior", "I"],
  ["dorsal", "D"], ["ventral", "V"], ["rostral", "Ro"], ["caudal", "Ca"], ["cranial", "Cr"],
  ["proximal", "Pr"], ["distal", "Di"], ["palmar", "Pa"], ["plantar", "Pl"],
];
/** Sides that are "up" when the view looks across them, and those that are "up" when it looks along that axis. */
const UP_SIDES = ["superior", "dorsal", "cranial"];
const FRONT_SIDES = ["anterior", "rostral", "ventral"];

/**
 * The image's anatomical orientation from its OME-Zarr metadata (the
 * attributes of its zarr.json, or its .zattrs): each of x, y and z with an
 * `orientation` of type "anatomical" ("left-to-right": +x points right).
 * Undefined unless all three say.
 */
export function anatomicalSides(attributes: unknown): AxisSides | undefined {
  const a = attributes as { ome?: unknown; multiscales?: unknown } | undefined;
  const ome = (a?.ome ?? a) as { multiscales?: { axes?: unknown[]; coordinateSystems?: { axes?: unknown[] }[] }[] } | undefined;
  const ms = ome?.multiscales?.[0];
  const axes = ms?.axes ?? ms?.coordinateSystems?.at(-1)?.axes ?? [];
  const out: Partial<AxisSides> = {};
  for (const ax of axes as { name?: unknown; orientation?: { type?: unknown; value?: unknown } }[]) {
    const name = ax?.name;
    const o = ax?.orientation;
    if ((name !== "x" && name !== "y" && name !== "z") || o?.type !== "anatomical" || typeof o.value !== "string") continue;
    const m = /^([a-z]+)-to-([a-z]+)$/.exec(o.value);
    if (m) out[name] = { neg: m[1], pos: m[2] };
  }
  return out.x && out.y && out.z ? (out as AxisSides) : undefined;
}

/** A button that turns the 3-D view: what it shows, what it is called, and the camera's direction and up (display coordinates). */
export interface ViewButton {
  label: string;
  name: string;
  forward: [number, number, number];
  up: [number, number, number];
}

/**
 * The buttons that turn the view to look from each side of the image: by
 * its anatomical sides when its metadata gives them (L, R, A, P, S, I),
 * else by axis (+x, -x, ...: "from +x" looks towards -x).  `display`: the
 * displayed dimensions' names (x, y and z in some order); none without
 * all three.  The view is upright: superior (else +z) up, and looking
 * along that axis, anterior (else +y) up.
 */
export function viewButtons(display: readonly string[], sides: AxisSides | undefined): ViewButton[] {
  const index = (["x", "y", "z"] as Axis[]).map((a) => display.indexOf(a));
  if (index.some((i) => i < 0 || i > 2)) return [];
  const unit = (axis: Axis, sign: number): [number, number, number] => {
    const v: [number, number, number] = [0, 0, 0];
    v[index[["x", "y", "z"].indexOf(axis)]] = sign;
    return v;
  };
  // Which axis, and which way along it, is up; and which is up when looking along that one.
  const along = (wanted: string[], fallback: [Axis, number]): [Axis, number] => {
    for (const axis of ["x", "y", "z"] as Axis[]) {
      const s = sides?.[axis];
      if (s && wanted.includes(s.pos)) return [axis, 1];
      if (s && wanted.includes(s.neg)) return [axis, -1];
    }
    return fallback;
  };
  const up = along(UP_SIDES, ["z", 1]);
  let front = along(FRONT_SIDES, ["y", 1]);
  if (front[0] === up[0]) front = up[0] === "y" ? ["z", 1] : ["y", 1];
  const out: (ViewButton & { order: number })[] = [];
  for (const axis of ["x", "y", "z"] as Axis[]) {
    for (const sign of [1, -1]) {
      const side = sides === undefined ? undefined : sign > 0 ? sides[axis].pos : sides[axis].neg;
      const letter = SIDE_LETTERS.findIndex(([w]) => w === side);
      const label = side === undefined ? `${sign > 0 ? "+" : "−"}${axis}` : letter >= 0 ? SIDE_LETTERS[letter][1] : side.slice(0, 2);
      const camUp = axis === up[0] ? unit(...front) : unit(...up);
      out.push({
        label,
        name: side === undefined ? label : side,
        // From that side, looking back across the image.
        forward: unit(axis, -sign),
        up: camUp,
        order: side === undefined ? out.length : letter >= 0 ? letter : 99,
      });
    }
  }
  return out.sort((a, b) => a.order - b.order).map(({ order: _o, ...b }) => b);
}

/** The axes of an image's source as Neuroglancer reads them (LayerTransform's input): names, units, and the extent when known. */
export interface SourceAxes {
  names: string[];
  units: string[];
  bounds?: { lower: number[]; upper: number[] };
}

/**
 * What the image's axes allow: `problem` when it cannot be rendered
 * (fewer than three spatial axes; in this browser, more than one time
 * point or channel), `note` when only part of it is (on a computer, the
 * first time point and channel).  Spatial axes are those in metres.
 */
export function axesCheck(axes: SourceAxes | undefined, browser: boolean): { problem?: string; note?: string } {
  if (axes === undefined) return {};
  const spatial = axes.units.filter((u) => u === "m").length;
  if (spatial < 3) return { problem: `This image has ${spatial === 1 ? "one spatial axis" : `${spatial === 0 ? "no" : spatial} spatial axes`}: rendering needs x, y and z.` };
  const extent = (i: number) => (axes.bounds ? Math.round(axes.bounds.upper[i] - axes.bounds.lower[i]) : 1);
  let times = 1;
  let channels = 1;
  axes.names.forEach((n, i) => {
    if (axes.units[i] === "m" || extent(i) <= 1) return;
    if (axes.units[i] === "s" || /^t'?$/i.test(n)) times *= extent(i);
    else channels *= extent(i);
  });
  if (times === 1 && channels === 1) return {};
  const parts = [times > 1 ? `${times} time points` : "", channels > 1 ? `${channels} channels` : ""].filter(Boolean).join(" and ");
  if (browser) return { problem: `This image has ${parts}: this browser renders an image with one of each. Render it on a computer.` };
  const first = [times > 1 ? "time point" : "", channels > 1 ? "channel" : ""].filter(Boolean).join(" and ");
  return { note: `This image has ${parts}: the first ${first} ${times > 1 && channels > 1 ? "are" : "is"} rendered.` };
}

/** A link a host sent, for an `href`: http(s) only (never `javascript:`); undefined otherwise. */
export function safeHref(url: unknown): string | undefined {
  if (typeof url !== "string") return undefined;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : undefined;
  } catch {
    return undefined;
  }
}

/** Where a page can read a store's metadata (gs:// as Google Cloud Storage's public address); undefined for a host's own paths and s3. */
export function metadataBase(url: string): string | undefined {
  if (url.startsWith("n5://")) return undefined;
  if (/^https?:\/\//.test(url)) return url.replace(/\/+$/, "");
  const gs = /^gs:\/\/(.+)$/.exec(url);
  return gs ? `https://storage.googleapis.com/${gs[1].replace(/\/+$/, "")}` : undefined;
}

/** A key for a camera and size, to tell whether the view changed (rounded so jitter does not count). */
export function viewKey(inv: ArrayLike<number>, width: number, height: number): string {
  let s = `${width}x${height}`;
  for (let i = 0; i < 16; ++i) s += `,${Number(inv[i]).toPrecision(6)}`;
  return s;
}
