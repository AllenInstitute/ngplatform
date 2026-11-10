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
  description: "An empty tool plugin to copy: a panel listing the scene's layers, a counter kept in the scene, and a command.",
  activation: ["onStartup"],
  contributes: {
    // A tool's panel (slot "left") is listed in the Tools dock under its group.
    panels: [{ id: "starterJs.panel", title: "Starter", slot: "left", group: "Other", order: 99 }],
    commands: [{ id: "starterJs.hello", title: "Starter: say hello", group: "Starter" }],
    // The plugin's slice of the workspace state, under this key; raise the version when its shape changes.
    appState: { key: "starterJs", version: 1 },
  },
};

/** An element with a class and children (a file loaded this way cannot import @ngplatform/sdk/dom). */
function el(tag, className, ...children) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  e.append(...children);
  return e;
}

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
      // Drawn once, with the app's classes; then only what changed is updated.
      const open = el("button", "btn outline", "Open data…");
      open.type = "button";
      open.onclick = () => void ctx.commands.invoke("dataset.add");
      const empty = el("div", "empty-state", el("p", "empty", "No layers in this scene."), open);
      const list = el("ul", "list");
      const add = el("button", "btn outline small");
      add.type = "button";
      add.onclick = () => ctx.state.set({ count: count() + 1 });
      host.append(empty, list, el("div", "row", add));
      let names = "";
      const sync = () => {
        const layers = ctx.viewer.layers();
        empty.hidden = layers.length > 0;
        // The list is drawn again only when the layers it shows change.
        const now = JSON.stringify(layers.map((l) => [l.name, l.type]));
        if (now !== names) {
          names = now;
          list.replaceChildren(...layers.map((l) => el("li", "", `${l.name} (${l.type})`)));
        }
        add.textContent = `Counted ${count()}: add one`;
      };
      sync();
      // Kept up to date when the layers change, and when the state does (an undo, another scene).
      const offLayers = ctx.viewer.onLayersChanged(sync);
      const offState = ctx.state.onChanged(sync);
      return () => {
        offLayers();
        offState();
      };
    });
  },
};
