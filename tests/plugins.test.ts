/**
 * The plugin host against fake services: manifests, lazy activation,
 * ownership, failure isolation.  These fixture plugins exist only here.
 */
import { describe, expect, it } from "vitest";
import { CommandRegistry } from "../src/core/commands.js";
import { KeybindingTable } from "../src/core/keybindings.js";
import { ContextKeys } from "../src/core/when.js";
import { AuthRegistry } from "../src/platform/auth.js";
import { JobService } from "../src/platform/jobs.js";
import { type DockTabSpec, type HostServices, PluginError, PluginHost } from "../src/platform/plugin_host.js";
import { ExampleRegistry, OpenHandlerRegistry } from "../src/platform/registries.js";
import { ServiceRegistry } from "../src/platform/services.js";
import { checkManifest } from "../src/sdk/manifest.js";
import type { Manifest, PluginModule, ViewerApi, WorkspaceApi } from "../src/sdk/types.js";

function services() {
  const tabs: DockTabSpec[] = [];
  const logs: string[] = [];
  const slices = new Map<string, unknown>();
  const s: HostServices = {
    commands: new CommandRegistry(),
    keybindings: new KeybindingTable(),
    context: new ContextKeys(),
    docks: {
      addTab: (tab) => {
        tabs.push(tab);
        return () => tabs.splice(tabs.indexOf(tab), 1);
      },
      show: () => {},
    },
    views: { mount: () => () => {} },
    examples: new ExampleRegistry(),
    open: new OpenHandlerRegistry(),
    ui: { toast: (m) => logs.push(`toast: ${m}`), confirm: async () => true, form: async () => undefined, viewToggle: () => ({ set: () => {}, dispose: () => {} }), overlay: () => ({ element: {} as HTMLElement, dispose: () => {} }), screenshotOverlay: () => () => {} },
    workspace: {} as WorkspaceApi,
    viewer: {} as ViewerApi,
    slices: {
      get: (key) => slices.get(key),
      set: (key, _version, value) => slices.set(key, value),
      onChanged: () => () => {},
    },
    settings: { get: () => undefined, set: () => {} },
    jobs: new JobService(),
    services: new ServiceRegistry(),
    auth: new AuthRegistry({ getItem: () => null, setItem: () => {} }),
    log: (message) => logs.push(message),
  };
  return { s, tabs, logs, slices };
}

const manifest: Manifest = {
  id: "org.example.counter",
  name: "Counter",
  version: "0.1.0",
  kind: "tool",
  activation: ["onCommand:counter.add"],
  contributes: {
    commands: [
      { id: "counter.add", title: "Add to the counter", args: { type: "object", properties: { by: { type: "number", default: 1 } } } },
      { id: "counter.fail", title: "Fail" },
    ],
    keybindings: [{ key: "alt+c", command: "counter.add" }],
    panels: [{ id: "counter.panel", title: "Counter", slot: "right", when: "selectedLayerType == image" }],
    appState: { key: "counter", version: 1 },
  },
};

function counterPlugin(loads: { n: number }): () => Promise<PluginModule> {
  return async () => {
    loads.n++;
    return {
      activate(ctx) {
        let count = 0;
        ctx.commands.register("counter.add", ({ by }: { by: number }) => {
          count += by;
          ctx.state.set({ count });
          return count;
        });
        ctx.commands.register("counter.fail", () => {
          throw new Error("boom");
        });
        ctx.ui.panel("counter.panel", (host) => {
          host.textContent = `count ${count}`;
        });
        ctx.services.provide("counter@1", { value: () => count });
      },
    };
  };
}

describe("manifest checks", () => {
  it("accepts a sound manifest", () => {
    expect(checkManifest(manifest)).toEqual([]);
  });
  it("keeps data type plugins to formats", () => {
    const datatype: Manifest = { ...manifest, id: "org.example.format", kind: "datatype", activation: [] };
    expect(checkManifest(datatype)).toContain(
      "a data type plugin contributes a format, not commands or panels: make those a tool plugin that requires it",
    );
    expect(checkManifest({ id: "org.example.format", name: "F", version: "1.0.0", kind: "datatype" })).toEqual([]);
    expect(checkManifest({ id: "org.example.f", name: "F", version: "1.0.0", kind: "widget" })).toEqual([
      'kind: must be one of "datatype", "tool"',
    ]);
  });

  it("reports schema errors and dangling references", () => {
    expect(checkManifest({ id: "Bad Id", name: "x", version: "1", kind: "tool" })).toEqual(
      expect.arrayContaining([expect.stringMatching(/^id: does not match/), expect.stringMatching(/^version: does not match/)]),
    );
    const bad: Manifest = {
      id: "org.example.bad",
      name: "Bad",
      version: "1.0.0",
      kind: "tool",
      activation: ["onCommand:missing", "onView:nowhere"],
      contributes: {
        commands: [{ id: "a", title: "A", when: "undeclaredKey" }],
        keybindings: [{ key: "x", command: "b" }],
      },
    };
    expect(checkManifest(bad)).toEqual([
      "keybinding x names undeclared command b",
      "activation onCommand:missing names undeclared command",
      "activation onView:nowhere names undeclared panel",
      'when clause "undeclaredKey" reads undeclared context key undeclaredKey',
    ]);
  });
});

describe("PluginHost", () => {
  it("lists a switched-off plugin without declaring anything or loading it", async () => {
    const { s, tabs } = services();
    const host = new PluginHost(s);
    const loads = { n: 0 };
    host.register(manifest, counterPlugin(loads), { enabled: false });
    expect(host.list()[0].status).toBe("off");
    expect(s.commands.has("counter.add")).toBe(false);
    expect(tabs).toEqual([]);
    await expect(host.activate(manifest.id)).rejects.toThrow(/switched off/);
    expect(loads.n).toBe(0);
  });

  it("switches on a plugin registered off without a reload: its contributions appear, its code loads on use", async () => {
    const { s, tabs } = services();
    const host = new PluginHost(s);
    const loads = { n: 0 };
    host.register(manifest, counterPlugin(loads), { enabled: false });
    let changes = 0;
    host.onChange(() => changes++);
    host.switchOn(manifest.id);
    expect(changes).toBe(1);
    expect(host.list()[0].status).toBe("registered");
    expect(s.commands.has("counter.add")).toBe(true);
    expect(tabs.map((t) => t.id)).toEqual(["counter.panel"]);
    expect(loads.n).toBe(0);
    expect(await s.commands.invoke("counter.add", { by: 2 })).toBe(2);
    // Once on, switching on again changes nothing.
    host.switchOn(manifest.id);
    expect(tabs).toHaveLength(1);
    // A plugin that activates on startup activates at once.
    const eager: Manifest = { ...manifest, id: "org.example.eager", activation: ["onStartup"], contributes: { appState: { key: "eager", version: 1 } } };
    const eagerLoads = { n: 0 };
    host.register(eager, async () => (eagerLoads.n++, { activate() {} }), { enabled: false });
    host.switchOn(eager.id);
    await new Promise((r) => setTimeout(r, 0));
    expect(eagerLoads.n).toBe(1);
    expect(host.list().find((r) => r.manifest.id === eager.id)?.status).toBe("active");
  });

  it("shows declared contributions without loading code, and loads on first use", async () => {
    const { s, tabs, slices } = services();
    const host = new PluginHost(s);
    const loads = { n: 0 };
    host.register(manifest, counterPlugin(loads));
    expect(loads.n).toBe(0);
    expect(s.commands.get("counter.add")?.owner).toBe("org.example.counter");
    expect(s.keybindings.resolve("alt+c", {}, false)?.command).toBe("counter.add");
    expect(tabs.map((t) => t.id)).toEqual(["counter.panel"]);
    expect(await s.commands.invoke("counter.add", { by: 2 })).toBe(2);
    expect(await s.commands.invoke("counter.add")).toBe(3);
    expect(loads.n).toBe(1);
    expect(slices.get("counter")).toEqual({ count: 3 });
    expect(host.list()[0].status).toBe("active");
    expect(await s.services.get<{ value(): number }>("counter@1").then((c) => c.value())).toBe(3);
    const pane = { textContent: "" } as HTMLElement;
    await tabs[0].render(pane);
    expect(pane.textContent).toBe("count 3");
  });

  it("removes everything a plugin added when it is unregistered", async () => {
    const { s, tabs } = services();
    const host = new PluginHost(s);
    host.register(manifest, counterPlugin({ n: 0 }));
    await host.activate(manifest.id);
    await host.unregister(manifest.id);
    expect(s.commands.has("counter.add")).toBe(false);
    expect(s.keybindings.list()).toEqual([]);
    expect(tabs).toEqual([]);
    expect(s.services.list()).toEqual([]);
  });

  it("disables a plugin after three failures, without the errors escaping as anything but rejections", async () => {
    const { s, logs } = services();
    const host = new PluginHost(s);
    host.register(manifest, counterPlugin({ n: 0 }));
    for (let i = 0; i < 3; i++) await expect(s.commands.invoke("counter.fail")).rejects.toThrow("boom");
    await new Promise((r) => setTimeout(r, 0));
    expect(host.list()[0].status).toBe("disabled");
    expect(logs.some((l) => /disabled/.test(l))).toBe(true);
    await expect(s.commands.invoke("counter.add")).rejects.toThrow(/disabled/);
  });

  it("reports a plugin whose activation throws, and refuses bad manifests", async () => {
    const { s } = services();
    const host = new PluginHost(s);
    host.register({ ...manifest, id: "org.example.broken" }, async () => ({
      activate() {
        throw new Error("no luck");
      },
    }));
    await expect(host.activate("org.example.broken")).rejects.toThrow("no luck");
    expect(host.list()[0]).toMatchObject({ status: "failed", error: "no luck" });
    expect(() => host.register({ id: "x", name: "x", version: "1", kind: "tool" } as Manifest, async () => ({ activate() {} }))).toThrow(PluginError);
  });

  it("refuses contributions the manifest did not declare", async () => {
    const { s } = services();
    const host = new PluginHost(s);
    let error: Error | undefined;
    host.register({ ...manifest, id: "org.example.sneaky", activation: ["onStartup"] }, async () => ({
      activate(ctx) {
        try {
          ctx.ui.panel("undeclared", () => {});
        } catch (e) {
          error = e as Error;
        }
      },
    }));
    await host.activate("org.example.sneaky");
    expect(error?.message).toMatch(/no panel "undeclared"/);
  });
});

describe("sign-in providers from plugins", () => {
  it("are registered through the context and removed when the plugin stops", async () => {
    const { s } = services();
    const auth = s.auth as AuthRegistry;
    const host = new PluginHost(s);
    const m: Manifest = { ...manifest, id: "org.example.auth", activation: ["onStartup"], contributes: {} };
    host.register(m, async () => ({
      activate(ctx) {
        ctx.auth.register({ id: "example", title: "Example", services: async () => [] });
      },
    }));
    await host.activate(m.id);
    expect(auth.list().map((p) => p.id)).toEqual(["example"]);
    await host.deactivate(m.id);
    expect(auth.list()).toEqual([]);
  });
});

describe("handles a plugin disposes itself", () => {
  it("are disposed once, and forgotten (not disposed again when the plugin stops)", async () => {
    const { s } = services();
    const disposed: string[] = [];
    s.ui.overlay = () => ({ element: {} as HTMLElement, dispose: () => disposed.push("overlay") });
    s.ui.viewToggle = () => ({ set: () => {}, dispose: () => disposed.push("toggle") });
    s.viewer = { draw3d: () => ({ redraw: () => {}, dispose: () => disposed.push("draw3d") }) } as unknown as ViewerApi;
    const host = new PluginHost(s);
    const m: Manifest = { ...manifest, id: "org.example.handles", activation: ["onStartup"], contributes: {} };
    let kept: { dispose(): void } | undefined;
    host.register(m, async () => ({
      activate(ctx) {
        ctx.ui.overlay().dispose();
        ctx.ui.viewToggle({ label: "x", value: false, onChange: () => {} }).dispose();
        const handle = ctx.viewer.draw3d("layer", { draw: () => {} });
        handle.redraw();
        handle.dispose();
        kept = ctx.ui.overlay();
      },
    }));
    await host.activate(m.id);
    expect(disposed).toEqual(["overlay", "toggle", "draw3d"]);
    expect(kept).toBeDefined();
    await host.deactivate(m.id);
    // Only the overlay still held is disposed when the plugin stops.
    expect(disposed).toEqual(["overlay", "toggle", "draw3d", "overlay"]);
  });
});
