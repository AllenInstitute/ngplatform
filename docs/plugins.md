# Writing a plugin

There are two kinds, at two levels:

- A **platform plugin** (this guide) adds to the workspace around the
  viewer: commands, panels, Inspector sections, analyses. It never touches
  Neuroglancer.
- A **Neuroglancer plugin** adds a data format to Neuroglancer itself, with
  code in Neuroglancer's workers. `packages/neuroglancer-zarr-vectors` is
  one; its README says how an application adds it, and
  `src/engine/plugins.ts` is where the platform does. A platform plugin can
  build on one (the zarr-vectors store facts here read what the Zarr
  Vectors plugin loads).

A plugin adds to the workspace: commands, panels in the docks, sections in
the Inspector, key bindings, examples, handlers for pasted links, a slice of
the workspace state, and services for other plugins. It never touches
Neuroglancer: it works through the `PlatformContext` it is given, so a
rebase of the Neuroglancer fork does not break it.

The types are in [`src/sdk/types.ts`](../src/sdk/types.ts), and the manifest
schema and its checks in [`src/sdk/manifest.ts`](../src/sdk/manifest.ts).
[`src/builtins/zarr_vectors.ts`](../src/builtins/zarr_vectors.ts) is a small
plugin the platform ships, and
[`tests/plugins.test.ts`](../tests/plugins.test.ts) exercises every part of
the host.

## The model a plugin works with

| Word | Meaning |
|---|---|
| **Workspace** | Everything in one link: its scenes, its datasets, every plugin's state. |
| **Scene** | One Neuroglancer state: which datasets are shown, how, where, in what layout. |
| **Dataset** | A piece of data, identified by its source URL. It belongs to the workspace, so any scene can show it. |
| **Layer** | One way a scene shows a dataset (colours, shader, segments). A scene can show a dataset through several layers. |

`ctx.workspace.addLayer(datasetId, overrides)` is how a plugin shows a
derived view: the same dataset with a different shader or segment set, or a
derived source (a filtered store) recorded against the dataset it came from.

## 1. The manifest

The manifest is read without running any code. It is enough to list the
plugin, show its commands in the palette and its panels in the docks, and
decide when to load the code.

```json
{
  "id": "org.example.layer-stats",
  "name": "Layer statistics",
  "version": "0.1.0",
  "license": "Apache-2.0",
  "activation": ["onCommand:layerStats.show"],
  "contributes": {
    "commands": [
      {
        "id": "layerStats.show",
        "title": "Statistics of the selected layer",
        "when": "selectedLayerType == image",
        "args": { "type": "object", "properties": { "bins": { "type": "integer", "minimum": 2, "default": 64 } } }
      }
    ],
    "keybindings": [{ "key": "alt+s", "command": "layerStats.show" }],
    "panels": [{ "id": "layerStats.panel", "title": "Statistics", "slot": "right" }],
    "inspector": [{ "id": "layerStats.summary", "title": "Statistics", "when": "selectedLayerType == image" }],
    "appState": { "key": "layerStats", "version": 1 }
  }
}
```

- **Activation events**: `onStartup`, `onCommand:<id>`, `onView:<panel>`,
  `onDatasetKind:<kind>`, `onOpen:<regex>`. Using any declared contribution
  also activates the plugin, so most plugins need none.
- **`when` clauses** read context keys: the platform's own (`hasLayers`,
  `sceneIsEmpty`, `sceneCount`, `selectedLayer`, `selectedLayerType`,
  `datasetKind`, `sourceFormat`, `canUndo`, `canRedo`, `framed`) and any the
  plugin lists in `contributes.contextKeys` and sets with `ctx.context.set`.
  Syntax: `a`, `!a`, `a == x`, `a != x`, joined with `&&` and `||`.
- **Checks** (`checkManifest`): the schema, commands named by keys and dataset
  actions exist, activation events name declared things, and `when` clauses
  read only declared keys.

## 2. The code

```ts
import type { PluginModule } from "../sdk/types.js"; // src/sdk/types.ts

export const plugin: PluginModule = {
  activate(ctx) {
    ctx.commands.register("layerStats.show", async ({ bins }: { bins: number }) => {
      const layer = ctx.workspace.selectedLayer();
      return ctx.jobs.run(`Statistics of ${layer}`, async (job) => {
        job.progress(0.5, "Reading chunks");
        if (job.cancelled) return;
        ctx.state.set({ layer, bins });
      });
    });

    ctx.ui.panel("layerStats.panel", (host) => {
      host.textContent = "…";
      const off = ctx.viewer.onLayersChanged(() => { /* redraw */ });
      return off; // called when the panel goes away
    });

    ctx.ui.inspectorSection("layerStats.summary", (host, { dataset, layer }) => {
      host.textContent = `${dataset?.name}: ${layer?.type}`;
    });
  },
};
```

Everything registered through `ctx` is owned by the plugin and removed when
it is deactivated or unregistered. Subscriptions a plugin makes itself go in
`ctx.subscriptions`.

## 3. Registering

Built-in plugins are registered at boot, as `src/builtins/index.ts` does:

```ts
wb.plugins.register(manifest, async () => (await import("./layer_stats.js")).plugin);
```

Loading external plugins from a URL, with a consent dialog showing their
`permissions`, is the next step for the host; the manifest field `main`
already names the module.

## What the context offers

| Part | For |
|---|---|
| `commands.register / invoke` | Supply declared commands; call any command with arguments. Arguments are validated against the declared schema and get its defaults. |
| `ui.panel / inspectorSection / showPanel` | Render declared panels and Inspector sections. Return a disposer for cleanup. |
| `ui.toast / confirm / form` | Messages, confirmation, and a dialog generated from a schema. |
| `workspace` | Scenes, datasets, layers, the selection; add datasets and derived layers. |
| `viewer` | The active scene's Neuroglancer state as JSON (`patchState` applies only what changed, as one undo step), layers, the pointer, the position. |
| `state` | The plugin's slice of the workspace state: in the link, undoable, versioned. Bump `appState.version` and handle older data in your own migration when its shape changes. |
| `settings` | Per-user settings kept in this browser, never in the link. |
| `jobs.run` | Long work with progress and cancel, shown in the Jobs tab. |
| `services.provide / get` | Share an API with other plugins (`get` waits for the provider). |
| `open.handler` | Handle pasted text matching a declared pattern. |
| `log` | Lines in the Activity tab, tagged with the plugin. |

## Failure and trust

- A plugin's exceptions are logged against it and never reach the shell or
  Neuroglancer; three in a session disable it.
- Plugins run in the page with full privileges. `permissions` in the
  manifest are shown to the user, not enforced.
- Plugins that wrap GPL code (NAVis, a Lead-DBS port) are distributed
  separately and say so in `license`.
