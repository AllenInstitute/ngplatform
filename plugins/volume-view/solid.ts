/**
 * Two helpers kept from the removed Volume rendering tool's solid, which
 * Luxar uses: the background of a coarse level (the mean of its border),
 * and the display coordinates of RAS millimetres in Neuroglancer's 3-D view.
 */
import type { Frame3d } from "@ngplatform/sdk";
import type { Mat4 } from "./ome.js";

/** The mean of the values on a volume's six faces (`data` x fastest). */
export function borderMean(data: Uint8Array, size: [number, number, number]): number {
  const [nx, ny, nz] = size;
  let sum = 0;
  let count = 0;
  for (let z = 0; z < nz; ++z) {
    for (let y = 0; y < ny; ++y) {
      const row = (z * ny + y) * nx;
      if (z === 0 || z === nz - 1 || y === 0 || y === ny - 1) {
        for (let x = 0; x < nx; ++x) sum += data[row + x];
        count += nx;
      } else {
        sum += data[row] + data[row + nx - 1];
        count += 2;
      }
    }
  }
  return count === 0 ? 255 : sum / count;
}

/**
 * Display coordinates of RAS millimetres: one row per displayed dimension
 * (named x, y or z), scaled by its unit.  Undefined when the view does not
 * show x, y and z.
 */
export function displayOfRas(dimensions: Frame3d["dimensions"]): Mat4 | undefined {
  const m = new Float64Array(16);
  m[15] = 1;
  for (let i = 0; i < 3; ++i) {
    const axis = ["x", "y", "z"].indexOf(dimensions.names[i]);
    if (axis === -1) return undefined;
    const unit = dimensions.units[i];
    const metres = unit === "m" ? 1e-3 : 1;
    m[4 * i + axis] = metres / dimensions.scales[i];
  }
  return m;
}
