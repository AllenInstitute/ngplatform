/**
 * Named services plugins provide to each other, e.g. an atlas plugin's
 * `atlas.regions@1` used by a cell-counting plugin.  `get` waits until the
 * provider has activated.
 */
import type { Disposer } from "../sdk/types.js";

interface Pending {
  promise: Promise<unknown>;
  resolve: (value: unknown) => void;
}

export class ServiceRegistry {
  private provided = new Map<string, { implementation: unknown; owner: string }>();
  private pending = new Map<string, Pending>();

  provide<T>(name: string, implementation: T, owner = "core"): Disposer {
    if (this.provided.has(name)) throw new Error(`service ${name} is already provided by ${this.provided.get(name)!.owner}`);
    this.provided.set(name, { implementation, owner });
    const waiting = this.pending.get(name);
    if (waiting !== undefined) {
      waiting.resolve(implementation);
      this.pending.delete(name);
    }
    return () => {
      if (this.provided.get(name)?.implementation === implementation) this.provided.delete(name);
    };
  }

  get<T>(name: string): Promise<T> {
    const provided = this.provided.get(name);
    if (provided !== undefined) return Promise.resolve(provided.implementation as T);
    let waiting = this.pending.get(name);
    if (waiting === undefined) {
      let resolve!: (value: unknown) => void;
      const promise = new Promise<unknown>((r) => (resolve = r));
      waiting = { promise, resolve };
      this.pending.set(name, waiting);
    }
    return waiting.promise as Promise<T>;
  }

  list(): { name: string; owner: string }[] {
    return [...this.provided].map(([name, { owner }]) => ({ name, owner }));
  }
}
