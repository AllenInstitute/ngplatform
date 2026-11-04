/**
 * Small pieces the Annotations tab's sections share: numbers with units,
 * file names and a CSV table (elements and controls: @ngplatform/sdk/dom).
 */
import { safeFileName } from "@ngplatform/sdk/dom";

// ------------------------------------------------------------- numbers

/** A number with about four significant figures, without a trailing exponent where it can do without. */
export function fmt(v: number, digits = 4): string {
  if (!Number.isFinite(v)) return "–";
  if (v === 0) return "0";
  const a = Math.abs(v);
  if (a >= 1e6 || a < 1e-3) return v.toExponential(digits - 1);
  return String(Number(v.toPrecision(digits)));
}

/**
 * A physical quantity in millimetres to the power `power` (1 a length, 2
 * an area, 3 a volume), in the unit that suits its size: nm, µm, mm or m.
 */
export function physical(mm: number, power: 1 | 2 | 3 = 1): string {
  const units: [string, number][] = [
    ["m", 1e3],
    ["mm", 1],
    ["µm", 1e-3],
    ["nm", 1e-6],
  ];
  const sup = power === 1 ? "" : power === 2 ? "²" : "³";
  const a = Math.abs(mm);
  // The largest unit the value is not too small in: 0.1 of a length, 0.001 of a volume.
  const least = 0.1 ** power;
  for (const [name, size] of units) {
    if (a >= size ** power * least || name === "nm") return `${fmt(mm / size ** power)} ${name}${sup}`;
  }
  return `${fmt(mm)} mm${sup}`;
}

// --------------------------------------------------------------- files

/** A file name from a layer's or label's name. */
export const fileName = (name: string) => safeFileName(name, "annotations");
