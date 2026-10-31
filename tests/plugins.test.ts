/**
 * The plugin host against fake services: manifests, lazy activation,
 * ownership, failure isolation.  These fixture plugins exist only here.
 */
import { describe, expect, it } from "vitest";
import { CommandRegistry } from "../src/core/commands.js";
import { KeybindingTable } from "../src/core/keybindings.js";
import { ContextKeys } from "../src/core/when.js";
import { JobService } from "../src/platform/jobs.js";
import { type DockTabSpec, type HostServices, PluginError, PluginHost } from "../src/platform/plugin_host.js";
import { ExampleRegistry, InspectorRegistry, OpenHandlerRegistry } from "../src/platform/registries.js";
import { ServiceRegistry } from "../src/platform/services.js";
import { checkManifest } from "../src/sdk/manifest.js";
import type { Manifest, PluginModule, ViewerApi, WorkspaceApi } from "../src/sdk/types.js";

function services() {
  const inspector = new InspectorRegistry();
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
    inspector,
    examples: new ExampleRegistry(),
    open: new OpenHandlerRegistry(),
    ui: { toast: (m) => logs.push(`toast: ${m}`), confirm: async () => true, form: async () => undefined },
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
    log: (message) => logs.push(message),
  };
  return { s, tabs, logs, slices, inspector };
}

const manifest: Manifest = {
  id: "org.example.counter",
  name: "Counter",
  version: "0.1.0",
  activation: ["onCommand:counter.add"],
  contributes: {
    commands: [
      { id: "counter.add", title: "Add to the counter", args: { type: "object", properties: { by: { type: "number", default: 1 } } } },
      { id: "counter.fail", title: "Fail" },
    ],
    keybindings: [{ key: "alt+c", command: "counter.add" }],
    panels: [{ id: "counter.panel", title: "Counter", slot: "right" }],
    inspector: [{ id: "counter.section", title: "Counter", when: "selectedLayerType == image" }],
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
        ctx.ui.inspectorSection("counter.section", () => {});
        ctx.services.provide("counter@1", { value: () => count });
      },
    };
  };
}

describe("manifest checks", () => {
  it("accepts a sound manifest", () => {
    expect(checkManifest(manifest)).toEqual([]);
  });
  it("reports schema errors and dangling references", () => {
    expect(checkManifest({ id: "Bad Id", name: "x", version: "1" })).toEqual(
      expect.arrayContaining([expect.stringMatching(/^id: does not match/), expect.stringMatching(/^version: does not match/)]),
    );
    const bad: Manifest = {
      id: "org.example.bad",
      name: "Bad",
      version: "1.0.0",
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
    const { s, tabs, inspector } = services();
    const host = new PluginHost(s);
    host.register(manifest, counterPlugin({ n: 0 }));
    await host.activate(manifest.id);
    await host.unregister(manifest.id);
    expect(s.commands.has("counter.add")).toBe(false);
    expect(s.keybindings.list()).toEqual([]);
    expect(tabs).toEqual([]);
    expect(inspector.list()).toEqual([]);
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
    expect(() => host.register({ id: "x", name: "x", version: "1" } as Manifest, async () => ({ activate() {} }))).toThrow(PluginError);
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
