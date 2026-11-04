# Plugins

Each plugin is a folder here. The app ships what [`index.ts`](index.ts)
lists, and the **Plugins** tab (left dock) switches each on or off. Only Zarr
Vectors is on by default; the others are offered when data they work with is
opened (below).

```
plugins/
  index.ts             one entry per plugin: its manifest, and how to load its code
  workers.ts           the worker modules of data-type plugins, by plugin id
  zarr-vectors/        a data type: Zarr Vectors stores in Neuroglancer (an npm package)
  track-filtering/     a tool: TrackVis-style track groups, saved as .trk
  volume-view/         a tool: a solid, cut-open brain in place of the 3-D panel
  luxar/               a tool: chosen Zarr Vectors layers drawn as Luxar draws lines, in the 2-D and 3-D views
  atlas/               a tool: a segmentation's regions as a tree (Allen CCF, FreeSurfer), shown, gone to, under the cursor
```

## Starting from the starter plugins

Three empty plugins to copy, each with a tab that lists the scene's layers,
a counter kept in the scene's state, and a command:

| Starter | For | How to use it |
|---|---|---|
| [`starter_ts/`](starter_ts/) | A TypeScript plugin built into the app | Copy the folder, rename it and its ids, list it in `index.ts` (below) |
| [`starter_ts/starter.mjs`](starter_ts/starter.mjs) | The same as one JavaScript file, no build | Plugins → **Add**, then **Reload** after each edit |
| [`starter_py/`](starter_py/) | Python, in the page's Python (Pyodide): only `.py` files and a README | Plugins → **Add** its `starter.py`; `@ngp.command` adds a command, `@ngp.panel` a tab |

## Adding a plugin

1. **Make a folder** (or copy `starter_ts/`), `plugins/<name>/`, with at least:
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
   {
     manifest: MY_MANIFEST,
     load: async () => (await import("./my-plugin/plugin.js")).plugin,
     summary: "One line for the Plugins tab.",
     group: "images",
     offer: OFFERS[MY_MANIFEST.id], // when to offer it while it is off (offers.ts)
   },
   ```
   `group` places it in the Plugins tab (data types, vectors, images,
   segmentations and atlases, annotation). A data type instead gives
   `neuroglancer: () => import("…")` (its main-thread module, which
   registers the data source) and adds its worker modules to
   [`workers.ts`](workers.ts).
4. **Check it**: `npm test` (the catalogue test checks every manifest and
   entry), `npm run typecheck`, `npm run e2e` against a build. A plugin with
   its own `package.json` (as `zarr-vectors/`) can also run its own tests, as
   the root `npm test` does for zarr-vectors.
5. **Describe it**: the catalogue entry's `summary` is the one line the
   Plugins tab shows; `description` is one sentence, and `guide` a short
   user guide in Markdown (`##` headings, lists, `` `code` ``, links) with
   `links` its repositories and papers, all shown behind **About**.

### Trying a plugin without building the app

The Plugins tab's **Add** loads a plugin from this computer: a JavaScript
module (one file, bundled) exporting `manifest` (a tool) and `plugin`, or a
folder with `manifest.json` and the module it names as `main`; or a Python
file, run in the Python tab's interpreter, where `@ngp.command("Title")`
adds a function to the command palette and `@ngp.panel("Title")` a tab
(drawn by a function given the tab's element, when shown and whenever the
workspace changes; the page's DOM is reachable through Pyodide's `js`). **Reload** reads it again after an
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

Only Zarr Vectors is on by default (`enabledByDefault`); every other plugin
is off until someone turns it on, from the Plugins tab or from an offer.
The choice is kept in this browser.

- A tool plugin turns on at once, without a reload (`PluginHost.switchOn`):
  its tabs, commands and keys appear, and it activates as its manifest says.
  A data type plugin turns on with a reload, as its Neuroglancer modules
  load only with the page. Turning any plugin off reloads the page. A reload
  keeps the link, so the workspace comes back as it was.
- Turning a plugin on also turns on the plugins it requires; turning one
  off also turns off the plugins that require it. The confirmation says
  which.
- A plugin whose requirement is off is off, and the tab says why.
- **Offers.** When data a tool plugin works with is opened while it is
  off, the Datasets tab lists it under *Tools for this data*, with a button
  to turn it on and one for "Not now"; some offers also show once in a
  toast. Each entry in [`index.ts`](index.ts) has an `offer`
  ([`offers.ts`](offers.ts)): a few words on what it does, whether it is
  worth a toast, and `applies(scene)`, which looks at the scene's layers
  (and, at most once per URL, a store's metadata). Settings → *Show offers
  for tools that are off* turns them all off.
- A workspace that holds state of a plugin that is off (a link with track
  groups, say) says "This workspace uses Track filtering, which is off",
  with **Turn on**. The state stays in the workspace either way.
- An example can name the tool plugins it is shown with (`plugins` in its
  spec): opening it turns them on for this tab only, unless this browser
  turned them off. The S-21-46 and HCP-1065 examples do so for Track
  filtering.
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

Zarr Vectors uses this for tractograms, meshes and surfaces, SWC neurons
and point tables ([`src/virtual/vectors/formats.ts`](../src/virtual/vectors/formats.ts)); the
platform's NIfTI and TIFF reader is the same kind of worker. `list` answers
folder listings (directory keys end in "/"), which Neuroglancer's http store
reads. A text format can set `collect` to offer a folder of its files as one
dataset (the folder's `@all<extension>`): the worker then gets one text,
each file after a `# @file <name>` line (SWC does).

A tool plugin can list a virtual format too, for data it makes in the page:
Segmentation serves the label volumes being drawn this way (a format whose
"worker" answers in the page), and calls `viewer.reloadData(url)` after each
stroke so Neuroglancer reads the changed store again.

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
- **Panels** (`contributes.panels`): a tab in a dock (`left`, `right` or
  `bottom`), in `order`; `minSize` (pixels) grows the dock to at least that
  while the panel is shown (the annotation table asks for 300), without
  changing the size the person set.
- **Scene kinds** (`contributes.sceneKinds: [{kind, title, panel}]`): a
  kind of scene the plugin adds, shown in the scene bar while the plugin is
  on. Before one exists its tab (dashed) makes it; switching to it shows
  `panel`. The plugin sees the active scene's `kind` in
  `workspace.scenes()` and makes one with `workspace.newScene({kind})`; its
  state slice is that scene's, as in any scene. The Collections tab is one.
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
| `workspace` | Scenes, datasets, layers and the selection; add datasets and derived layers, remove layers. `undoSteps` gives the change the workspace's undo and redo would take, with when it was made (Segmentation undoes strokes and workspace changes as one history with it). |
| `viewer` | The active scene's Neuroglancer state as JSON (`patchState` applies only what changed, as one undo step), layers, the pointer, the position, a segmentation layer's segment properties, and a temporary set of visible segments (not saved in the link). `draw3d` draws in the 3-D view with a layer (raw WebGL2, Neuroglancer's camera and depth; volume rendering uses it); `panels` and `onRendered` place things over the views; `layerTransform` and `setLayerTransform` read and set a layer's transform (registration); `reloadData` has Neuroglancer read again what it holds from a URL (data a plugin serves and changed: Segmentation's label volumes). `lookupTables` lists the lookup tables that come with the app, reads one, and reads or sets a segmentation layer's (Atlas). |
| `workspace.local` | Files of data opened from this computer: whether a URL is one, writing into it (track filtering saves groups this way), and opening a file the plugin made in the page as data (track filtering's density maps). |
| `state` | The plugin's slice of the workspace state: in the link, undoable, versioned. |
| `settings` | Per-user settings kept in this browser, never in the link. |
| `jobs.run` | Long work with progress and cancel, shown in the Jobs tab. |
| `runner` | Jobs on the user's own computer, through the runner they paired in the Jobs tab (see below). |
| `services.provide / get` | Share an API with other plugins (`get` waits for the provider). |
| `open.handler` | Handle pasted text matching a declared pattern. |
| `log` | Lines in the Activity tab, tagged with the plugin. |
| `auth.register` | Add a sign-in method to the Auth tab (see below). |

### Sign-in

The Auth tab lists the sign-ins available, with who is signed in, and
buttons to sign in, sign out and check; below them, each layer of the
active scene has a drop-down of the sign-ins its data can be read with.
Built in are Google (one or more accounts for the browser, read as
`gs+google://`, with rules choosing the account per bucket), middleauth
(the Google sign-in CAVE-style servers use, for `middleauth+https://` data,
with its tokens where Neuroglancer keeps them, so either can sign in for the
other) and ngauth (`gs+ngauth+https://`). A plugin adds another with an
`AuthProvider`:

```ts
ctx.auth.register({
  id: "my-lab",
  title: "My lab's data",
  accepts: (server) => server.startsWith("https://data.my-lab.org"),
  async services({ sources, manual }) {
    // One service per thing to sign in to, found from the workspace's
    // data sources and the servers typed into the Auth tab for this provider.
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

A provider whose sign-in a layer chooses by its source's scheme (as
Neuroglancer chooses credentials) adds `sourceSignIns`, which the layers'
drop-downs offer. Each says how to turn a plain address (`gs://bucket/path`
or `https://host/path`) into one read with it, and back:

```ts
sourceSignIns: () => [{
  id: "my-lab",
  title: "My lab",
  storage: "http",
  wrap: (plain) => `mylab+${plain}`,
  unwrap: (address) => address.match(/^mylab\+(https?:\/\/.*)$/)?.[1],
}],
```

The scheme itself (`mylab+https://`) is registered with Neuroglancer by a
data type plugin.

The sign-in rules of the Auth tab (an address prefix and a sign-in, kept in
the browser) can name a provider's source sign-in by its `id`: a layer from
an address a rule covers is given that sign-in when it is added or its
workspace opens, through `wrap`. Keep `id`s stable, since rules store them.

### Jobs on this computer

Work too large for the page (a whole tractogram filtered into a new file,
a conversion) runs as a Python process on the user's computer, through the
runner (`runner/` in this repository; [the guide](../docs/guide/local-jobs.md)).
The runner offers known job kinds only (`convert`, `filter`, `density`),
reads and writes only under the folders it was started with, and the app
must be paired with it in the Jobs tab. `ctx.runner` is the plugin's way to
it:

```ts
if (!ctx.runner.available()) return; // not paired, or not running
// The file behind a layer the runner serves; else ask the user for it.
const input = (await ctx.runner.pathOf(source)) ?? (await ctx.runner.choose({ title: "The tractogram", mode: "open", find: { name: "tracks.trk" } }));
if (input === undefined) return;
const job = await ctx.runner.start("filter", {
  input,
  filter: { format: "zvf-predicate", version: 1, tree: { op: "passes", mode: "path", region: { type: "sphere", center: [10, 0, 0], radius: 8 } } },
  trk: input.replace(/\.trk$/, "_sphere.trk"),
});
const done = await ctx.runner.wait(job.id, (now) => console.log(now.progress, now.message));
if (done.state === "done") await ctx.runner.open(done.outputs[0].path); // a layer, served by the runner
```

| Call | What |
|---|---|
| `available()`, `onChanged(cb)` | Whether a paired runner answers, and a callback when that or its jobs change |
| `folders()` | The folders the runner may read and write |
| `jobs()` | Its jobs as last fetched: `id, kind, title, args, pid, state` (queued, running, done, failed, cancelled), `progress` (0–1 or null), `message, outputs` (`[{path, type}]`) |
| `start(kind, args)` | Starts a job; rejects with the runner's reason when it refuses the arguments (a path outside its folders, an output that exists) |
| `wait(id, onProgress?, signal?)` | The job once it has finished |
| `cancel(id)` | Ends the job's process and what it started |
| `pathOf(source)` | The path behind a layer source the runner serves |
| `choose({title, mode, suggested?, find?, note?})` | A dialog for a path under the runner's folders: one to read (`"open"`, with `find` looking for a file by name and size first) or a new one to write (`"save"`) |
| `open(path, {name?})` | Adds a store, tractogram or NIfTI under the runner's folders to the active scene, served by the runner |

A `filter` job's `filter` is zarr-vectors-tools' filter tree, in the
coordinates the viewer shows the input in (Track filtering's
`runner_job.ts` turns a group into one). The kinds and their arguments are
in [runner/README.md](../runner/README.md).

### Failure and trust

- A plugin's exceptions are logged against it and never reach the shell or
  Neuroglancer; three in a session stop it until the next load.
- Plugins run in the page with full privileges. `permissions` in the
  manifest are shown to the user, not enforced.
- Plugins that wrap GPL code (NAVis, a Lead-DBS port) are distributed
  separately and say so in `license`.
