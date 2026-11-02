# Labels

![Labels pinned to structures, in 2-D and 3-D](../../docs/images/plugins/labels.png)

Labels on the views for figures, as an anatomy atlas draws them: a pin on
what is named, a thin leader line, and the name beside it or lined up at
the view's edge. Pinned to a point, a track group's centre (from the track
filtering plugin's `trackFiltering.groups` service) or an annotation in one
of Neuroglancer's annotation layers (its description). Shown in 2-D, 3-D or
both, dragged and resized in the views, and painted into Neuroglancer's
screenshots.

| File | What |
|---|---|
| `manifest.ts` | The Labels tab and the state slice (`labels`) |
| `plugin.ts` | Activation |
| `labels.ts` | Layout (beside the pin, or callouts at the sides), the overlay, screenshots, the tab |
| `tests/` | `npm test` runs them |

It draws through the SDK's `ui.overlay()`, `ui.screenshotOverlay()`,
`viewer.panels()` and `viewer.onRendered()`.
