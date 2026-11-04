/**
 * Every user action is a command: buttons, menus, keys, the palette, plugins
 * and (later) Python all invoke the same entries, so every action is
 * scriptable and testable.  Plugins register theirs through the same
 * registry; each command records its owner so unloading a plugin removes
 * exactly what it added.
 */
import { type Schema, validate, withDefaults } from "./schema.js";
import { type ContextKeys, evaluateWhen } from "./when.js";

export interface Command<A = any> {
  id: string;
  title: string;
  /** Palette grouping, e.g. "Workspace", "View", "Edit". */
  group: string;
  /** Display form of the key binding, e.g. "Mod+K". */
  keys?: string;
  /** One line shown under the title in the palette. */
  hint?: string;
  /** Arguments, validated (and given their defaults) before `run`. */
  args?: Schema;
  /** Context clause that must hold for the command to run (see when.ts). */
  when?: string;
  /** Extra availability check, for conditions no context key captures. */
  isAvailable?: () => boolean;
  /** "core", or the id of the plugin that registered it. */
  owner?: string;
  run: (args: A) => unknown | Promise<unknown>;
}

export type Listener = () => void;

export class CommandError extends Error {}

export class CommandRegistry {
  private commands = new Map<string, Command>();
  private listeners = new Set<Listener>();
  private context: ContextKeys | undefined;

  /** Supplies the context keys `when` clauses read. */
  useContext(context: ContextKeys): void {
    this.context = context;
    context.onChange(() => this.notify());
  }

  register(command: Command): () => void {
    if (this.commands.has(command.id)) {
      throw new CommandError(`command ${command.id} is already registered`);
    }
    this.commands.set(command.id, { owner: "core", ...command });
    this.notify();
    return () => {
      if (this.commands.get(command.id)?.run === command.run) {
        this.commands.delete(command.id);
        this.notify();
      }
    };
  }

  /** Removes every command an owner registered. */
  removeOwner(owner: string): void {
    let changed = false;
    for (const [id, command] of this.commands) {
      if (command.owner === owner) {
        this.commands.delete(id);
        changed = true;
      }
    }
    if (changed) this.notify();
  }

  get(id: string): Command | undefined {
    return this.commands.get(id);
  }

  has(id: string): boolean {
    return this.commands.has(id);
  }

  list(): Command[] {
    return [...this.commands.values()];
  }

  available(id: string): boolean {
    const command = this.commands.get(id);
    if (command === undefined) return false;
    if (!evaluateWhen(command.when, this.context?.all() ?? {})) return false;
    return command.isAvailable?.() ?? true;
  }

  /**
   * Runs a command with arguments; returns what it returns.  Throws
   * CommandError when it does not exist or its arguments are invalid, and
   * returns undefined without running when it is unavailable.
   */
  async invoke<R = unknown>(id: string, args?: unknown): Promise<R | undefined> {
    const command = this.commands.get(id);
    if (command === undefined) throw new CommandError(`no command ${id}`);
    if (!this.available(id)) return undefined;
    let value = args;
    if (command.args !== undefined) {
      value = withDefaults(command.args, args ?? {});
      const errors = validate(command.args, value);
      if (errors.length > 0) throw new CommandError(`${id}: ${errors.join("; ")}`);
    }
    return (await command.run(value)) as R;
  }

  /** Called when availability may have changed (after any state change). */
  notify(): void {
    for (const listener of this.listeners) listener();
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

/**
 * Whether a command runs without arguments, as the palette and menus run it:
 * none of its required arguments lacks a default.  ("Switch to a scene"
 * needs a scene id; keys and buttons give it one, the palette cannot.)
 */
export function runsWithoutArgs(command: Command): boolean {
  const args = command.args;
  if (args === undefined) return true;
  return (args.required ?? []).every((name) => args.properties?.[name]?.default !== undefined);
}

/** Ranks commands against a palette query: every word must appear somewhere. */
export function matchCommands(commands: Command[], query: string): Command[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const scored: [number, Command][] = [];
  for (const command of commands) {
    const haystack = `${command.title} ${command.group} ${command.id}`.toLowerCase();
    if (!words.every((w) => haystack.includes(w))) continue;
    // Earlier in the title ranks higher; a match only in the group or id last.
    const at = words.length === 0 ? 0 : command.title.toLowerCase().indexOf(words[0]);
    const score = at === -1 ? 1000 : at;
    scored.push([score, command]);
  }
  scored.sort((a, b) => a[0] - b[0] || a[1].group.localeCompare(b[1].group) || a[1].title.localeCompare(b[1].title));
  return scored.map(([, command]) => command);
}

/** Normalises a keyboard event to the form used in bindings, e.g. "mod+shift+z". */
export function keyOf(event: KeyboardEvent, isMac: boolean): string {
  const parts: string[] = [];
  if (isMac ? event.metaKey : event.ctrlKey) parts.push("mod");
  if (event.altKey) parts.push("alt");
  if (event.shiftKey) parts.push("shift");
  parts.push(event.key.toLowerCase());
  return parts.join("+");
}
