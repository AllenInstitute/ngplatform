/**
 * Small pieces the Annotations tab's sections share: making elements,
 * numbers with units, files to save, and a CSV table.
 */

type Child = Node | string | null | undefined | false;

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, unknown> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v as EventListener);
    else if (k === "class") e.className = String(v);
    else if (k === "value") (e as HTMLInputElement).value = String(v);
    else e.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) e.append(c);
  return e;
}

export function button(label: string, onclick: () => void, title?: string, cls = "btn outline small"): HTMLButtonElement {
  return el("button", { class: cls, type: "button", title, onclick }, label);
}

/** A select of [value, label] pairs. */
export function select(options: [string, string][], value: string, onchange: (value: string) => void, label?: string): HTMLSelectElement {
  const s = el("select", { class: "text-input", "aria-label": label }) as HTMLSelectElement;
  for (const [v, text] of options) s.append(el("option", { value: v }, text));
  s.value = value;
  s.addEventListener("change", () => onchange(s.value));
  return s;
}

export function numberInput(value: number, onchange: (value: number) => void, attrs: Record<string, unknown> = {}): HTMLInputElement {
  const input = el("input", { class: "text-input an-num", type: "number", value: String(value), ...attrs }) as HTMLInputElement;
  input.addEventListener("change", () => {
    const v = Number(input.value);
    if (Number.isFinite(v)) onchange(v);
  });
  return input;
}

/** A label above a control, as the platform's forms lay them out. */
export function field(label: string, control: Node, hint?: string): HTMLElement {
  return el("label", { class: "field" }, el("span", {}, label), control, hint ? el("span", { class: "field-hint" }, hint) : null);
}

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

/** Rows as CSV text: fields with commas, quotes or line breaks are quoted. */
export function csv(rows: (string | number)[][]): string {
  const cell = (v: string | number) => {
    const s = typeof v === "number" ? (Number.isFinite(v) ? String(v) : "") : v;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(cell).join(",")).join("\n") + "\n";
}

export function download(blob: Blob, name: string): void {
  const a = el("a", { href: URL.createObjectURL(blob), download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

/** A file name from a layer's or label's name. */
export const fileName = (name: string) => name.replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "") || "annotations";
