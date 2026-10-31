/**
 * The JSON Schema subset command arguments, plugin settings and manifests use:
 * enough to validate data and to generate a form from, small enough to keep
 * the platform free of a schema library.
 */

export interface Schema {
  type?: "object" | "array" | "string" | "number" | "integer" | "boolean";
  title?: string;
  description?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  pattern?: string;
  default?: unknown;
  additionalProperties?: boolean | Schema;
}

function typeOf(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  if (typeof value === "number" && Number.isInteger(value)) return "integer";
  return typeof value;
}

/** Returns one message per problem, each naming the path, e.g. "radius: must be at least 0". */
export function validate(schema: Schema, value: unknown, path = ""): string[] {
  const at = path === "" ? "value" : path;
  const errors: string[] = [];
  if (schema.type !== undefined) {
    const actual = typeOf(value);
    const ok =
      schema.type === actual ||
      (schema.type === "number" && actual === "integer");
    if (!ok) return [`${at}: must be ${schema.type === "integer" ? "an integer" : `a${/^[aeiou]/.test(schema.type) ? "n" : ""} ${schema.type}`}`];
  }
  if (schema.enum !== undefined && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
    errors.push(`${at}: must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(", ")}`);
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${at}: must be at least ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${at}: must be at most ${schema.maximum}`);
  }
  if (typeof value === "string" && schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
    errors.push(`${at}: does not match ${schema.pattern}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${at}: needs at least ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${at}: allows at most ${schema.maxItems} items`);
    if (schema.items !== undefined) value.forEach((item, i) => errors.push(...validate(schema.items!, item, `${path}[${i}]`)));
  }
  if (typeOf(value) === "object") {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in obj) || obj[key] === undefined) errors.push(`${path ? path + "." : ""}${key}: is required`);
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (key in obj && obj[key] !== undefined) errors.push(...validate(sub, obj[key], path ? `${path}.${key}` : key));
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(obj)) {
        if (!(key in (schema.properties ?? {}))) errors.push(`${path ? path + "." : ""}${key}: is not allowed`);
      }
    } else if (typeof schema.additionalProperties === "object") {
      for (const key of Object.keys(obj)) {
        if (!(key in (schema.properties ?? {}))) errors.push(...validate(schema.additionalProperties, obj[key], path ? `${path}.${key}` : key));
      }
    }
  }
  return errors;
}

/** Fills in `default`s for absent object properties, recursively. */
export function withDefaults<T>(schema: Schema, value: T): T {
  if (value === undefined && schema.default !== undefined) return structuredClone(schema.default) as T;
  if (schema.properties === undefined || typeOf(value ?? {}) !== "object") return value;
  const obj = { ...((value ?? {}) as Record<string, unknown>) };
  for (const [key, sub] of Object.entries(schema.properties)) {
    const filled = withDefaults(sub, obj[key]);
    if (filled !== undefined) obj[key] = filled;
  }
  return obj as T;
}
