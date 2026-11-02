# Plugins

Each plugin is a folder here. The app ships what [`index.ts`](index.ts)
lists, and the **Plugins** tab (left dock) switches each on or off.

```
plugins/
  index.ts             one entry per plugin: its manifest, and how to load its code
  workers.ts           the worker modules of data-type plugins, by plugin id
  zarr-vectors/        a data type: Zarr Vectors stores in Neuroglancer (an npm package)
  track-filtering/     a tool: TrackVis-style track groups, saved as .trk
  volume-view/         a tool: a solid, cut-open brain in place of the 3-D panel
```

## Adding a plugin

1. **Make a folder**, `plugins/<name>/`, with at least:
   - `manifest.ts`: `export const MY_MANIFEST: Manifest = { id, name, version, kind, … }`
     (see [The manifest](#the-manifest)). The `id` is reverse-DNS and unique,
     e.g. `org.my-lab.layer-stats`.
   - `plugin.ts` (a tool): `export const plugin: PluginModule = { activate(ctx) { … } }`.
   - `tests/*.test.ts`: run by `npm test` with the platform's tests.
   - `README.md`: what it does, who looks after it.
2. **Import the platform only through the SDK**, `@ngplatform/sdk` (types,
   `checkManifest`) and `@ngplatform/sdk/workers` (for a worker of your own
   that reads chunks through Neuroglancer's codecs). Everything a plugin may
   do goes through the `ctx` it is given; nothing in `src/` is imported
   directly. Neuroglancer itself can be imported (`neuroglancer/unstable/…`)
   when a plugin needs its internals, as the data types do.
3. **List it** in [`index.ts`](index.ts):
   ```ts
   { manifest: MY_MANIFEST, load: async () => (await import("./my-plugin/plugin.js")).plugin },
   ```
   A data type instead gives `neuroglancer: () => import("…")` (its
   main-thread module, which registers the data source) and adds its worker
   modules to [`workers.ts`](workers.ts).
4. **Check it**: `npm test` (the catalogue test checks every manifest and
   entry), `npm run typecheck`, `npm run e2e` against a build. A plugin with
   its own `package.json` (as `zarr-vectors/`) can also run its own tests, as
   the root `npm test` does for zarr-vectors.
5. **Describe it**: `description` is one sentence (the Plugins tab shows
   it); `guide` is a short user guide in Markdown (`##` headings, lists,
   `` `code` ``, links) and `links` its repositories and papers, both
   shown behind **Read more**.

### Trying a plugin without building the app

The Plugins tab's **Add** loads a plugin from this computer: a JavaScript
module (one file, bundled) exporting `manifest` (a tool) and `plugin`, or a
folder with `manifest.json` and the module it names as `main`; or a Python
file, run in the Python tab's interpreter, where `@ngp.command("Title")`
adds a function to the command palette. **Reload** reads it again after an
edit. In Chrome and Edge the file is remembered between visits.

**Add → From a URL…** loads a tool plugin someone has published: the URL of
its `manifest.json` (the module named by `main` beside it) or of the module
itself, over https and served with CORS (GitHub Pages and jsDelivr are).
The manifest is read first and shown, with a warning that the code will run
in the page with the app's access; nothing runs until the person agrees.
The URL is remembered and the plugin loads again on later visits until it is
removed; **Reload** fetches it afresh.

Owning a plugin is owning its folder: another team can amend or replace one
without touching the platform or the other plugins, and review stays inside
that folder plus one line in `index.ts`.

## Switching plugins on and off

Switching one on or off reloads the page with the same link, so the
workspace comes back as it was, now with or without the plugin; the choice
is kept in this browser.

- Switching a plugin on also switches on the plugins it requires; switching
  one off also switches off the plugins that require it. The confirmation
  says which.
- A plugin whose requirement is off is off, and the tab says why.
- A workspace with data in a format whose plugin is off says so when it
  opens, and shows the Plugins tab.

Loading plugins from a URL at run time is not supported yet: plugins are
built with the app.

## Two kinds

| Kind | What it does | Its code | Example |
|---|---|---|---|
| **Data type** (`kind: "datatype"`) | Teaches Neuroglancer a format: a data source, with code in Neuroglancer's workers | A Neuroglancer plugin package: a main-thread module (registers the data source) and worker modules | [`zarr-vectors/`](zarr-vectors/) |
| **Tool** (`kind: "tool"`) | Adds to the workspace around the viewer: a tab in the left dock, commands, a view beside Neuroglancer's, analyses | A platform module with `activate(ctx)`, using only the `PlatformContext` | [`track-filtering/`](track-filtering/) (requires Zarr Vectors), [`volume-view/`](volume-view/) |

A data type plugin has no platform code and contributes no commands or
panels; tools that work on its data are separate tool plugins that declare
`requires: { plugins: [<the data type>] }`.

### How a data type reaches Neuroglancer's workers

At start, before the viewer exists, the app imports the main-thread module of
each data type that is on, and tells Neuroglancer to start its workers from
the app's own scripts (`src/engine/workers/`), named with the plugins that are
on. Each worker script imports those plugins' modules from
[`workers.ts`](workers.ts) and then Neuroglancer's own worker contents. This
uses the worker factories in the Neuroglancer the app builds on
(`setChunkWorkerFactory`, `setAsyncComputationWorkerFactory`); see
[`zarr-vectors/README.md`](zarr-vectors/README.md).

### Files a data type reads in place

A data type can also read files on this computer without converting them,
as virtual stores. Its catalogue entry lists them (`virtualFormats`, each a
`VirtualFormat` from `@ngplatform/sdk`: a file-name pattern, extensions for
the file pickers, the layer source for the store's URL, and a worker). Local
data then lists such files in folders and Open from device, and sends every
key under a file's URL to the worker, which answers with
`serveVirtualStores` from `@ngplatform/sdk/virtual`:

```ts
// my_format/worker.ts
import { serveVirtualStores } from "@ngplatform/sdk/virtual";
serveVirtualStores((file) => openMyFormat(file)); // { get(key), list?(prefix) }
```

Zarr Vectors uses this for `.trk`, `.tck` and `.trx`
([`zarr-vectors/virtual.ts`](zarr-vectors/virtual.ts)); the platform's
NIfTI reader is the same kind of worker. `list` answers folder listings
(directory keys end in "/"), which Neuroglancer's http store reads.

`@ngplatform/sdk/precomputed` reads Neuroglancer precomputed volumes in a
plugin's own worker (images and segmentations, sharded or not);
`@ngplatform/sdk/sources` recognises source URLs without loading readers.

## Writing a tool plugin

The types are in [`src/sdk/types.ts`](../src/sdk/types.ts), and the manifest
schema and its checks in [`src/sdk/manifest.ts`](../src/sdk/manifest.ts), both
imported as `@ngplatform/sdk`. Track filtering is a complete example;
[`tests/plugins.test.ts`](../tests/plugins.test.ts) exercises every part of the
host.

### The model a plugin works with

| Word | Meaning |
|---|---|
| **Workspace** | Everything in one link: its scenes, its datasets, every plugin's state. |
| **Scene** | One Neuroglancer state: which datasets are shown, how, where, in what layout. |
| **Dataset** | A piece of data, identified by its source URL. It belongs to the workspace, so any scene can show it. |
| **Layer** | One way a scene shows a dataset (colours, shader, segments). A scene can show a dataset through several layers. |

`ctx.workspace.addLayer(datasetId, overrides)` shows a derived view: the same
dataset with a different shader, subsources or segment set. Track filtering
shows its result that way.

### The manifest

Read without running any code: enough to list the plugin, show its commands
in the palette and its tab in the dock, and decide when to load the code.

```ts
export const MANIFEST: Manifest = {
  id: "org.example.layer-stats",
  name: "Layer statistics",
  version: "0.1.0",
  kind: "tool",
  enabledByDefault: false,
  license: "Apache-2.0",
  requires: { plugins: ["org.ngplatform.zarr-vectors"] },
  contributes: {
    panels: [{ id: "layerStats.panel", title: "Statistics", slot: "left", order: 50 }],
    commands: [
      {
        id: "layerStats.show",
        title: "Statistics of the selected layer",
        when: "sourceFormat == zarr-vectors",
        args: { type: "object", properties: { bins: { type: "integer", minimum: 2, default: 64 } } },
      },
    ],
    keybindings: [{ key: "alt+s", command: "layerStats.show" }],
    appState: { key: "layerStats", version: 1 },
  },
};
```

- **Activation**: using a declared contribution loads the plugin. Activation
  events (`onStartup`, `onCommand:<id>`, `onView:<panel>`,
  `onDatasetKind:<kind>`, `onOpen:<regex>`) load it earlier.
- **`when` clauses** read context keys: the platform's own (`hasLayers`,
  `sceneIsEmpty`, `sceneCount`, `selectedLayer`, `selectedLayerType`,
  `datasetKind`, `sourceFormat`, `canUndo`, `canRedo`, `framed`) and any the
  plugin lists in `contributes.contextKeys` and sets with `ctx.context.set`.
  Syntax: `a`, `!a`, `a == x`, `a != x`, joined with `&&` and `||`.
- **Checks** (`checkManifest`): the schema, commands named by keys and
  dataset actions exist, activation events name declared things, `when`
  clauses read only declared keys, and data types contribute no UI.

### The code

```ts
export const plugin: PluginModule = {
  activate(ctx) {
    ctx.commands.register("layerStats.show", async ({ bins }: { bins: number }) => {
      const layer = ctx.workspace.selectedLayer();
      const props = layer && ctx.viewer.segmentProperties(layer);
      ctx.state.set({ layer, bins, n: props?.ids.length });
    });
    ctx.ui.panel("layerStats.panel", (host) => {
      host.textContent = "…";
      return ctx.viewer.onLayersChanged(() => { /* redraw */ }); // disposed with the panel
    });
  },
};
```

Everything registered through `ctx` is owned by the plugin and removed when
it is deactivated. Subscriptions a plugin makes itself go in
`ctx.subscriptions`.

### What the context offers

| Part | For |
|---|---|
| `commands.register / invoke` | Supply declared commands; call any command with arguments (validated against the declared schema, defaults filled in). |
| `ui.panel / showPanel` | Render declared panels; return a disposer for cleanup. |
| `ui.view` | Show a view beside Neuroglancer's, where its 3-D panel would be; one at a time, with a draggable divider. |
| `ui.viewToggle` | A switch beside "Sections" in the 3-D panel (volume rendering's "Volume"). |
| `ui.overlay / screenshotOverlay` | An element over the views, and painting into Neuroglancer's screenshots (labels use both). |
| `ui.toast / confirm / form` | Messages, confirmation, and a dialog generated from a schema. |
| `workspace` | Scenes, datasets, layers and the selection; add datasets and derived layers, remove layers. |
| `viewer` | The active scene's Neuroglancer state as JSON (`patchState` applies only what changed, as one undo step), layers, the pointer, the position, a segmentation layer's segment properties, and a temporary set of visible segments (not saved in the link). `draw3d` draws in the 3-D view with a layer (raw WebGL2, Neuroglancer's camera and depth; volume rendering uses it); `panels` and `onRendered` place things over the views; `layerTransform` and `setLayerTransform` read and set a layer's transform (registration). |
| `workspace.local` | Files of data opened from this computer: whether a URL is one, and writing into it (track filtering saves groups this way). |
| `state` | The plugin's slice of the workspace state: in the link, undoable, versioned. |
| `settings` | Per-user settings kept in this browser, never in the link. |
| `jobs.run` | Long work with progress and cancel, shown in the Jobs tab. |
| `services.provide / get` | Share an API with other plugins (`get` waits for the provider). |
| `open.handler` | Handle pasted text matching a declared pattern. |
| `log` | Lines in the Activity tab, tagged with the plugin. |
| `auth.register` | Add a sign-in method to the Auth tab (see below). |

### Sign-in

The Auth tab lists what the workspace's data needs a sign-in for, with who
is signed in, and buttons to sign in, sign out and check. Middleauth (the
Google sign-in CAVE-style servers use, for `middleauth+https://` data) is
built in and keeps its tokens where Neuroglancer does, so either can sign in
for the other. A plugin adds another check with an `AuthProvider`:

```ts
ctx.auth.register({
  id: "my-lab",
  title: "My lab's data",
  accepts: (server) => server.startsWith("https://data.my-lab.org"),
  async services({ sources, manual }) {
    // One service per thing to sign in to, found from the workspace's
    // data sources and the servers typed into the Auth tab.
    return [{
      id: "my-lab:main",
      title: "data.my-lab.org",
      async status() { return { state: "signed-out" }; },
      async signIn() { /* open the sign-in window first, before any await */ },
      async signOut() {},
    }];
  },
});
```

`signIn` is called straight from the click, so a window it opens before its
first `await` is not blocked. Data that a viewer layer already opened keeps
the sign-in it had; the tab offers a reload, which keeps the workspace.

### Failure and trust

- A plugin's exceptions are logged against it and never reach the shell or
  Neuroglancer; three in a session stop it until the next load.
- Plugins run in the page with full privileges. `permissions` in the
  manifest are shown to the user, not enforced.
- Plugins that wrap GPL code (NAVis, a Lead-DBS port) are distributed
  separately and say so in `license`.
