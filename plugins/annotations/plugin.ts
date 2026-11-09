/**
 * The Annotations plugin: one tab, four sections, and the annotation table.
 *
 *  - Annotate (./annotate_panel.ts): the layer, tools, groups and fields of
 *    annotations; the annotation table (./table_panel.ts, in the bottom
 *    dock) lists them, with their values and comments.
 *  - Labels (./labels.ts): names pinned in the views, for figures.
 *  - Measure (./measure_panel.ts): lengths, areas and volumes of
 *    Neuroglancer's annotations, and an image's profile along a line.
 *  - Statistics (./statistics_panel.ts): an image's values in a region
 *    (a label of a volume drawn in the Segmentation plugin among them).
 *
 * Each section is folded or open as the user left it (kept in this browser).
 */
import type { Disposer, PlatformContext, PluginModule } from "@ngplatform/sdk";
import { card, el } from "@ngplatform/sdk/dom";
import { Annotate } from "./annotate.js";
import { AnnotatePanel } from "./annotate_panel.js";
import { Labels, STYLE as LABELS_STYLE } from "./labels.js";
import { ANNOTATIONS_PANEL, TABLE_PANEL } from "./manifest.js";
import { Measure } from "./measure_panel.js";
import { Statistics } from "./statistics_panel.js";
import { STYLE } from "./style.js";
import { TablePanel } from "./table_panel.js";
import { Voxels } from "./voxels.js";

interface Section {
  id: string;
  title: string;
  render(host: HTMLElement): Disposer;
}

/** The panel's sections as cards (the first open until toggled; each kept as left), each drawn only once opened. */
function sections(list: Section[]): (host: HTMLElement) => Disposer {
  return (host) => {
    const offs: Disposer[] = [];
    const root = el("div", { class: "an" });
    list.forEach((s, i) => {
      const details = card(`annotations.${s.id}`, s.title, { open: i === 0 });
      details.dataset.section = s.id;
      const body = details.querySelector<HTMLElement>(".card-body")!;
      // A section draws only once opened: closed ones cost nothing.
      let drawn = false;
      const draw = () => {
        if (drawn || !details.open) return;
        drawn = true;
        offs.push(s.render(body));
      };
      details.addEventListener("toggle", draw);
      draw();
      root.append(details);
    });
    host.append(root);
    return () => offs.forEach((off) => off());
  };
}

export const plugin: PluginModule = {
  activate(ctx: PlatformContext) {
    const style = document.createElement("style");
    style.textContent = LABELS_STYLE + STYLE;
    document.head.append(style);
    // One worker reads images for every section.
    const voxels = new Voxels();
    const annotate = new Annotate(ctx);
    const annotatePanel = new AnnotatePanel(ctx, annotate);
    const table = new TablePanel(ctx, annotate);
    const labels = new Labels(ctx);
    const measure = new Measure(ctx, voxels);
    const statistics = new Statistics(ctx, voxels);
    ctx.subscriptions.push(() => {
      voxels.dispose();
      annotate.dispose();
      labels.dispose();
      measure.dispose();
      statistics.dispose();
      style.remove();
    });
    ctx.ui.panel(
      ANNOTATIONS_PANEL,
      sections([
        { id: "annotate", title: "Annotate", render: (host) => annotatePanel.render(host) },
        { id: "labels", title: "Labels", render: (host) => labels.render(host) },
        { id: "measure", title: "Measure", render: (host) => measure.render(host) },
        { id: "statistics", title: "Statistics", render: (host) => statistics.render(host) },
      ]),
    );
    ctx.ui.panel(TABLE_PANEL, (host) => table.render(host));
    ctx.commands.register("annotations.showTable", () => ctx.ui.showPanel(TABLE_PANEL));
  },
};
