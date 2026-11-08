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

/** A direction in camera space (x right, y up, z towards the viewer) from azimuth and elevation in degrees. */
export function lightDirection(azimuth: number, elevation: number): [number, number, number] {
  const a = (azimuth * Math.PI) / 180, e = (elevation * Math.PI) / 180;
  return [Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e)];
}

/** The OME-Zarr store a layer's source names, as the service reads it (http(s), gs:// or s3:// kept); undefined for other formats. */
export function omeZarrSource(source: string | undefined): string | undefined {
  if (source === undefined) return undefined;
  let url = source.trim();
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

/** A key for a camera and size, to tell whether the view changed (rounded so jitter does not count). */
export function viewKey(inv: ArrayLike<number>, width: number, height: number): string {
  let s = `${width}x${height}`;
  for (let i = 0; i < 16; ++i) s += `,${Number(inv[i]).toPrecision(6)}`;
  return s;
}
