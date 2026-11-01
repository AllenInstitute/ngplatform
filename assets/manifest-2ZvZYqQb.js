const e="annotations.labels",t={id:"org.ngplatform.annotations",name:"Labels",version:"0.1.0",kind:"tool",enabledByDefault:!0,description:"Labels on the views for figures: pinned to points, track groups or annotations, in 2-D, 3-D or both, and in screenshots.",guide:`Labels name what is in the views, as an anatomy atlas does: a pin on the structure, a thin leader line, and its name beside it or lined up at the edge of the view.

## Adding labels (the Labels tab)
- **At the position**: a label pinned where the views are centred.
- **Track groups**: one per group in the Filtering tab, pinned to the centre of its streamlines, in the group's colour.
- **Annotations**: one per annotation with a description (Neuroglancer's own annotation layers: points, lines, boxes, ellipsoids). Give an annotation a description in its layer's Annotations tab first.

## Placing them
- **Where**: beside the pin (above right, below, …), or **At the side**, where labels line up at the view's left and right edges, out of each other's way, each with a leader line to its pin.
- **Views**: 2-D and 3-D, 2-D only or 3-D only. In 2-D a label can show only when its pin is near the section.
- In a view, drag a label to move it (its line stays tied to the pin), drag its corner to resize it, and double-click it to put it back.

Labels are kept in the workspace link, and drawn into Neuroglancer's screenshots.`,license:"Apache-2.0",activation:["onStartup"],contributes:{panels:[{id:e,title:"Labels",slot:"left",order:60}],appState:{key:"labels",version:1}}};export{t as A,e as L};
