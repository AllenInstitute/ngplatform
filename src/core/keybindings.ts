/**
 * The key binding table: which key runs which command, in which context.
 *
 * Bindings are data, so the platform, plugins and (later) user settings all
 * add to the same table; a later binding for the same key and context wins,
 * and the overlap is reported as a conflict.
 */
import { evaluateWhen, type ContextValues } from "./when.js";

export interface KeyBinding {
  /** e.g. "mod+k", "alt+shift+r", "1". "mod" is Cmd on macOS and Ctrl elsewhere. */
  key: string;
  command: string;
  args?: unknown;
  when?: string;
  /** Also fires while typing in a text field (for Mod+K and the like). */
  inInputs?: boolean;
  owner?: string;
}

const MODIFIERS = ["mod", "alt", "shift"];

/** "Mod+Shift+Z" → "mod+shift+z", modifiers in a fixed order. */
export function normaliseKey(key: string): string {
  const parts = key.toLowerCase().split("+").map((p) => p.trim()).filter(Boolean);
  const mods = MODIFIERS.filter((m) => parts.includes(m) || (m === "mod" && (parts.includes("ctrl") || parts.includes("cmd"))));
  const rest = parts.filter((p) => !MODIFIERS.includes(p) && p !== "ctrl" && p !== "cmd");
  return [...mods, ...rest].join("+");
}

export class KeybindingTable {
  private bindings: KeyBinding[] = [];
  private listeners = new Set<() => void>();

  add(binding: KeyBinding): () => void {
    const entry = { owner: "core", ...binding, key: normaliseKey(binding.key) };
    this.bindings.push(entry);
    this.notify();
    return () => {
      const i = this.bindings.indexOf(entry);
      if (i !== -1) {
        this.bindings.splice(i, 1);
        this.notify();
      }
    };
  }

  removeOwner(owner: string): void {
    const before = this.bindings.length;
    this.bindings = this.bindings.filter((b) => b.owner !== owner);
    if (this.bindings.length !== before) this.notify();
  }

  list(): KeyBinding[] {
    return [...this.bindings];
  }

  /** The binding a key press runs, or undefined. */
  resolve(key: string, context: ContextValues, typing: boolean): KeyBinding | undefined {
    const k = normaliseKey(key);
    for (let i = this.bindings.length - 1; i >= 0; i--) {
      const b = this.bindings[i];
      if (b.key !== k) continue;
      if (typing && !b.inInputs) continue;
      if (!evaluateWhen(b.when, context)) continue;
      return b;
    }
    return undefined;
  }

  /** The first key bound to a command, for showing beside it. */
  keyFor(command: string): string | undefined {
    for (let i = this.bindings.length - 1; i >= 0; i--) {
      if (this.bindings[i].command === command && this.bindings[i].args === undefined) return this.bindings[i].key;
    }
    return undefined;
  }

  /** Keys bound more than once under the same context clause. */
  conflicts(): { key: string; when: string; commands: string[] }[] {
    const groups = new Map<string, KeyBinding[]>();
    for (const b of this.bindings) {
      const id = `${b.key}\u0000${b.when ?? ""}`;
      groups.set(id, [...(groups.get(id) ?? []), b]);
    }
    return [...groups.values()]
      .filter((g) => new Set(g.map((b) => `${b.command}${JSON.stringify(b.args)}`)).size > 1)
      .map((g) => ({ key: g[0].key, when: g[0].when ?? "", commands: g.map((b) => b.command) }));
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

/** "mod+shift+z" as this platform writes it: "⌘⇧Z" on macOS, "Ctrl+Shift+Z" elsewhere. */
export function keyLabel(key: string, isMac: boolean): string {
  const parts = normaliseKey(key).split("+");
  const names: Record<string, [string, string]> = {
    mod: ["⌘", "Ctrl"],
    alt: ["⌥", "Alt"],
    shift: ["⇧", "Shift"],
  };
  const shown = parts.map((p) => (names[p] ? names[p][isMac ? 0 : 1] : p.length === 1 ? p.toUpperCase() : p[0].toUpperCase() + p.slice(1)));
  return isMac ? shown.join("") : shown.join("+");
}
