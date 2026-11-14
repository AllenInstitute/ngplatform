---
version: 1
slug: "src-ui-shell-ts"
primary_target: "src/ui/shell.ts"
related_targets: ["src/ui/docks.ts"]
---

# Surface: the ngplatform workspace (shell, views, in-view tools)

Mode: Operate (researchers exploring large brain data; views first).
Scope: layout of the workspace window, tools that work inside Neuroglancer's 2-D and 3-D views, Cinematic Anatomy-style view aids, and a HiP-CT scale navigator. Additive to Neuroglancer only: DOM overlays, event listeners in front of its panels, render layers through the existing draw3d hook and state patches; no change to Neuroglancer's own code or behaviour. Visual system: DESIGN.md ("The Instrument Panel"), unchanged.

## Direction contract

THESIS: The view is the workspace. Spatial things are changed where they are, by handles in the 2-D and 3-D views, not by sliders in a side dock. Refuses the category default of a viewer framed by two tool docks full of numeric fields.

OWN-WORLD: DESIGN.md's black and grey steps, square corners, 24 px controls, Source Sans 3 and Source Code Pro. In the views: thin 1.5 px light-grey handle lines, square handle knobs (7 px), the data's own colours untouched, the selected handle drawn in the accent light grey with a 1 px black keyline; axis colours (dec-x/y/z) only on axis arrows and the orientation cube's edges.

STORY: A researcher opens a brain, sees where they are (orientation cube, scale breadcrumb `S-21-46 › 20 µm › 6.5 µm`, the level on screen), moves between the overview and zooms by clicking their boxes, and drags regions, cut planes and landmarks in place; exact numbers are one click away in a small card.

FIRST VIEWPORT: Top bar as now. One left column (~300 px): layer list, then the selected layer's inspector, then that data's tools as sections. Views fill the rest. Bottom status line: activity message left, scale breadcrumb and level chip right. In the 3-D view: orientation cube top right, bookmark strip along the bottom edge when bookmarks exist. A floating card appears over the view's corner only while an in-view tool or handle is selected.

FORM: seed: none (pinned) — the user chose "Maybe a mix of 1 and 3 only when relevant" (one left panel; inspector floats over the view only when relevant).

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
