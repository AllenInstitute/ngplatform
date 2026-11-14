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

/**
 * A size as typed, in bytes (powers of 1024, as bytesText writes it):
 * "512 MB", "2 GB", "1.5g", "64 KiB"; a bare number is in MB.  Undefined
 * when the text is not a size.
 */
export function parseBytes(text: string): number | undefined {
  const m = /^\s*(\d+(?:\.\d*)?|\.\d+)\s*(?:([kmgt])(?:i?b)?|(b))?\s*$/i.exec(text);
  if (m === null) return undefined;
  const power = m[3] !== undefined ? 0 : "kmgt".indexOf((m[2] ?? "m").toLowerCase()) + 1;
  return Math.round(Number(m[1]) * 1024 ** power);
}

/**
 * An address in three parts, as a layer's source line shows it: where
 * (its schemes and host), the path between, and the end of the path (the
 * store's own name), with a pipeline after "|" kept on the end.
 * "zarr3://https://host/a/b/c.ome.zarr/" is where "zarr3://https://host",
 * path "/a/b/", name "c.ome.zarr/".
 */
export function splitAddress(url: string): { where: string; path: string; name: string } {
  const bar = url.indexOf("|");
  const address = bar < 0 ? url : url.slice(0, bar);
  const pipeline = bar < 0 ? "" : url.slice(bar);
  const m = /^((?:[a-z][a-z0-9+.-]*:\/\/)*)([^/]*)(.*)$/i.exec(address)!;
  const [, schemes, host, rest] = m;
  // Nothing after the host ("local://annotations"): the host is the name.
  if (rest.replace(/\/+$/, "") === "") return { where: schemes, path: "", name: host + rest + pipeline };
  const trimmed = rest.replace(/\/+$/, "");
  const cut = trimmed.lastIndexOf("/");
  return { where: schemes + host, path: rest.slice(0, cut + 1), name: rest.slice(cut + 1) + pipeline };
}
