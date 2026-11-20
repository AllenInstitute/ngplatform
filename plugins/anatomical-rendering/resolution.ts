/**
 * Which levels of an image the path tracer draws, and how much of the image each covers: for the Rendering card's
 * chart (as Neuroglancer's resolution charts show which levels its views draw). Pure.
 *
 * In this browser one level is drawn, all of the image. A render computer draws one level for all of it and, with
 * Finer detail, a finer level's region where the view looks: that region covers its share of the image (its box's
 * voxels over the level's), the base level the rest.
 */

export interface LevelRow {
  path: string;
  /** Voxels along x, y and z. */
  size: number[];
  /** The voxel's side, mm (the mean of its edges). */
  voxelMm: number;
}

export interface ResolutionUse {
  /** The image's levels, finest first. */
  levels: LevelRow[];
  /** The share of the image (0…1) each level is drawn over, in the same order. */
  shares: number[];
  /** The levels drawn, in a few words. */
  text: string;
}

/** A length in mm as people say it: µm below a millimetre, nm below a micrometre. */
export function lengthText(mm: number): string {
  const fmt = (v: number) => (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toPrecision(2)).replace(/\.0+$/, "");
  if (mm >= 1) return `${fmt(mm)} mm`;
  if (mm >= 1e-3) return `${fmt(mm * 1e3)} µm`;
  return `${fmt(mm * 1e6)} nm`;
}

/**
 * The use of an image's `levels` (any order): `base` drawn over all of it, and `detail` (a finer level and a box of
 * its voxels) over its share, which the base level then gives up. Levels the image does not list are added.
 */
export function resolutionUse(levels: LevelRow[], base: LevelRow, detail?: { level: LevelRow; lo: number[]; hi: number[] }): ResolutionUse {
  const rows = [...levels];
  for (const l of [base, detail?.level]) if (l !== undefined && !rows.some((r) => r.path === l.path)) rows.push(l);
  rows.sort((a, b) => a.voxelMm - b.voxelMm);
  const shares = rows.map(() => 0);
  let rest = 1;
  let detailText = "";
  if (detail !== undefined) {
    const total = detail.level.size.reduce((a, b) => a * Math.max(1, b), 1);
    const box = [0, 1, 2].reduce((a, k) => a * Math.max(0, (detail.hi[k] ?? 0) - (detail.lo[k] ?? 0)), 1);
    const share = total > 0 ? Math.min(1, box / total) : 0;
    shares[rows.findIndex((r) => r.path === detail.level.path)] = share;
    rest = 1 - share;
    detailText = `; ${detail.level.path} (${lengthText(detail.level.voxelMm)}) over ${percent(share)} where the view looks`;
  }
  const b = rows.findIndex((r) => r.path === base.path);
  shares[b] += rest;
  const finest = rows[0];
  const finer = finest !== undefined && finest.path !== base.path && finest.path !== detail?.level.path ? `; the finest, ${finest.path}, is ${lengthText(finest.voxelMm)}` : "";
  const text = `${base.path} (${lengthText(base.voxelMm)}, ${base.size.join(" × ")}) over ${detail ? "the rest" : "all of the image"}${detailText}${finer}`;
  return { levels: rows, shares, text };
}

function percent(f: number): string {
  return f >= 0.1 ? `${Math.round(f * 100)} %` : f >= 0.001 ? `${(f * 100).toFixed(1)} %` : "under 0.1 %";
}

/** The use of an image's levels drawn in the shares given (multiscale: each region at its own level). */
export function resolutionShares(levels: LevelRow[], drawn: { path: string; share: number }[]): ResolutionUse {
  const rows = [...levels].sort((a, b) => a.voxelMm - b.voxelMm);
  const shares = rows.map((r) => drawn.find((d) => d.path === r.path)?.share ?? 0);
  const parts = rows.flatMap((r, i) => (shares[i] > 0 ? [`${r.path} (${lengthText(r.voxelMm)}) over ${percent(shares[i])}`] : []));
  return { levels: rows, shares, text: parts.length > 0 ? `Multiscale: ${parts.join(", ")}` : "Multiscale" };
}
