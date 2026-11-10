# Casts into Neuroglancer's internals

The Layers panel's controls (`src/engine/inspector`) are built on
Neuroglancer's own widgets and layer state, much of which Neuroglancer does
not export with types the app can use. They reach it through type
assertions. They are not rewritten: each works against the pinned
Neuroglancer commit (`package.json` → `neuroglancer.commit`), and the
type checker cannot see when a Neuroglancer change breaks one. This page
lists them so a bump of the pin knows where to look.

## Finding them

```bash
npm run casts                     # counts by kind and by file
npm run casts -- --list           # every cast, file:line, its kind and type
npm run casts -- --list any       # one kind
```

`scripts/neuroglancer_casts.mjs` reads the files with the TypeScript
parser, so it counts `x as unknown as T` once and skips `as const`. A grep
that finds most of them:

```bash
grep -nE '\bas (any|never|unknown as|Watch<|\{)' src/engine/inspector/*.ts
```

## By kind

Counted at the Phase 5 polish (base `9699bc8`): 126 type assertions in
`src/engine/inspector`, 91 of them into Neuroglancer's internals.

| Kind | Count | What it does | When Neuroglancer changes |
|---|---|---|---|
| `as any` | 35 | Reaches a member Neuroglancer has but does not declare, or declares private: a layer's `tabs`, `panels`, `annotationStates`, `displayState` fields, `dataSources`, `manager.layerManager`, `selectAnnotation`. | The member may be renamed or gone with no type error: the control then throws or shows nothing. Check each against the new source. |
| `as never` | 24 | Hands a value to a Neuroglancer function whose parameter type is internal or narrower than the app's (shader controls' `makeControl`, `Widget`, `packColor`, a source's `spec`). | The parameter's shape may change; the value still compiles. |
| `as Watch<…>` | 16 | Reads a Neuroglancer property as a watchable value (`value` and `changed`) for the panel's own controls: a colormap, a selected tab, a skeleton's shader. | A property that stops being watchable (or changes its value's type) leaves the control stale. |
| `as { … }`, `as unknown as …` | 10 | A structural view of a Neuroglancer object: a shader's error list, an enum's `enumType`, CodeMirror's `setValue`, the surface hook Zarr Vectors adds. | As for `as any`, for the fields named. |
| `as <Neuroglancer type>` | 6 | A layer, source or query taken as a more specific Neuroglancer class: `AnnotationUserLayer`, `LoadedLayerDataSource`, `FilterQuery`, `Iterable<Annotation>`, `Map<string, TabOption>`. | A renamed or split class is a type error at once; a changed subclassing is not. |
| `as HTML…Element` | 26 | The app's own elements. | Not into Neuroglancer. |
| Errors, tuples, literals | 9 | `as Error`, `as [number, number]` and the like. | Not into Neuroglancer. |

By file, into Neuroglancer: `annotations.ts` 17, `render.ts` 17,
`shader.ts` 14, `surface.ts` 12, `index.ts` 9, `segments.ts` 9,
`source.ts` 9, `colormap.ts` 2, `ome.ts` 2, `lookup.ts` 0, `ui.ts` 0.

## Bumping the pin

1. Move `neuroglancer.commit` in `package.json` and CI's `FORK_SHA` together
   (`npm run check:neuroglancer` warns while they differ).
2. `npm run casts -- --list any` and `-- --list shape`: read each line
   against the new Neuroglancer source.
3. Open the Layers panel on an image, a segmentation, an annotation layer, a
   mesh and a skeleton (the style audit does) and check the console.
