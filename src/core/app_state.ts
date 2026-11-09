/**
 * Typed, versioned slices of the workspace's `app` state.
 *
 * Each plugin (and the platform itself) owns one key of `app`.  A slice is
 * stored as `{ version, data }`; reading an older version runs the owner's
 * `migrate`, so a link written by an older release opens with its state
 * upgraded.  Writes go through the workspace store, so they are undoable and
 * reach the link like any other change.
 */

export interface SliceSpec<T> {
  key: string;
  version: number;
  /** The value when the workspace holds none. */
  initial: () => T;
  /** Upgrades data stored at `fromVersion` (< version) to the current shape. */
  migrate?: (data: unknown, fromVersion: number) => T;
}

export interface StoredSlice {
  version: number;
  data: unknown;
}

export class SliceError extends Error {}

export function isStoredSlice(value: unknown): value is StoredSlice {
  return typeof value === "object" && value !== null && typeof (value as StoredSlice).version === "number" && "data" in value;
}

/**
 * Why a slice stored at `stored` cannot be read by a release that reads
 * `version`, or undefined when it can.
 */
export function newerSlice(key: string, stored: number, version: number): string | undefined {
  if (stored <= version) return undefined;
  return `The workspace's "${key}" state is version ${stored}, newer than this release reads (${version}).`;
}

/**
 * The slice's value.  An older version without a `migrate` starts afresh,
 * and `report` (when given) is told so: a link must not lose state silently.
 */
export function readSlice<T>(app: Record<string, unknown>, spec: SliceSpec<T>, report?: (message: string) => void): T {
  const stored = app[spec.key];
  if (!isStoredSlice(stored)) return spec.initial();
  if (stored.version === spec.version) return stored.data as T;
  const newer = newerSlice(spec.key, stored.version, spec.version);
  if (newer !== undefined) throw new SliceError(newer);
  if (spec.migrate === undefined) {
    report?.(`The workspace's "${spec.key}" state is version ${stored.version}; this release reads version ${spec.version} and cannot upgrade it, so it starts afresh.`);
    return spec.initial();
  }
  return spec.migrate(stored.data, stored.version);
}

export function writeSlice<T>(app: Record<string, unknown>, spec: SliceSpec<T>, value: T): Record<string, unknown> {
  return { ...app, [spec.key]: { version: spec.version, data: value } satisfies StoredSlice };
}
