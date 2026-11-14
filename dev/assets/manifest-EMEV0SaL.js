const e="annotations.labels",t="annotations.table",n={id:"org.ngplatform.annotations",name:"Annotations",version:"0.3.0",kind:"tool",enabledByDefault:!1,description:"Annotations with groups, values and comments in a table; labels on the views for figures, measurements, and statistics in a region.",guide:`Everything you add to annotate a dataset, in the **Annotations** panel (four cards; the (i) beside a heading or a control explains it), and the **Annotation table** in the Activity dock. Label volumes drawn by hand are in the **Segmentation** panel (the Segmentation plugin).

## Annotate
Points, lines, boxes, ellipsoids and polylines in a local annotation layer, organised as in WebKnossos and Neuroglass.
- Choose the **layer** (or **+ New layer**), then **Draw…**: the layer's Annotations tab (in Layers) has the tools; Ctrl+click in a view (Ctrl+double-click ends a polyline). The new annotation is selected in the annotation table, ready for its values.
- **Groups**: named, nested; tick to show or hide one (and the groups in it), pick its colour, choose the group new annotations go to, and **Colour by** group or by a field.
- **Fields**: values each annotation has: a **list** of values (cell types, say), a **number**, **text**, or an **ontology term** (from a lookup table such as the Allen structures, or a list, OBO or JSON file). Lists and numbers are kept as Neuroglancer annotation properties; text and terms in this plugin's state.

## Annotation table
Every annotation of the scene's local annotation layers: type, name, group, values, size and comments.
- **Find**: words anywhere, or \`column:text\`, \`column=text\` (\`group=\` for none), \`column>n\`, \`-word\`; a column is its title without spaces (\`celltype:basket\`, \`size>2\`). A term is also found by the structures it is within.
- Click a heading to sort; click a row to go to the annotation and select it; edit its description, group, values and **comments** beside the table, or delete it. Pointing at an annotation in a view shows its values and comments.
- **Save CSV** writes the rows found (with coordinates); **Open CSV…** updates the annotations a CSV names and adds the others.

## Labels
Names on the views, as an anatomy atlas draws them: a pin on the structure, a thin leader line, and its name beside it or lined up at the edge of the view.
- **+ At the position**, **+ Track groups** (one per group in Track filtering; off while there are none) or **+ Annotations** (each annotation with a description).
- **Where**: beside the pin, or **At the side**; **Views**: 2-D, 3-D or both. Drag a label in a view to move it, by its corner to resize it; double-click puts it back.
- Labels are kept in the link and drawn into screenshots.

## Measure
Draw with Neuroglancer's annotation tools (**Line**, **Polyline**, **Box**, **Ellipsoid**): each button picks the tool in a *measurements* layer; Ctrl+click in a view to draw.
- Lines and polylines show their **length**, boxes and ellipsoids their **volume** (an area when flat), in physical units.
- **Line profile**: an image's values along a line, as a plot; **Save profile as CSV** saves it; **Cancel** stops reading.

## Statistics
For an image and a region (a box or ellipsoid annotation, a label of a label volume drawn in the Segmentation panel, or a label of a segmentation layer such as an atlas): voxel count, volume, mean, standard deviation, minimum, maximum and median of the image inside. The finest level that fits the memory budget is read. **Cancel** stops it; **Compute** again while one runs starts afresh. Each result is a card; **Save as CSV** writes them.
`,links:[{title:"WebKnossos skeleton annotation: trees, groups, comments",url:"https://docs.webknossos.org/webknossos/skeleton_annotation/index.html"},{title:"Neuroglass (annotation table, values from ontologies)",url:"https://www.neuroglass.com/"}],license:"Apache-2.0",activation:["onStartup"],contributes:{panels:[{id:e,title:"Annotations",slot:"left",group:"Labels",order:60},{id:t,title:"Annotation table",slot:"bottom",order:15,minSize:300}],appState:{key:"labels",version:1},commands:[{id:"annotations.exportMeasurements",title:"Save measurements as CSV",group:"Annotations"},{id:"annotations.showTable",title:"Show the annotation table",group:"Annotations"}]}};export{n as A,t as T,e as a};
