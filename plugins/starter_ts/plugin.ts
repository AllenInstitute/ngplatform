/**
 * The starter plugin's code: a tab that lists the scene's layers and keeps
 * a counter in the scene's state, and a command.  Everything registered
 * through `ctx` is removed when the plugin is switched off.
 */
import type { PlatformContext, PluginModule } from "@ngplatform/sdk";
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

/** A line about the scene's layers, for the tab. */
export function describeLayers(layers: { name: string; type: string; visible: boolean }[]): string {
  if (layers.length === 0) return "This scene has no layers.";
  const shown = layers.filter((l) => l.visible).length;
  return `${layers.length} layer${layers.length === 1 ? "" : "s"}, ${shown} shown`;
}

export const plugin: PluginModule = {
  activate(ctx: PlatformContext) {
    const saved = () => readSaved(ctx.state.get());

    ctx.commands.register("starter.hello", () => {
      const layer = ctx.workspace.selectedLayer();
      ctx.ui.toast(layer ? `Hello from the starter plugin; the selected layer is ${layer}.` : "Hello from the starter plugin.");
      ctx.log.info("Said hello.");
    });

    ctx.ui.panel(STARTER_PANEL, (host) => {
      const draw = () => {
        const layers = ctx.viewer.layers();
        const list = document.createElement("ul");
        for (const l of layers) {
          const item = document.createElement("li");
          item.textContent = `${l.name} (${l.type}${l.visible ? "" : ", hidden"})`;
          list.append(item);
        }
        const count = document.createElement("button");
        count.className = "btn small";
        count.textContent = `Counted ${saved().count}: add one`;
        count.onclick = () => ctx.state.set({ count: saved().count + 1 });
        const summary = document.createElement("p");
        summary.className = "note";
        summary.textContent = describeLayers(layers);
        host.replaceChildren(summary, list, count);
      };
      draw();
      // Drawn again when the layers change, and when the state does (an undo, another scene).
      const offLayers = ctx.viewer.onLayersChanged(draw);
      const offState = ctx.state.onChanged(draw);
      return () => {
        offLayers();
        offState();
      };
    });
  },
};
