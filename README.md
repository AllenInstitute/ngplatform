# ngplatform

A research workspace around [Neuroglancer](https://github.com/google/neuroglancer):
paste a Neuroglancer link, a state or a data URL; share the workspace as a
link; extend it with plugins. This is the platform shell (build guide Phase 1,
milestones P0–P1) without any plugin yet. The TrackVis-style tractography
plugin comes next.

It consumes the zarr-vectors fork of Neuroglancer
(`Andrew-Keenlyside/neuroglancer`, branch `zarr_vectors_working`) as a
dependency, so Neuroglancer stays the rendering engine and the source of
truth for the view, and this repository holds only the product around it.

## Develop

```bash
git clone https://github.com/Andrew-Keenlyside/neuroglancer ../neuroglancer   # the fork, next to this repo
npm install
npm run dev           # http://localhost:5173
npm test              # unit tests (vitest)
npm run typecheck
npm run build         # dist/, a static site: serve it from any path
```

`npm install` links the fork's source (`file:../neuroglancer`), which runs
its `prepare` script and rewrites the fork's `package.json` in place. Undo
that in the fork with `node build_tools/postpack.ts && rm -rf lib`.

The bundled example is generated, not committed:

```bash
python scripts/make_excerpt.py path/to/store.zarrvectors   # needs zarr-vectors-py and -tools
```

## Test in a browser

```bash
npm run build && (cd dist && python3 -m http.server 4174 &)
node e2e/smoke.mjs http://localhost:4174/
```

Use a server that answers missing files with 404. Vite's preview server
answers with `index.html`, which the zarr-vectors reader's probes take for
data. The smoke test drives the shell in headless Chromium. SwiftShader's
WebGL cannot draw Neuroglancer's views there (the fork's standalone build
fails the same way), so the pointer check is skipped when that happens.

## Layout

| Path | What |
|---|---|
| `src/core/` | state I/O (`{ng, app}` links), undo history, command registry, the Neuroglancer bridge |
| `src/ui/` | shell, docks, palette, Open dialog, panels, styles |
| `src/main.ts` | boot: every import from Neuroglancer lives here and in `viewer_bridge.ts` |
| `scripts/make_excerpt.py` | builds `public/examples/ha1-excerpt.zarrvectors` |
| `e2e/smoke.mjs` | headless smoke test |

## Known limits

- The fork's zarr-vectors reader finds no `zarr.json` through `gs://` URLs.
  Use `https://storage.googleapis.com/...`.
- Over `https://storage.googleapis.com/`, one listing probe is refused
  cross-origin and logs a console error. The layer loads regardless.
