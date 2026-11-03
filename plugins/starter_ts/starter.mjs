/**
 * A starter tool plugin as one JavaScript file: load it in the app with
 * Plugins → Add (no build needed), edit it, and press Reload.  The same as
 * the TypeScript plugin beside it (manifest.ts, plugin.ts), which is the
 * one to copy when a plugin is to be built into the app.
 *
 * It exports `manifest` (what the platform shows before running any code)
 * and `plugin` (`activate(ctx)`, given the platform's API: see
 * plugins/README.md, "What the context offers").
 */

export const manifest = {
  // Reverse-DNS and stable: it keys the plugin's state in links.
  id: "org.example.starter-js",
  name: "Starter (JavaScript)",
  version: "0.1.0",
  kind: "tool",
  description: "An empty tool plugin to copy: a tab listing the scene's layers, a counter kept in the scene, and a command.",
  activation: ["onStartup"],
  contributes: {
    panels: [{ id: "starterJs.panel", title: "Starter", slot: "left", order: 99 }],
    commands: [{ id: "starterJs.hello", title: "Starter: say hello", group: "Starter" }],
    // The plugin's slice of the workspace state, under this key; raise the version when its shape changes.
    appState: { key: "starterJs", version: 1 },
  },
};

export const plugin = {
  activate(ctx) {
    // The plugin's state: in the link, undoable, and each scene's own.
    const count = () => {
      const n = ctx.state.get()?.count;
      return typeof n === "number" ? n : 0;
    };

    ctx.commands.register("starterJs.hello", () => {
      ctx.ui.toast("Hello from the starter plugin.");
      ctx.log.info("Said hello.");
    });

    ctx.ui.panel("starterJs.panel", (host) => {
      const draw = () => {
        const layers = ctx.viewer.layers();
        const list = document.createElement("ul");
        for (const l of layers) {
          const item = document.createElement("li");
          item.textContent = `${l.name} (${l.type})`;
          list.append(item);
        }
        const button = document.createElement("button");
        button.className = "btn small";
        button.textContent = `Counted ${count()}: add one`;
        button.onclick = () => ctx.state.set({ count: count() + 1 });
        host.replaceChildren(list, button);
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
