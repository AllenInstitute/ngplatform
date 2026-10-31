/**
 * The plugin host: registers manifests, loads plugin code when first needed,
 * hands each plugin its `PlatformContext`, and removes everything a plugin
 * added when it is deactivated.
 *
 * What a manifest declares (commands, panels, inspector sections, keys,
 * examples, open handlers) appears as soon as the plugin is registered;
 * using any of it activates the plugin, which then supplies the code.  A
 * plugin that throws three times is disabled, and its errors never reach the
 * shell or Neuroglancer.
 */
import type { CommandRegistry } from "../core/commands.js";
import type { KeybindingTable } from "../core/keybindings.js";
import type { Schema } from "../core/schema.js";
import type { ContextKeys } from "../core/when.js";
import { checkManifest } from "../sdk/manifest.js";
import type {
  DatasetInfo,
  Disposer,
  DockSlot,
  InspectorTarget,
  JobControl,
  Json,
  Manifest,
  PlatformContext,
  PluginModule,
  ViewerApi,
  WorkspaceApi,
} from "../sdk/types.js";
import type { ServiceRegistry } from "./services.js";

export interface DockTabSpec {
  id: string;
  title: string;
  slot: DockSlot;
  order?: number;
  when?: string;
  owner?: string;
  render(host: HTMLElement): Disposer | void | Promise<Disposer | void>;
}

export interface InspectorSectionSpec {
  id: string;
  title: string;
  order?: number;
  when?: string;
  owner?: string;
  render(host: HTMLElement, target: InspectorTarget): Disposer | void | Promise<Disposer | void>;
}

export interface ExampleSpec {
  id: string;
  title: string;
  description: string;
  remote?: boolean;
  owner?: string;
  state: () => { ng: Json; app: Json };
}

export interface OpenHandlerSpec {
  id: string;
  title?: string;
  pattern: RegExp;
  owner?: string;
  open(text: string): Promise<void> | void;
}

/** What the platform gives the host; the shell supplies it, tests fake it. */
export interface HostServices {
  commands: CommandRegistry;
  keybindings: KeybindingTable;
  context: ContextKeys;
  docks: { addTab(tab: DockTabSpec): Disposer; show(id: string): void };
  inspector: { addSection(section: InspectorSectionSpec): Disposer };
  examples: { add(example: ExampleSpec): Disposer };
  open: { addHandler(handler: OpenHandlerSpec): Disposer };
  ui: {
    toast(message: string, kind?: "info" | "error"): void;
    confirm(message: string): Promise<boolean>;
    form<T>(title: string, schema: Schema, initial?: Partial<T>): Promise<T | undefined>;
  };
  workspace: WorkspaceApi;
  viewer: ViewerApi;
  slices: {
    get(key: string): unknown;
    set(key: string, version: number, value: unknown): void;
    onChanged(callback: () => void): Disposer;
  };
  settings: { get(key: string): unknown; set(key: string, value: unknown): void };
  jobs: { run<T>(title: string, work: (control: JobControl) => Promise<T>, owner?: string): Promise<T> };
  services: ServiceRegistry;
  log(message: string, level: "info" | "error", source?: string): void;
}

export type PluginStatus = "registered" | "activating" | "active" | "failed" | "disabled";

export interface PluginRecord {
  manifest: Manifest;
  status: PluginStatus;
  builtin: boolean;
  error?: string;
  errors: number;
}

interface Entry extends PluginRecord {
  load: () => Promise<PluginModule>;
  module?: PluginModule;
  activation?: Promise<void>;
  /** Removes what the manifest declared (always present while registered). */
  declared: Disposer[];
  /** Removes what activation added. */
  active: Disposer[];
  commands: Map<string, (args: unknown) => unknown>;
  panels: Map<string, (host: HTMLElement) => Disposer | void>;
  sections: Map<string, (host: HTMLElement, target: InspectorTarget) => Disposer | void>;
  openers: Map<string, (text: string) => Promise<void> | void>;
}

export class PluginError extends Error {}

const MAX_ERRORS = 3;

export class PluginHost {
  private plugins = new Map<string, Entry>();
  private listeners = new Set<() => void>();

  constructor(private readonly services: HostServices) {}

  list(): PluginRecord[] {
    return [...this.plugins.values()].map(({ manifest, status, builtin, error, errors }) => ({ manifest, status, builtin, error, errors }));
  }

  onChange(listener: () => void): Disposer {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }

  /**
   * Registers a plugin from its manifest; `load` returns its module and is
   * called on first activation.  Throws PluginError when the manifest is
   * unsound.
   */
  register(manifest: Manifest, load: () => Promise<PluginModule>, options: { builtin?: boolean } = {}): void {
    const problems = checkManifest(manifest);
    if (problems.length > 0) throw new PluginError(`${(manifest as Partial<Manifest>)?.id ?? "plugin"}: ${problems.join("; ")}`);
    if (this.plugins.has(manifest.id)) throw new PluginError(`${manifest.id} is already registered`);
    const entry: Entry = {
      manifest,
      status: "registered",
      builtin: options.builtin ?? false,
      errors: 0,
      load,
      declared: [],
      active: [],
      commands: new Map(),
      panels: new Map(),
      sections: new Map(),
      openers: new Map(),
    };
    this.plugins.set(manifest.id, entry);
    this.declare(entry);
    this.changed();
    if (manifest.activation?.includes("onStartup")) void this.activate(manifest.id).catch(() => {});
  }

  /** Removes a plugin and everything it added. */
  async unregister(id: string): Promise<void> {
    const entry = this.plugins.get(id);
    if (entry === undefined) return;
    await this.deactivate(id);
    entry.declared.splice(0).forEach((d) => d());
    this.plugins.delete(id);
    this.changed();
  }

  // --------------------------------------------------- declared contributions

  private declare(entry: Entry): void {
    const { manifest } = entry;
    const owner = manifest.id;
    const c = manifest.contributes ?? {};
    const s = this.services;
    for (const command of c.commands ?? []) {
      entry.declared.push(
        s.commands.register({
          id: command.id,
          title: command.title,
          group: command.group ?? manifest.name,
          hint: command.hint,
          args: command.args,
          when: command.when,
          owner,
          run: async (args) => {
            await this.activate(owner);
            const run = entry.commands.get(command.id);
            if (run === undefined) throw new PluginError(`${owner} did not supply command ${command.id}`);
            return this.guard(entry, () => run(args));
          },
        }),
      );
    }
    for (const binding of c.keybindings ?? []) entry.declared.push(s.keybindings.add({ ...binding, owner }));
    for (const panel of c.panels ?? []) {
      entry.declared.push(
        s.docks.addTab({
          ...panel,
          owner,
          render: async (host) => {
            await this.activate(owner);
            const render = entry.panels.get(panel.id);
            if (render === undefined) {
              host.textContent = `${manifest.name} supplies no content for this panel.`;
              return;
            }
            return this.guard(entry, () => render(host));
          },
        }),
      );
    }
    for (const section of c.inspector ?? []) {
      entry.declared.push(
        s.inspector.addSection({
          ...section,
          owner,
          render: async (host, target) => {
            await this.activate(owner);
            const render = entry.sections.get(section.id);
            if (render === undefined) return;
            return this.guard(entry, () => render(host, target));
          },
        }),
      );
    }
    for (const example of c.examples ?? []) {
      if (example.state === undefined) continue;
      const state = example.state;
      entry.declared.push(
        s.examples.add({
          ...example,
          owner,
          state: () => {
            const value = structuredClone(state);
            return "ng" in value ? (value as { ng: Json; app: Json }) : { ng: value, app: {} };
          },
        }),
      );
    }
    for (const handler of c.openHandlers ?? []) {
      entry.declared.push(
        s.open.addHandler({
          id: handler.id,
          title: handler.title,
          pattern: new RegExp(handler.pattern),
          owner,
          open: async (text) => {
            await this.activate(owner);
            const open = entry.openers.get(handler.id);
            if (open === undefined) throw new PluginError(`${owner} did not supply open handler ${handler.id}`);
            await this.guard(entry, () => open(text));
          },
        }),
      );
    }
  }

  // ---------------------------------------------------------- activation

  /** Loads and activates a plugin (once); resolves when it is active. */
  activate(id: string): Promise<void> {
    const entry = this.plugins.get(id);
    if (entry === undefined) return Promise.reject(new PluginError(`no plugin ${id}`));
    if (entry.status === "disabled") return Promise.reject(new PluginError(`${entry.manifest.name} is disabled`));
    if (entry.activation !== undefined) return entry.activation;
    entry.status = "activating";
    this.changed();
    entry.activation = (async () => {
      try {
        for (const service of entry.manifest.requires?.services ?? []) {
          await this.services.services.get(service);
        }
        entry.module = await entry.load();
        await entry.module.activate(this.contextFor(entry));
        entry.status = "active";
        this.services.log(`Activated ${entry.manifest.name} ${entry.manifest.version}.`, "info", entry.manifest.id);
      } catch (e) {
        entry.status = "failed";
        entry.error = (e as Error).message;
        entry.active.splice(0).forEach((d) => d());
        entry.activation = undefined;
        this.services.log(`${entry.manifest.name} failed to activate: ${entry.error}`, "error", entry.manifest.id);
        throw e;
      } finally {
        this.changed();
      }
    })();
    return entry.activation;
  }

  /** Runs every plugin that activates on datasets of `kind`. */
  datasetKindSeen(kind: string): void {
    for (const entry of this.plugins.values()) {
      if (entry.activation === undefined && entry.status !== "disabled" && entry.manifest.activation?.includes(`onDatasetKind:${kind}`)) {
        void this.activate(entry.manifest.id).catch(() => {});
      }
    }
  }

  async deactivate(id: string): Promise<void> {
    const entry = this.plugins.get(id);
    if (entry === undefined || entry.activation === undefined) return;
    try {
      await entry.activation;
    } catch {
      // A failed activation already cleaned up.
    }
    try {
      await entry.module?.deactivate?.();
    } catch (e) {
      this.services.log(`${entry.manifest.name} failed to deactivate cleanly: ${(e as Error).message}`, "error", id);
    }
    entry.active.splice(0).forEach((d) => {
      try {
        d();
      } catch (e) {
        console.error(e);
      }
    });
    entry.commands.clear();
    entry.panels.clear();
    entry.sections.clear();
    entry.openers.clear();
    entry.activation = undefined;
    entry.module = undefined;
    if (entry.status !== "disabled") entry.status = "registered";
    this.changed();
  }

  async disable(id: string, reason?: string): Promise<void> {
    const entry = this.plugins.get(id);
    if (entry === undefined) return;
    await this.deactivate(id);
    entry.status = "disabled";
    entry.error = reason;
    this.changed();
  }

  async enable(id: string): Promise<void> {
    const entry = this.plugins.get(id);
    if (entry === undefined || entry.status !== "disabled") return;
    entry.status = "registered";
    entry.errors = 0;
    entry.error = undefined;
    this.changed();
  }

  /** Runs plugin code; logs and counts what it throws, disabling the plugin at the limit. */
  private async guard<T>(entry: Entry, work: () => T | Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (e) {
      entry.errors++;
      entry.error = (e as Error).message;
      this.services.log(`${entry.manifest.name}: ${entry.error}`, "error", entry.manifest.id);
      if (entry.errors >= MAX_ERRORS) {
        this.services.ui.toast(`${entry.manifest.name} failed ${MAX_ERRORS} times and was disabled.`, "error");
        void this.disable(entry.manifest.id, entry.error);
      }
      this.changed();
      throw e;
    }
  }

  // ------------------------------------------------------------ context

  private contextFor(entry: Entry): PlatformContext {
    const s = this.services;
    const { manifest } = entry;
    const owner = manifest.id;
    const own = (d: Disposer): Disposer => {
      entry.active.push(d);
      return () => {
        const i = entry.active.indexOf(d);
        if (i !== -1) entry.active.splice(i, 1);
        d();
      };
    };
    const declared = (kind: string, ids: Set<string>, id: string) => {
      if (!ids.has(id)) throw new PluginError(`${owner} has no ${kind} "${id}" in its manifest`);
    };
    const c = manifest.contributes ?? {};
    const commandIds = new Set((c.commands ?? []).map((x) => x.id));
    const panelIds = new Set((c.panels ?? []).map((x) => x.id));
    const sectionIds = new Set((c.inspector ?? []).map((x) => x.id));
    const openIds = new Set((c.openHandlers ?? []).map((x) => x.id));
    const slice = c.appState;
    const subscriptions: Disposer[] = [];
    entry.active.push(() => subscriptions.splice(0).forEach((d) => d()));
    const settingKey = (key: string) => `plugin.${owner}.${key}`;
    const context: PlatformContext = {
      plugin: { id: owner, version: manifest.version, manifest },
      commands: {
        register: (id, run, meta) => {
          if (commandIds.has(id)) {
            entry.commands.set(id, run as (args: unknown) => unknown);
            return own(() => entry.commands.delete(id));
          }
          return own(
            s.commands.register({
              id,
              title: meta?.title ?? id,
              group: meta?.group ?? manifest.name,
              hint: meta?.hint,
              args: meta?.args,
              when: meta?.when,
              owner,
              run: (args) => this.guard(entry, () => run(args as never)),
            }),
          );
        },
        invoke: (id, args) => s.commands.invoke(id, args),
      },
      ui: {
        panel: (id, render) => {
          declared("panel", panelIds, id);
          entry.panels.set(id, render);
          return own(() => entry.panels.delete(id));
        },
        inspectorSection: (id, render) => {
          declared("inspector section", sectionIds, id);
          entry.sections.set(id, render);
          return own(() => entry.sections.delete(id));
        },
        showPanel: (id) => s.docks.show(id),
        toast: (message, kind) => s.ui.toast(message, kind),
        confirm: (message) => s.ui.confirm(message),
        form: (title, schema, initial) => s.ui.form(title, schema, initial),
      },
      workspace: s.workspace,
      viewer: s.viewer,
      state: {
        get: <T>() => {
          if (slice === undefined) throw new PluginError(`${owner} declares no appState`);
          return s.slices.get(slice.key) as T | undefined;
        },
        set: (value) => {
          if (slice === undefined) throw new PluginError(`${owner} declares no appState`);
          s.slices.set(slice.key, slice.version, value);
        },
        onChanged: (callback) => own(s.slices.onChanged(callback)),
      },
      settings: {
        get: <T>(key: string) => {
          const value = s.settings.get(settingKey(key));
          return (value ?? (c.settings?.[key]?.default as T | undefined)) as T | undefined;
        },
        set: (key, value) => s.settings.set(settingKey(key), value),
      },
      context: { set: (key, value) => s.context.set(key, value) },
      jobs: { run: (title, work) => s.jobs.run(title, work, owner) },
      services: {
        provide: (name, implementation) => own(s.services.provide(name, implementation, owner)),
        get: (name) => s.services.get(name),
      },
      open: {
        handler: (id, open) => {
          declared("open handler", openIds, id);
          entry.openers.set(id, open);
          return own(() => entry.openers.delete(id));
        },
      },
      log: {
        info: (message) => s.log(message, "info", owner),
        error: (message) => s.log(message, "error", owner),
      },
      subscriptions,
    };
    return context;
  }
}

export type { DatasetInfo };
