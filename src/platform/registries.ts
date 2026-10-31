/**
 * Small registries the platform and plugins add to: inspector sections,
 * examples and Open handlers.  Each entry has an owner and is removed by the
 * disposer its `add` returns.
 */
import type { Disposer } from "../sdk/types.js";
import type { ExampleSpec, InspectorSectionSpec, OpenHandlerSpec } from "./plugin_host.js";

export class Registry<T extends { id: string }> {
  private items: T[] = [];
  private listeners = new Set<() => void>();

  add(item: T): Disposer {
    if (this.items.some((i) => i.id === item.id)) throw new Error(`${item.id} is already registered`);
    this.items.push(item);
    this.notify();
    return () => {
      const i = this.items.indexOf(item);
      if (i !== -1) {
        this.items.splice(i, 1);
        this.notify();
      }
    };
  }

  list(): T[] {
    return [...this.items];
  }

  get(id: string): T | undefined {
    return this.items.find((i) => i.id === id);
  }

  onChange(listener: () => void): Disposer {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

export class InspectorRegistry extends Registry<InspectorSectionSpec> {
  addSection(section: InspectorSectionSpec): Disposer {
    return this.add(section);
  }

  ordered(): InspectorSectionSpec[] {
    return this.list().sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
  }
}

export class ExampleRegistry extends Registry<ExampleSpec> {}

export class OpenHandlerRegistry extends Registry<OpenHandlerSpec> {
  addHandler(handler: OpenHandlerSpec): Disposer {
    return this.add(handler);
  }

  /** The first handler whose pattern matches the pasted text. */
  match(text: string): OpenHandlerSpec | undefined {
    return this.list().find((h) => h.pattern.test(text.trim()));
  }
}
