/** The view aids' manifest: read without loading its code. */
import type { Manifest } from "@ngplatform/sdk";

export const VIEW_AIDS_STATE_KEY = "viewAids";

export const VIEW_AIDS_MANIFEST: Manifest = {
  id: "org.ngplatform.view-aids",
  name: "View aids",
  version: "0.1.0",
  kind: "tool",
  enabledByDefault: true,
  description: "Aids in the 3-D view, after Siemens' Cinematic Anatomy: an orientation cube, labels with leader lines, Hide graphics, and bookmarks of the camera.",
  guide: `Aids in Neuroglancer's 3-D view, for every scene.

## Orientation cube
In the 3-D view's top right, turned as the view is. Its faces are lettered by the data's sides when the space reads as anatomy (x, y and z in micrometres or more, taken as RAS: **R**/**L**, **A**/**P**, **S**/**I**), else by its axes (±x, ±y, ±z). Its edges are in the axes' colours. Click a face, an edge or a corner to look at the data from there. **Realign** (below it) turns to the nearest of the six standard views. **Cube** beside **Sections** shows or hides it.

## Labels
Every point annotation with a description, in the scene's visible annotation layers, is named at the 3-D view's left or right side, with a thin line to its point; the labels keep their points' order round the view so lines do not cross, and never overlap. **Labels** beside **Sections** shows or hides them. They are drawn into captures and screenshots. Points behind tissue are not greyed.

## Hide graphics
**Graphics** beside **Sections** off hides Neuroglancer's axis lines, the data's bounding box and the scale bar, and these aids, for a clean picture; on puts back exactly what was shown.

## Bookmarks
**Bookmark this view** (below the cube, or in the command palette) keeps the camera: position, orientation, zoom, depth, the sections' scale and the layout, with a small picture. The bookmarks are a strip along the 3-D view's bottom edge: click one to fly there; right-click to rename, replace or delete it; **Play** moves through them in order. They are kept in the scene (in the link, and undone with undo).

With reduced motion asked for in the system, views change at once instead of turning.`,
  license: "Apache-2.0",
  activation: ["onStartup"],
  contributes: {
    commands: [
      { id: "viewAids.realign", title: "3-D view: realign to the nearest standard view", group: "View" },
      { id: "viewAids.cube", title: "3-D view: show or hide the orientation cube", group: "View" },
      { id: "viewAids.labels", title: "3-D view: show or hide point labels", group: "View" },
      { id: "viewAids.graphics", title: "Hide or show graphics (axis lines, box, scale bar, aids)", group: "View" },
      { id: "viewAids.bookmark", title: "Bookmark this view", group: "Bookmarks" },
      { id: "viewAids.play", title: "Play the bookmarks, or stop", group: "Bookmarks" },
      { id: "viewAids.next", title: "Go to the next bookmark", group: "Bookmarks" },
      { id: "viewAids.previous", title: "Go to the previous bookmark", group: "Bookmarks" },
      { id: "viewAids.rename", title: "Rename a bookmark…", group: "Bookmarks" },
      { id: "viewAids.delete", title: "Delete a bookmark…", group: "Bookmarks" },
    ],
    appState: { key: VIEW_AIDS_STATE_KEY, version: 1 },
  },
};
