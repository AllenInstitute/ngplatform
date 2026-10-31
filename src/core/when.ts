/**
 * `when` clauses: whether a command, key binding or panel applies right now,
 * judged against context keys the platform and plugins set.
 *
 *   hasLayers
 *   !sceneIsEmpty
 *   selectedLayerType == segmentation
 *   selectedLayerType != image && hasLayers
 *   datasetKind == zarr-vectors || datasetKind == image
 *
 * `&&` binds tighter than `||`.  Values compare as strings; a bare key is
 * true when its value is truthy.
 */

export type ContextValues = Record<string, unknown>;

function term(text: string, context: ContextValues): boolean {
  const t = text.trim();
  if (t === "") return true;
  if (t === "true") return true;
  if (t === "false") return false;
  const cmp = t.match(/^(!?[\w.:-]+)\s*(==|!=)\s*(.+)$/);
  if (cmp) {
    const [, key, op, raw] = cmp;
    const value = raw.trim().replace(/^(['"])(.*)\1$/, "$2");
    const actual = context[key];
    const equal = actual !== undefined && actual !== null && String(actual) === value;
    return op === "==" ? equal : !equal;
  }
  if (t.startsWith("!")) return !term(t.slice(1), context);
  return Boolean(context[t]);
}

export function evaluateWhen(expression: string | undefined, context: ContextValues): boolean {
  if (expression === undefined || expression.trim() === "") return true;
  return expression.split("||").some((alternative) => alternative.split("&&").every((part) => term(part, context)));
}

/** The keys an expression reads, for checking that a plugin declared them. */
export function whenKeys(expression: string | undefined): string[] {
  if (expression === undefined) return [];
  const keys = new Set<string>();
  for (const part of expression.split(/\|\||&&/)) {
    const m = part.trim().replace(/^!+/, "").match(/^([\w.:-]+)/);
    if (m && m[1] !== "true" && m[1] !== "false") keys.add(m[1]);
  }
  return [...keys];
}

/** The context keys: set by the platform and plugins, read by `when` clauses. */
export class ContextKeys {
  private values: ContextValues = {};
  private listeners = new Set<() => void>();

  set(key: string, value: unknown): void {
    if (this.values[key] === value) return;
    this.values = { ...this.values, [key]: value };
    for (const listener of this.listeners) listener();
  }

  get(key: string): unknown {
    return this.values[key];
  }

  all(): ContextValues {
    return this.values;
  }

  matches(expression: string | undefined): boolean {
    return evaluateWhen(expression, this.values);
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
