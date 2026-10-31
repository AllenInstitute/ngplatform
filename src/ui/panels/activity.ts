/** The Activity tab: a log of what the workspace did, newest first. */
import { h } from "../dom.js";

export type LogLevel = "info" | "ok" | "error";

export class ActivityLog {
  readonly element = h("ol", { class: "log", "aria-live": "polite" });
  private listeners = new Set<(message: string, level: LogLevel) => void>();

  add(message: string, level: LogLevel = "info", source?: string): void {
    const time = new Date().toLocaleTimeString(undefined, { hour12: false });
    this.element.prepend(
      h(
        "li",
        {},
        h("time", {}, time),
        h("span", { class: level === "info" ? "" : level }, source ? h("span", { class: "source" }, source + " · ") : null, message),
      ),
    );
    while (this.element.childElementCount > 300) this.element.lastElementChild?.remove();
    for (const listener of this.listeners) listener(message, level);
  }

  onAdd(listener: (message: string, level: LogLevel) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
