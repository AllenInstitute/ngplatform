/**
 * Numbers and tables as text, for plugins (and the shell):
 *
 *     import { csv, ticks } from "@ngplatform/sdk/format";
 */

/** A CSV field: quoted when it holds a comma, a quote or a line break. */
export function csvField(text: string): string {
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Rows as CSV text, a line break after each; numbers that are not finite are empty. */
export function csv(rows: (string | number)[][]): string {
  const cell = (v: string | number) => csvField(typeof v === "number" ? (Number.isFinite(v) ? String(v) : "") : v);
  return rows.map((r) => r.map(cell).join(",")).join("\n") + "\n";
}

/** About `count` round tick values (1, 2 or 5 × a power of ten apart) covering [lo, hi]. */
export function ticks(lo: number, hi: number, count = 4): number[] {
  if (!(hi > lo)) return [lo];
  const raw = (hi - lo) / count;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * power).find((s) => s >= raw * (1 - 1e-9)) ?? raw;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + step * 1e-9; v += step) out.push(Number(v.toPrecision(12)));
  return out;
}

/** A length in millimetres: "1.25 mm" from 1 mm up, "250 µm" below. */
export function mmText(mm: number): string {
  return mm >= 1 ? `${+mm.toFixed(2)} mm` : `${Math.round(mm * 1000)} µm`;
}

/** A size in bytes (powers of 1024): "1.5 TB", "2.0 GB", "350 MB", "12 KB". */
export function bytesText(bytes: number): string {
  if (bytes >= 2 ** 40) return `${(bytes / 2 ** 40).toFixed(1)} TB`;
  if (bytes >= 2 ** 30) return `${(bytes / 2 ** 30).toFixed(1)} GB`;
  if (bytes >= 2 ** 20) return `${(bytes / 2 ** 20).toFixed(0)} MB`;
  return `${Math.ceil(bytes / 2 ** 10)} KB`;
}
