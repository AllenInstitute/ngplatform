/**
 * Which plugins are on.
 *
 * Every plugin the app ships is in the catalogue (src/plugins/catalogue.ts).
 * Whether each is on is this browser's choice, kept in local storage and
 * defaulting to the manifest's `enabledByDefault`.  A plugin whose required
 * plugins are not all on is off, whatever was chosen.  Changing a choice
 * takes effect on the next page load: the Plugins tab reloads the page with
 * the same link, so a data type's Neuroglancer modules (and its worker code)
 * are loaded, or not, from the start.
 */
import type { Manifest } from "../sdk/types.js";

export type Choices = Record<string, boolean>;

type Entry = Pick<Manifest, "id" | "kind" | "enabledByDefault" | "requires">;

const STORAGE_KEY = "ngplatform.plugins.enabled";

export function loadChoices(): Choices {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw === null ? {} : JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as Choices) : {};
  } catch {
    return {};
  }
}

export function saveChoices(choices: Choices): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(choices));
  } catch {
    // Storage refused: the choice lasts only until the reload.
  }
}

function chosen(entry: Entry, choices: Choices): boolean {
  return choices[entry.id] ?? entry.enabledByDefault ?? false;
}

export interface Resolution {
  /** Plugins that are on. */
  enabled: Set<string>;
  /** Plugins chosen on but off because a requirement is off (or missing). */
  blocked: Map<string, string[]>;
}

/** Which plugins are on, given the choices and the requirements. */
export function resolveEnabled(entries: Entry[], choices: Choices): Resolution {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const enabled = new Set(entries.filter((e) => chosen(e, choices)).map((e) => e.id));
  const blocked = new Map<string, string[]>();
  // Drop plugins whose requirements are off, until nothing changes (a chain
  // of requirements falls in one pass per link).
  for (let changed = true; changed; ) {
    changed = false;
    for (const id of [...enabled]) {
      const missing = (byId.get(id)?.requires?.plugins ?? []).filter((r) => !enabled.has(r));
      if (missing.length > 0) {
        enabled.delete(id);
        blocked.set(id, missing);
        changed = true;
      }
    }
  }
  return { enabled, blocked };
}

/** Everything `id` requires, directly or through another plugin. */
function requirementsOf(entries: Entry[], id: string, seen = new Set<string>()): string[] {
  for (const r of entries.find((e) => e.id === id)?.requires?.plugins ?? []) {
    if (seen.has(r)) continue;
    seen.add(r);
    requirementsOf(entries, r, seen);
  }
  return [...seen];
}

/** Everything that requires `id`, directly or through another plugin. */
function dependentsOf(entries: Entry[], id: string): string[] {
  return entries.filter((e) => e.id !== id && requirementsOf(entries, e.id).includes(id)).map((e) => e.id);
}

/**
 * The choices after switching `id` on or off.  Switching on also switches
 * on what it requires; switching off also switches off what requires it.
 * `also` lists the other plugins that changes, for the confirmation.
 */
export function toggle(entries: Entry[], choices: Choices, id: string, on: boolean): { choices: Choices; also: string[] } {
  const before = resolveEnabled(entries, choices).enabled;
  const next: Choices = { ...choices, [id]: on };
  const related = on ? requirementsOf(entries, id) : dependentsOf(entries, id);
  for (const other of related) next[other] = on;
  const after = resolveEnabled(entries, next).enabled;
  const also = entries.map((e) => e.id).filter((other) => other !== id && before.has(other) !== after.has(other));
  return { choices: next, also };
}
