<p align="center">
  <img src="docs/logo.svg" alt="ngplatform" width="313" height="72" />
</p>

A workspace around [Neuroglancer](https://github.com/google/neuroglancer),
extended by plugins. Live at https://alleninstitute.github.io/ngplatform/.

## Add a plugin

Each plugin is a folder in [`plugins/`](plugins/):

```
plugins/
  index.ts             the list of plugins the app ships: add yours here
  workers.ts           worker modules of data-type plugins
  my-plugin/
    manifest.ts        what the platform shows before loading any code
    plugin.ts          export const plugin: PluginModule = { activate(ctx) { … } }
    tests/             *.test.ts, run by npm test
    README.md
```

1. Copy a plugin folder close to what you need:
   [`track-filtering`](plugins/track-filtering/) or
   [`volume-view`](plugins/volume-view/) for a tool, or
   [`zarr-vectors`](plugins/zarr-vectors/) for a data format.
2. Give it a manifest with a unique `id`, and import the platform only as
   `@ngplatform/sdk`.
3. Add one line for it to [`plugins/index.ts`](plugins/index.ts) (and, for a
   data format, its worker modules to [`plugins/workers.ts`](plugins/workers.ts)).
4. `npm test` checks the manifest and the entries; the **Plugins** tab
   switches it on and off.

To try one without building, the Plugins tab's **Add** loads a
JavaScript module or a Python file from your computer, and reloads it after
each edit.

The full guide, with the manifest, the `ctx` API and examples:
[`plugins/README.md`](plugins/README.md).

## Run it

```bash
git clone -b ngplatform-upstream https://github.com/Andrew-Keenlyside/neuroglancer ../neuroglancer
(cd ../neuroglancer && npm ci && node build_tools/postpack.ts && rm -rf lib)
npm install
npm run dev        # http://localhost:5173
npm test           # the platform and every plugin
npm run typecheck
npm run e2e        # tests/e2e/smoke.mjs, in Chrome, against a served build
```

Where things stand: [`STATUS.md`](STATUS.md).
