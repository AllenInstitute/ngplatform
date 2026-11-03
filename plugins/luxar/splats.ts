/**
 * Gaussian splats made from an image's voxels, with no fitting: each cell
 * of `cell`³ voxels with something in it becomes one Gaussian whose
 * centre, covariance and weight match the cell's intensity (its first and
 * second moments, and its mean), so the splats are a faithful blur of the
 * voxels at the level read.  A coarser level makes fewer, larger splats:
 * one Gaussian pyramid per resolution, made as the blocks are read.
 *
 * Intensity is the value above the background (dark images; the window
 * makes it 0..1), so empty space makes no splats.  A cell's covariance is
 * never smaller than a voxel's own spread (a box of one voxel has variance
 * 1/12 along each axis), so a cell of one bright voxel is a voxel-sized
 * blob, not a point.
 */

export interface Splats {
  /** Centres, x y z each, in the block's voxel coordinates (voxel centres at integers). */
  centres: Float32Array;
  /** Covariances, xx xy xz yy yz zz each, in voxels². */
  covariances: Float32Array;
  /**
   * Each splat's brightness (0..1): its Gaussian's peak, the cell's mass over
   * √((2π)³ det Σ), scaled so a cell filled evenly at full intensity gives 1
   * (a thin bright tube keeps its brightness; an average over the cell would
   * not); and its mass (summed intensity, in voxels).
   */
  weights: Float32Array;
  masses: Float32Array;
  count: number;
}

/** A voxel's own variance along an axis: a uniform box one voxel wide. */
const VOXEL_VARIANCE = 1 / 12;

/**
 * The splats of a block of voxels (x fastest, values 0..1 above the
 * background): one per `cell`³ cell whose summed intensity is at least
 * `minMass` (voxels' worth of full intensity).
 */
export function splatsOfBlock(values: ArrayLike<number>, size: [number, number, number], cell: number, minMass = 0.5): Splats {
  const [nx, ny, nz] = size;
  const cells = size.map((n) => Math.ceil(n / cell));
  const capacity = cells[0] * cells[1] * cells[2];
  const centres = new Float32Array(3 * capacity);
  const covariances = new Float32Array(6 * capacity);
  const weights = new Float32Array(capacity);
  const masses = new Float32Array(capacity);
  let count = 0;
  // The peak of the Gaussian matching a cell filled evenly at full intensity: what a weight of 1 is.
  const even = (cell * cell) / 12 + VOXEL_VARIANCE;
  const fullPeak = cell ** 3 / Math.sqrt((2 * Math.PI) ** 3 * even ** 3);
  for (let cz = 0; cz < cells[2]; ++cz) {
    for (let cy = 0; cy < cells[1]; ++cy) {
      for (let cx = 0; cx < cells[0]; ++cx) {
        const x0 = cx * cell;
        const y0 = cy * cell;
        const z0 = cz * cell;
        const x1 = Math.min(nx, x0 + cell);
        const y1 = Math.min(ny, y0 + cell);
        const z1 = Math.min(nz, z0 + cell);
        // Moments about the cell's corner, for precision.
        let m = 0;
        let sx = 0;
        let sy = 0;
        let sz = 0;
        let sxx = 0;
        let sxy = 0;
        let sxz = 0;
        let syy = 0;
        let syz = 0;
        let szz = 0;
        for (let z = z0; z < z1; ++z) {
          const dz = z - z0;
          for (let y = y0; y < y1; ++y) {
            const dy = y - y0;
            let at = x0 + nx * (y + ny * z);
            for (let x = x0; x < x1; ++x, ++at) {
              const w = values[at];
              if (!(w > 0)) continue;
              const dx = x - x0;
              m += w;
              sx += w * dx;
              sy += w * dy;
              sz += w * dz;
              sxx += w * dx * dx;
              sxy += w * dx * dy;
              sxz += w * dx * dz;
              syy += w * dy * dy;
              syz += w * dy * dz;
              szz += w * dz * dz;
            }
          }
        }
        if (m < minMass) continue;
        const mx = sx / m;
        const my = sy / m;
        const mz = sz / m;
        centres[3 * count] = x0 + mx;
        centres[3 * count + 1] = y0 + my;
        centres[3 * count + 2] = z0 + mz;
        const c = 6 * count;
        covariances[c] = sxx / m - mx * mx + VOXEL_VARIANCE;
        covariances[c + 1] = sxy / m - mx * my;
        covariances[c + 2] = sxz / m - mx * mz;
        covariances[c + 3] = syy / m - my * my + VOXEL_VARIANCE;
        covariances[c + 4] = syz / m - my * mz;
        covariances[c + 5] = szz / m - mz * mz + VOXEL_VARIANCE;
        const [a, b, c2, d, e, f] = covariances.subarray(c, c + 6);
        const det = a * (d * f - e * e) - b * (b * f - e * c2) + c2 * (b * e - d * c2);
        weights[count] = Math.min(1, (m / Math.sqrt((2 * Math.PI) ** 3 * Math.max(det, 1e-12))) / fullPeak);
        masses[count] = m;
        ++count;
      }
    }
  }
  return { centres: centres.slice(0, 3 * count), covariances: covariances.slice(0, 6 * count), weights: weights.slice(0, count), masses: masses.slice(0, count), count };
}

/**
 * Splats moved from a block's voxels to world coordinates by `voxelToWorld`
 * (row-major 4 × 4, the block's voxel 0 at its origin): centres through
 * the affine, covariances as A Σ Aᵀ.
 */
export function splatsToWorld(s: Splats, voxelToWorld: ArrayLike<number>): Splats {
  const a = voxelToWorld;
  const centres = new Float32Array(s.centres.length);
  const covariances = new Float32Array(s.covariances.length);
  for (let i = 0; i < s.count; ++i) {
    const p = [s.centres[3 * i], s.centres[3 * i + 1], s.centres[3 * i + 2]];
    for (let r = 0; r < 3; ++r) centres[3 * i + r] = a[4 * r] * p[0] + a[4 * r + 1] * p[1] + a[4 * r + 2] * p[2] + a[4 * r + 3];
    const v = s.covariances.subarray(6 * i, 6 * i + 6);
    const S = [
      [v[0], v[1], v[2]],
      [v[1], v[3], v[4]],
      [v[2], v[4], v[5]],
    ];
    // A Σ Aᵀ, kept as its upper triangle.
    const AS = [0, 1, 2].map((r) => [0, 1, 2].map((c) => a[4 * r] * S[0][c] + a[4 * r + 1] * S[1][c] + a[4 * r + 2] * S[2][c]));
    const out = (r: number, c: number) => AS[r][0] * a[4 * c] + AS[r][1] * a[4 * c + 1] + AS[r][2] * a[4 * c + 2];
    covariances.set([out(0, 0), out(0, 1), out(0, 2), out(1, 1), out(1, 2), out(2, 2)], 6 * i);
  }
  return { ...s, centres, covariances };
}
