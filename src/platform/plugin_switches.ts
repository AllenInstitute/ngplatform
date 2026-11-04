/**
 * Which plugins are on.
 *
 * Every plugin the app ships is in the catalogue (plugins/index.ts).
 * Whether each is on is this browser's choice, kept in local storage and
 * defaulting to the manifest's `enabledByDefault` (only Zarr Vectors is on
 * by default).  An example can switch a plugin on for this tab only (kept
 * in session storage), unless this browser chose it off.  A plugin whose
 * required plugins are not all on is off, whatever was chosen.
 *
 * A tool plugin switched on takes effect at once (`PluginHost.switchOn`).
 * A data type plugin switched on, and any plugin switched off, takes
 * effect on the next page load: the page reloads with the same link, so a
 * data type's Neuroglancer modules (and its worker code) are loaded, or
 * not, from the start.
 */
import type { Manifest } from "../sdk/types.js";

export type Choices = Record<string, boolean>;

type Entry = Pick<Manifest, "id" | "kind" | "enabledByDefault" | "requires">;

const STORAGE_KEY = "ngplatform.plugins.enabled";
/** Session storage: plugins an example switched on for this tab. */
const THIS_TAB_KEY = "ngplatform.plugins.thisTab";
/** Set once this browser has started with the defaults of November 2026. */
const DEFAULTS_KEY = "ngplatform.plugins.defaults";
const DEFAULTS_VERSION = "2";

/**
 * Tool plugins that were on by default until November 2026, when every
 * plugin but Zarr Vectors became off by default.
 */
export const FORMERLY_ON = ["org.ngplatform.track-filtering", "org.ngplatform.annotations", "org.ngplatform.segmentation"];

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

export function loadThisTab(): Set<string> {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(THIS_TAB_KEY) ?? "[]");
    return new Set(Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

export function saveThisTab(ids: ReadonlySet<string>): void {
  try {
    sessionStorage.setItem(THIS_TAB_KEY, JSON.stringify([...ids]));
  } catch {
    // Storage refused: on for this page only.
  }
}

function chosen(entry: Entry, choices: Choices, thisTab: ReadonlySet<string>): boolean {
  return choices[entry.id] ?? (thisTab.has(entry.id) || (entry.enabledByDefault ?? false));
}

export interface Resolution {
  /** Plugins that are on. */
  enabled: Set<string>;
  /** Plugins chosen on but off because a requirement is off (or missing). */
  blocked: Map<string, string[]>;
}

/** Which plugins are on, given the choices, what is on for this tab, and the requirements. */
export function resolveEnabled(entries: Entry[], choices: Choices, thisTab: ReadonlySet<string> = new Set()): Resolution {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const enabled = new Set(entries.filter((e) => chosen(e, choices, thisTab)).map((e) => e.id));
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
 * `also` lists the other plugins that changes, for the confirmation;
 * `switchedOn` every plugin that is on after and was not before.
 */
export function toggle(
  entries: Entry[],
  choices: Choices,
  id: string,
  on: boolean,
  thisTab: ReadonlySet<string> = new Set(),
): { choices: Choices; also: string[]; switchedOn: string[] } {
  const before = resolveEnabled(entries, choices, thisTab).enabled;
  const next: Choices = { ...choices, [id]: on };
  const related = on ? requirementsOf(entries, id) : dependentsOf(entries, id);
  for (const other of related) next[other] = on;
  const after = resolveEnabled(entries, next, thisTab).enabled;
  const also = entries.map((e) => e.id).filter((other) => other !== id && before.has(other) !== after.has(other));
  const switchedOn = entries.map((e) => e.id).filter((other) => after.has(other) && !before.has(other));
  return { choices: next, also, switchedOn };
}

/**
 * Whether switching these plugins on needs a reload: a data type plugin's
 * Neuroglancer modules load only with the page.  Tool plugins switch on at
 * once.
 */
export function needsReload(entries: Entry[], switchedOn: string[]): boolean {
  return switchedOn.some((id) => entries.find((e) => e.id === id)?.kind === "datatype");
}

/**
 * The plugins to tell a returning visitor are now off: those that were on
 * by default, that this browser never chose either way and that are not on.
 * Told once (`noteDefaultsTold`); nothing on a first visit.
 */
export function formerlyOnNowOff(entries: Entry[], choices: Choices, enabled: ReadonlySet<string>, returning: boolean, told: boolean): string[] {
  if (!returning || told) return [];
  return FORMERLY_ON.filter((id) => entries.some((e) => e.id === id) && choices[id] === undefined && !enabled.has(id));
}

/** Whether this browser was told of the new defaults (or started with them). */
export function defaultsTold(): boolean {
  try {
    return localStorage.getItem(DEFAULTS_KEY) === DEFAULTS_VERSION;
  } catch {
    return true;
  }
}

export function noteDefaultsTold(): void {
  try {
    localStorage.setItem(DEFAULTS_KEY, DEFAULTS_VERSION);
  } catch {
    // Storage refused: nothing to remember it in.
  }
}

/**
 * Whether this browser has used the app before: the docks keep the tab
 * each shows (`ngplatform.left.tab`…), written on every visit.
 */
export function returningVisitor(): boolean {
  try {
    return ["left", "right", "bottom"].some((slot) => localStorage.getItem(`ngplatform.${slot}.tab`) !== null);
  } catch {
    return false;
  }
}
