/**
 * Planning captures: the frames of a movie (a sweep along a dimension, a
 * turntable turn of the 3-D view), the size a picture comes out at, and
 * trimming a picture's empty borders.  Pure: the engine moves the view
 * (../engine/capture.ts) and the shell encodes (../ui/capture.ts).
 */

export type Quaternion = [number, number, number, number];

export interface SweepFrame {
  kind: "position";
  /** The dimension moved and its value (global coordinates). */
  dimension: number;
  value: number;
}

export interface TurnFrame {
  kind: "orientation";
  /** The 3-D view's orientation (x, y, z, w), as Neuroglancer keeps it. */
  orientation: Quaternion;
}

export type CaptureFrame = SweepFrame | TurnFrame | { kind: "still" };

/**
 * The positions of a sweep from `from` to `to` (inclusive) every `step`
 * along a dimension; voxel centres when the bounds are voxel edges.
 */
export function sweepFrames(dimension: number, from: number, to: number, step: number): SweepFrame[] {
  if (!(step > 0) || !Number.isFinite(from) || !Number.isFinite(to)) return [];
  const direction = to >= from ? 1 : -1;
  const count = Math.floor(Math.abs(to - from) / step + 1e-9) + 1;
  return Array.from({ length: count }, (_, i) => ({ kind: "position" as const, dimension, value: from + direction * i * step }));
}

/** Hamilton product a × b, for (x, y, z, w) quaternions. */
export function multiply(a: Quaternion, b: Quaternion): Quaternion {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz];
}

/** A rotation by `angle` radians about a unit axis. */
export function axisAngle(axis: [number, number, number], angle: number): Quaternion {
  const s = Math.sin(angle / 2);
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2)];
}

/**
 * A turntable: `count` orientations turning once around the view's own
 * vertical axis (as it is at the start), evenly, the first the start.
 * Neuroglancer's orientation turns view coordinates into the world's, so a
 * turn about the view's axis is applied on the right.
 */
export function turntableFrames(start: Quaternion, count: number, degrees = 360, axis: [number, number, number] = [0, 1, 0]): TurnFrame[] {
  const n = Math.max(1, Math.round(count));
  return Array.from({ length: n }, (_, i) => ({ kind: "orientation" as const, orientation: multiply(start, axisAngle(axis, ((degrees * Math.PI) / 180) * (i / n))) }));
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The smallest box holding every pixel that differs from the background
 * (the colour of the image's corners when three agree, else the top left),
 * with `margin` pixels kept around it; the whole image when it is empty.
 */
export function trimBox(data: Uint8ClampedArray | Uint8Array, width: number, height: number, margin = 0, tolerance = 8): Box {
  const at = (x: number, y: number) => (y * width + x) * 4;
  const corners = [at(0, 0), at(width - 1, 0), at(0, height - 1), at(width - 1, height - 1)];
  const same = (i: number, j: number) => Math.abs(data[i] - data[j]) <= tolerance && Math.abs(data[i + 1] - data[j + 1]) <= tolerance && Math.abs(data[i + 2] - data[j + 2]) <= tolerance;
  const background = corners.find((c) => corners.filter((d) => same(c, d)).length >= 3) ?? corners[0];
  const bg = [data[background], data[background + 1], data[background + 2]];
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; ++y) {
    for (let x = 0; x < width; ++x) {
      const i = at(x, y);
      if (Math.abs(data[i] - bg[0]) > tolerance || Math.abs(data[i + 1] - bg[1]) > tolerance || Math.abs(data[i + 2] - bg[2]) > tolerance) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return { x: 0, y: 0, width, height };
  x0 = Math.max(0, x0 - margin);
  y0 = Math.max(0, y0 - margin);
  x1 = Math.min(width - 1, x1 + margin);
  y1 = Math.min(height - 1, y1 + margin);
  return { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

/** The union of boxes (a movie trims every frame alike, so it does not jump). */
export function unionBox(boxes: Box[]): Box | undefined {
  if (boxes.length === 0) return undefined;
  const x0 = Math.min(...boxes.map((b) => b.x));
  const y0 = Math.min(...boxes.map((b) => b.y));
  const x1 = Math.max(...boxes.map((b) => b.x + b.width));
  const y1 = Math.max(...boxes.map((b) => b.y + b.height));
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** Even sizes, as H.264 needs: a box grown (or shrunk at the image's edge) by a pixel. */
export function evenBox(box: Box, width: number, height: number): Box {
  const fix = (start: number, size: number, limit: number): [number, number] => {
    if (size % 2 === 0) return [start, size];
    if (start + size < limit) return [start, size + 1];
    if (start > 0) return [start - 1, size + 1];
    return [start, size - 1];
  };
  const [x, w] = fix(box.x, box.width, width);
  const [y, h] = fix(box.y, box.height, height);
  return { x, y, width: Math.max(2, w), height: Math.max(2, h) };
}

/** frame_0001.png …: numbers padded to the count's width (at least four digits). */
export function frameName(prefix: string, index: number, count: number, extension = "png"): string {
  const digits = Math.max(4, String(count).length);
  return `${prefix}${String(index + 1).padStart(digits, "0")}.${extension}`;
}

/** A file name from the time, for captures: ngplatform-2026-11-02-231500. */
export function captureName(date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `ngplatform-${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}
