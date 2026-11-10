/** The Activity panel: a log of what the workspace did, newest first. */
import { type LogEntry, type LogLevel, logText } from "../../core/errors.js";
import { h } from "../dom.js";

export type { LogLevel };

/** Lines kept for saving (more than the panel shows). */
const KEEP = 1000;

export class ActivityLog {
  readonly element = h("ol", { class: "log", "aria-live": "polite" });
  private listeners = new Set<(message: string, level: LogLevel) => void>();
  private readonly kept: LogEntry[] = [];

  /** Adds a line; an error's `stack` is kept with it, shown folded and saved with the log. */
  add(message: string, level: LogLevel = "info", source?: string, stack?: string): void {
    const now = new Date();
    this.kept.push({ time: now, level, source, message, stack });
    if (this.kept.length > KEEP) this.kept.splice(0, this.kept.length - KEEP);
    const time = now.toLocaleTimeString(undefined, { hour12: false });
    this.element.prepend(
      h(
        "li",
        {},
        h("time", {}, time),
        h(
          "span",
          { class: level === "info" ? "" : level },
          source ? h("span", { class: "source" }, source + " · ") : null,
          message,
          stack ? h("details", { class: "log-stack" }, h("summary", {}, "Stack"), h("pre", {}, stack)) : null,
        ),
      ),
    );
    while (this.element.childElementCount > 300) this.element.lastElementChild?.remove();
    for (const listener of this.listeners) listener(message, level);
  }

  onAdd(listener: (message: string, level: LogLevel) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The lines kept, oldest first. */
  entries(): LogEntry[] {
    return [...this.kept];
  }

  /** The log as a text file (src/core/errors.ts, logText). */
  text(): string {
    return logText(this.kept);
  }
}
