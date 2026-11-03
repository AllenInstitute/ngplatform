/**
 * The sign-in rules of this browser (see ../core/sign_in_rules.ts for what
 * a rule is and how one is chosen), kept in localStorage, never in a link;
 * other tabs' changes are followed.  Also: applying them to the layers a
 * workspace opens with or that are added to it, as the per-layer drop-down
 * would.
 */
import { normalisePrefix, type SignInRule, sourceWithRules } from "../core/sign_in_rules.js";
import { datasetKey, type Json, layerName, layersOf, sourceUrls } from "../core/workspace.js";
import type { Disposer, SourceSignIn } from "../sdk/types.js";

export const RULES_KEY = "ngplatform.auth.rules";

export class SignInRules {
  private listeners = new Set<() => void>();

  constructor(
    private readonly storage: Pick<Storage, "getItem" | "setItem">,
    onStorage?: (listener: (key: string | null) => void) => Disposer,
  ) {
    onStorage?.((key) => {
      if (key === null || key === RULES_KEY) this.changed();
    });
  }

  list(): SignInRule[] {
    try {
      const list = JSON.parse(this.storage.getItem(RULES_KEY) ?? "[]");
      if (!Array.isArray(list)) return [];
      return list
        .filter((r): r is SignInRule => typeof r?.prefix === "string" && typeof r?.signIn === "string")
        .map((r) => ({ prefix: r.prefix, signIn: r.signIn, ...(typeof r.account === "string" ? { account: r.account } : {}) }));
    } catch {
      return [];
    }
  }

  /** Adds a rule, or replaces the one with the same prefix; returns it as kept. */
  set(rule: SignInRule): SignInRule {
    const prefix = normalisePrefix(rule.prefix);
    if (prefix === undefined) throw new Error(`Not a bucket or web address: ${rule.prefix}`);
    const kept: SignInRule = { prefix, signIn: rule.signIn, ...(rule.signIn === "google" && rule.account !== undefined ? { account: rule.account } : {}) };
    const list = this.list();
    const at = list.findIndex((r) => r.prefix === prefix);
    if (at === -1) list.push(kept);
    else list[at] = kept;
    this.write(list);
    return kept;
  }

  remove(prefix: string): void {
    this.write(this.list().filter((r) => r.prefix !== prefix));
  }

  private write(list: SignInRule[]): void {
    list.sort((a, b) => a.prefix.localeCompare(b.prefix));
    this.storage.setItem(RULES_KEY, JSON.stringify(list));
    this.changed();
  }

  onChanged(listener: () => void): Disposer {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

/** What applying rules needs of the workspace store. */
export interface RuleTarget {
  ng(): Json;
  state(): { activeScene: string };
  onChange(listener: () => void): () => void;
  /** Bumped each time a whole workspace is opened. */
  readonly opened: number;
  /** Points layers at the same data read another way, amending the current undo step. */
  setLayerSources(sources: Map<string, unknown>, options: { quiet: true }): void;
}

/**
 * Applies the rules to each layer as it first appears in a scene: when a
 * workspace opens (every layer), when a layer is added, and when a scene
 * is first shown.  A layer whose sign-in the user then changes keeps it
 * until the workspace is opened again.  The change is quiet: it amends the
 * step that added the layer or opened the workspace, so one undo takes
 * both away and the history does not fill with automatic steps.
 */
export function applyRulesToNewLayers(store: RuleTarget, rules: SignInRules, signIns: (sources: string[]) => SourceSignIn[]): Disposer {
  /** The datasets each scene showed when last looked at (a dataset's key leaves the sign-in out). */
  const seen = new Map<string, Set<string>>();
  let opened = store.opened;
  let queued = false;
  const check = () => {
    queued = false;
    if (store.opened !== opened) {
      opened = store.opened;
      seen.clear();
    }
    const scene = store.state().activeScene;
    const before = seen.get(scene) ?? new Set<string>();
    const layers = layersOf(store.ng());
    const now = new Set<string>();
    const list = rules.list();
    const changes = new Map<string, unknown>();
    const offered = list.length > 0 ? signIns(layers.flatMap((l) => sourceUrls(l.source))) : [];
    for (const layer of layers) {
      const key = datasetKey(layer);
      now.add(key);
      if (before.has(key) || list.length === 0) continue;
      const source = sourceWithRules(layer.source, list, offered);
      if (source !== layer.source) changes.set(layerName(layer), source);
    }
    seen.set(scene, now);
    if (changes.size > 0) store.setLayerSources(changes, { quiet: true });
  };
  const schedule = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(check);
  };
  const off = store.onChange(schedule);
  schedule();
  return off;
}
