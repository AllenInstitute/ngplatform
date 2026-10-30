/**
 * Every user action is a command: buttons, menus, keys, the palette and
 * (later) Python all invoke the same entries, so every action is scriptable
 * and testable.  Plugins register theirs through the same registry.
 */

export interface Command {
  id: string;
  title: string;
  /** Palette grouping, e.g. "Workspace", "View", "Edit". */
  group: string;
  /** Display form of the key binding, e.g. "Mod+K". */
  keys?: string;
  /** One line shown under the title in the palette. */
  hint?: string;
  isAvailable?: () => boolean;
  run: () => void | Promise<void>;
}

export type Listener = () => void;

export class CommandRegistry {
  private commands = new Map<string, Command>();
  private listeners = new Set<Listener>();

  register(command: Command): () => void {
    if (this.commands.has(command.id)) {
      throw new Error(`command ${command.id} is already registered`);
    }
    this.commands.set(command.id, command);
    this.notify();
    return () => {
      this.commands.delete(command.id);
      this.notify();
    };
  }

  get(id: string): Command | undefined {
    return this.commands.get(id);
  }

  list(): Command[] {
    return [...this.commands.values()];
  }

  available(id: string): boolean {
    const command = this.commands.get(id);
    return command !== undefined && (command.isAvailable?.() ?? true);
  }

  async invoke(id: string): Promise<void> {
    const command = this.commands.get(id);
    if (command === undefined) throw new Error(`no command ${id}`);
    if (!(command.isAvailable?.() ?? true)) return;
    await command.run();
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
  parts.push(event.key.length === 1 ? event.key.toLowerCase() : event.key.toLowerCase());
  return parts.join("+");
}
