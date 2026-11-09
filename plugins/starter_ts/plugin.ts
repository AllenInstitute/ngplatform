/**
 * The starter plugin's code: a panel that lists the scene's layers and keeps
 * a counter in the scene's state, and a command.  Everything registered
 * through `ctx` is removed when the plugin is switched off.
 *
 * The panel is built the way every panel is (plugins/README.md, "Building a
 * panel"): from the SDK's parts (cards, fields, an empty state with its
 * action, a status line for progress and errors), drawn once and then
 * updated in place, so a change of state never closes a select or takes a
 * value from under the person typing it.
 */
import type { PlatformContext, PluginModule } from "@ngplatform/sdk";
import { button, card, el, emptyState, field, numberInput, region, statusLine } from "@ngplatform/sdk/dom";
import { STARTER_PANEL } from "./manifest.js";

/** The plugin's state: in the link, undoable, and each scene's own. */
interface Saved {
  count: number;
}

/** Reads the saved state, whatever an older version (or nothing) left. */
export function readSaved(raw: unknown): Saved {
  const count = (raw as Partial<Saved> | undefined)?.count;
  return { count: typeof count === "number" && Number.isFinite(count) ? count : 0 };
}

/** The layers card's badge: how many of the scene's layers are shown. */
export function describeLayers(layers: { name: string; type: string; visible: boolean }[]): string {
  if (layers.length === 0) return "";
  return `${layers.filter((l) => l.visible).length} of ${layers.length} shown`;
}

/**
 * Draws the panel into `host` and keeps it up to date; returns what stops
 * that (the panel is disposed when hidden or the plugin is switched off).
 */
export function renderPanel(ctx: PlatformContext, host: HTMLElement): () => void {
  const saved = () => readSaved(ctx.state.get());

  // Drawn once.  Each part that changes is a region (drawn again when its
  // key changes) or a control with set().
  const badge = el("span");
  const empty = emptyState("No layers in this scene.", { label: "Open data…", run: () => void ctx.commands.invoke("dataset.add") });
  const list = region((layers: [string, string, boolean][]) => layers.map(([name, type, visible]) => el("li", { class: visible ? undefined : "faint" }, `${name} (${type})`)), { class: "list" });
  const status = statusLine();
  const copy = async () => {
    status.progress("Copying…");
    try {
      await navigator.clipboard.writeText(ctx.viewer.layers().map((l) => l.name).join("\n"));
      status.clear(); // Done: nothing to report.
    } catch (e) {
      status.error(`Could not copy: ${(e as Error).message}`, { label: "Retry", run: () => void copy() });
    }
  };
  const copyButton = button("Copy the names", () => void copy());
  const count = numberInput(saved().count, (v) => ctx.state.set({ count: Math.round(v) }), { step: 1 });

  host.append(
    card("starter.layers", "Layers", { open: true, badge }, empty, list, el("div", { class: "row" }, copyButton), status),
    card(
      "starter.counter",
      "Counter",
      { info: "Kept in the scene's state: in the link, undone with Undo, and each scene's own." },
      el("div", { class: "row" }, field("Count", count), button("Add one", () => ctx.state.set({ count: saved().count + 1 }))),
    ),
  );

  // Brings the panel up to date: called when the layers or the state change.
  const sync = () => {
    const layers = ctx.viewer.layers();
    empty.hidden = layers.length > 0;
    list.update(layers.map((l) => [l.name, l.type, l.visible]));
    badge.textContent = describeLayers(layers);
    copyButton.disabled = layers.length === 0;
    count.set(saved().count);
  };
  sync();
  const offLayers = ctx.viewer.onLayersChanged(sync);
  const offState = ctx.state.onChanged(sync);
  return () => {
    offLayers();
    offState();
  };
}

export const plugin: PluginModule = {
  activate(ctx: PlatformContext) {
    ctx.commands.register("starter.hello", () => {
      const layer = ctx.workspace.selectedLayer();
      ctx.ui.toast(layer ? `Hello from the starter plugin; the selected layer is ${layer}.` : "Hello from the starter plugin.");
      ctx.log.info("Said hello.");
    });
    ctx.ui.panel(STARTER_PANEL, (host) => renderPanel(ctx, host));
  },
};
