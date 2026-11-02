# Patches for the Neuroglancer fork

Changes to the Neuroglancer fork the app builds on, written up but not
applied: whoever looks after the fork reviews and applies them there.

| Patch | What | Without it |
|---|---|---|
| [`segmentation-outlines.patch`](segmentation-outlines.patch) | Segmentation layers draw outlines in the 2-D views themselves (`outlineWidth`) | The app draws outlines with an image layer above the segmentation (`src/engine/outline_shader.ts`), which works but is a second layer, misses boundaries lying on chunk faces, and writes large tables of colours into a shader |
