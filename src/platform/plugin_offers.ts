/**
 * Offers of tool plugins that are off: which to look for, which to show in
 * a toast, and what this browser said ("Not now", offers off).  The data
 * each plugin serves is its offer's (plugins/offers.ts); the toasts and the
 * Datasets tab's buttons are src/ui/plugin_offers.ts.
 *
 * - A plugin is looked for while it is off, has an offer, and this browser
 *   neither said "Not now" to it nor switched offers off (Settings).
 * - A `toast` offer is shown in a toast once per browser; every offer that
 *   applies is listed in the Datasets tab until it is turned on or "Not now".
 * - A workspace that holds state of a plugin that is off says so (whatever
 *   the offers), and keeps that state.
 */
import type { Manifest } from "../sdk/types.js";

const KEY = "ngplatform.offers";

export interface OfferPrefs {
  /** Settings → "Show offers for tools that are off", unticked. */
  off: boolean;
  /** "Not now", by plugin. */
  dismissed: string[];
  /** Plugins already offered in a toast. */
  toasted: string[];
}

type Store = Pick<Storage, "getItem" | "setItem">;

const strings = (x: unknown): string[] => (Array.isArray(x) ? x.filter((s): s is string => typeof s === "string") : []);

export function loadOfferPrefs(storage: Store | undefined = globalThis.localStorage): OfferPrefs {
  try {
    const raw = JSON.parse(storage?.getItem(KEY) ?? "{}") as Partial<OfferPrefs>;
    return { off: raw.off === true, dismissed: strings(raw.dismissed), toasted: strings(raw.toasted) };
  } catch {
    return { off: false, dismissed: [], toasted: [] };
  }
}

export function saveOfferPrefs(prefs: OfferPrefs, storage: Store | undefined = globalThis.localStorage): void {
  try {
    storage?.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // Storage refused: kept for this page only.
  }
}

/** Plugins whose offers to look for: off (not merely blocked), with an offer, not "Not now", offers on. */
export function offerCandidates(entries: { id: string; hasOffer: boolean }[], enabled: ReadonlySet<string>, prefs: OfferPrefs): string[] {
  if (prefs.off) return [];
  return entries.filter((e) => e.hasOffer && !enabled.has(e.id) && !prefs.dismissed.includes(e.id)).map((e) => e.id);
}

/** Of the offers that apply, those to show in a toast now: `toast` ones not shown before, nor named by the workspace notice. */
export function offersToToast(applicable: string[], isToast: (id: string) => boolean, prefs: OfferPrefs, noticed: Iterable<string> = []): string[] {
  const skip = new Set(noticed);
  return applicable.filter((id) => isToast(id) && !prefs.toasted.includes(id) && !skip.has(id));
}

/** Whether a plugin's slice of the workspace holds anything (an empty object or list is nothing). */
export function holdsState(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

/** Plugins that are off whose state the workspace holds. */
export function offWithState(manifests: Manifest[], enabled: ReadonlySet<string>, slice: (key: string) => unknown): string[] {
  return manifests
    .filter((m) => !enabled.has(m.id))
    .filter((m) => {
      const key = m.contributes?.appState?.key;
      return key !== undefined && holdsState(slice(key));
    })
    .map((m) => m.id);
}

/** "A", "A and B", "A, B and C". */
export function listNames(names: string[]): string {
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
