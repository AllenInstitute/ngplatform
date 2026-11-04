/**
 * Track filtering, the computation: which objects pass a set of attribute
 * ranges and group choices.  Pure functions over segment-property columns,
 * so they are tested without a viewer.
 */
import type { SegmentProperties } from "@ngplatform/sdk";
import { csvField } from "@ngplatform/sdk/format";

export interface FilterSpec {
  /** Property id → inclusive [min, max]; a property without one is not filtered. */
  ranges: Record<string, [number, number]>;
  /** Tags an object must have at least one of; empty means any. */
  includeTags: string[];
  /** Tags an object must have none of. */
  excludeTags: string[];
}

export function emptyFilter(): FilterSpec {
  return { ranges: {}, includeTags: [], excludeTags: [] };
}

export function isEmptyFilter(spec: FilterSpec): boolean {
  return Object.keys(spec.ranges).length === 0 && spec.includeTags.length === 0 && spec.excludeTags.length === 0;
}

/** One byte per object: 1 when it passes. */
export function computeMask(props: SegmentProperties, spec: FilterSpec): Uint8Array {
  const n = props.ids.length;
  const mask = new Uint8Array(n).fill(1);
  for (const [id, [lo, hi]] of Object.entries(spec.ranges)) {
    const column = props.numeric.find((p) => p.id === id);
    if (column === undefined) continue;
    const values = column.values;
    for (let i = 0; i < n; ++i) {
      if (mask[i] === 0) continue;
      const v = values[i];
      // A missing value (NaN) cannot be inside a range.
      if (!(v >= lo && v <= hi)) mask[i] = 0;
    }
  }
  const tags = props.tags;
  if (tags !== undefined && (spec.includeTags.length > 0 || spec.excludeTags.length > 0)) {
    const codes = (names: string[]) =>
      new Set(names.map((name) => tags.names.indexOf(name)).filter((i) => i >= 0));
    const include = codes(spec.includeTags);
    const exclude = codes(spec.excludeTags);
    for (let i = 0; i < n; ++i) {
      if (mask[i] === 0) continue;
      const value = tags.values[i] ?? "";
      let hasIncluded = include.size === 0;
      for (let k = 0; k < value.length; ++k) {
        const code = value.charCodeAt(k);
        if (exclude.has(code)) {
          mask[i] = 0;
          break;
        }
        if (include.has(code)) hasIncluded = true;
      }
      if (mask[i] === 1 && !hasIncluded) mask[i] = 0;
    }
  } else if (spec.includeTags.length > 0) {
    mask.fill(0);
  }
  return mask;
}

/** The ids of the objects that pass. */
export function passingIds(props: SegmentProperties, mask: Uint8Array): BigUint64Array {
  let count = 0;
  for (let i = 0; i < mask.length; ++i) count += mask[i];
  const out = new BigUint64Array(count);
  for (let i = 0, j = 0; i < mask.length; ++i) if (mask[i]) out[j++] = props.ids[i];
  return out;
}

export function countPassing(mask: Uint8Array): number {
  let count = 0;
  for (let i = 0; i < mask.length; ++i) count += mask[i];
  return count;
}

/** Counts per bin over [min, max] of the finite values, optionally only where `mask` is set. */
export function histogram(values: ArrayLike<number>, min: number, max: number, bins: number, mask?: Uint8Array): Uint32Array {
  const out = new Uint32Array(bins);
  const span = max - min;
  for (let i = 0; i < values.length; ++i) {
    if (mask !== undefined && mask[i] === 0) continue;
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    const b = span > 0 ? Math.min(bins - 1, Math.max(0, Math.floor(((v - min) / span) * bins))) : 0;
    out[b]++;
  }
  return out;
}

/** How many objects carry each tag, optionally only where `mask` is set. */
export function tagCounts(props: SegmentProperties, mask?: Uint8Array): Uint32Array {
  const tags = props.tags;
  const out = new Uint32Array(tags?.names.length ?? 0);
  if (tags === undefined) return out;
  for (let i = 0; i < tags.values.length; ++i) {
    if (mask !== undefined && mask[i] === 0) continue;
    const value = tags.values[i];
    for (let k = 0; k < value.length; ++k) out[value.charCodeAt(k)]++;
  }
  return out;
}

/** CSV of the passing objects: id, then every numeric column, then tags. */
export function toCsv(props: SegmentProperties, mask: Uint8Array): string {
  const header = ["id", ...props.numeric.map((p) => p.id), ...(props.tags ? ["tags"] : [])];
  const lines = [header.map(csvField).join(",")];
  for (let i = 0; i < mask.length; ++i) {
    if (!mask[i]) continue;
    const row = [props.ids[i].toString(), ...props.numeric.map((p) => (Number.isFinite(p.values[i]) ? String(p.values[i]) : ""))];
    if (props.tags) {
      const value = props.tags.values[i] ?? "";
      row.push(
        Array.from(value)
          .map((c) => props.tags!.names[c.charCodeAt(0)])
          .join(";"),
      );
    }
    lines.push(row.map(csvField).join(","));
  }
  return lines.join("\n") + "\n";
}

export interface ColumnStatistics {
  id: string;
  /** Over the passing objects with a finite value. */
  n: number;
  mean: number;
  sd: number;
  median: number;
  min: number;
  max: number;
}

/** Each numeric column's statistics over the passing objects (NaN where none has a value). */
export function groupStatistics(props: SegmentProperties, mask: Uint8Array): ColumnStatistics[] {
  return props.numeric.map(({ id, values }) => {
    const picked: number[] = [];
    for (let i = 0; i < mask.length; ++i) if (mask[i] && Number.isFinite(values[i])) picked.push(values[i]);
    const n = picked.length;
    if (n === 0) return { id, n, mean: NaN, sd: NaN, median: NaN, min: NaN, max: NaN };
    picked.sort((a, b) => a - b);
    let sum = 0;
    for (const v of picked) sum += v;
    const mean = sum / n;
    let squares = 0;
    for (const v of picked) squares += (v - mean) ** 2;
    const median = n % 2 === 1 ? picked[(n - 1) / 2] : (picked[n / 2 - 1] + picked[n / 2]) / 2;
    return { id, n, mean, sd: n > 1 ? Math.sqrt(squares / (n - 1)) : 0, median, min: picked[0], max: picked[n - 1] };
  });
}

/** CSV of groups' statistics: a row per group and column (group, objects, column, n, mean, sd, median, min, max). */
export function statisticsCsv(groups: { name: string; count: number; columns: ColumnStatistics[] }[]): string {
  const number = (v: number) => (Number.isFinite(v) ? String(Number(v.toPrecision(7))) : "");
  const lines = ["group,objects,attribute,n,mean,sd,median,min,max"];
  for (const g of groups) {
    if (g.columns.length === 0) lines.push([csvField(g.name), g.count, "", "", "", "", "", "", ""].join(","));
    for (const c of g.columns) lines.push([csvField(g.name), g.count, csvField(c.id), c.n, number(c.mean), number(c.sd), number(c.median), number(c.min), number(c.max)].join(","));
  }
  return lines.join("\n") + "\n";
}
