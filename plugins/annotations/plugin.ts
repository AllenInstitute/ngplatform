/**
 * The Annotations plugin: one tab, five sections, and the annotation table.
 *
 *  - Annotate (./annotate_panel.ts): the layer, tools, groups and fields of
 *    annotations; the annotation table (./table_panel.ts, in the bottom
 *    dock) lists them, with their values and comments.
 *  - Labels (./labels.ts): names pinned in the views, for figures.
 *  - Measure (./measure_panel.ts): lengths, areas and volumes of
 *    Neuroglancer's annotations, and an image's profile along a line.
 *  - Statistics (./statistics_panel.ts): an image's values in a region.
 *  - Segmentation (./segmentation/): label volumes drawn by hand.
 *
 * Each section is folded or open as the user left it (kept in this browser).
 */
import type { Disposer, PlatformContext, PluginModule } from "@ngplatform/sdk";
import { Annotate } from "./annotate.js";
import { AnnotatePanel } from "./annotate_panel.js";
import { Labels, STYLE as LABELS_STYLE } from "./labels.js";
import { ANNOTATIONS_PANEL, TABLE_PANEL } from "./manifest.js";
import { Measure } from "./measure_panel.js";
import { Segmentation } from "./segmentation/panel.js";
import { Statistics } from "./statistics_panel.js";
import { STYLE } from "./style.js";
import { TablePanel } from "./table_panel.js";
import { el } from "./ui.js";
import { Voxels } from "./voxels.js";

interface Section {
  id: string;
  title: string;
  render(host: HTMLElement): Disposer;
}

function sections(ctx: PlatformContext, list: Section[]): (host: HTMLElement) => Disposer {
  return (host) => {
    const offs: Disposer[] = [];
    const open = ctx.settings.get<Record<string, boolean>>("openSections") ?? { annotate: true, labels: true, measure: true, statistics: false, segmentation: true };
    const root = el("div", { class: "an" });
    for (const s of list) {
      const body = el("div", { class: "an-body" });
      const details = el("details", { class: "an-section", "data-section": s.id }, el("summary", { class: "section-title" }, s.title), body) as HTMLDetailsElement;
      details.open = open[s.id] !== false;
      // A section draws only once opened: closed ones cost nothing.
      let drawn = false;
      const draw = () => {
        if (drawn || !details.open) return;
        drawn = true;
        offs.push(s.render(body));
      };
      details.addEventListener("toggle", () => {
        draw();
        const now = ctx.settings.get<Record<string, boolean>>("openSections") ?? open;
        ctx.settings.set("openSections", { ...now, [s.id]: details.open });
      });
      draw();
      root.append(details);
    }
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
    const segmentation = new Segmentation(ctx, voxels);
    const statistics = new Statistics(ctx, voxels, segmentation);
    ctx.subscriptions.push(() => {
      voxels.dispose();
      annotate.dispose();
      labels.dispose();
      measure.dispose();
      statistics.dispose();
      segmentation.dispose();
      style.remove();
    });
    ctx.ui.panel(
      ANNOTATIONS_PANEL,
      sections(ctx, [
        { id: "annotate", title: "Annotate", render: (host) => annotatePanel.render(host) },
        { id: "labels", title: "Labels", render: (host) => labels.render(host) },
        { id: "measure", title: "Measure", render: (host) => measure.render(host) },
        { id: "statistics", title: "Statistics", render: (host) => statistics.render(host) },
        { id: "segmentation", title: "Segmentation", render: (host) => segmentation.render(host) },
      ]),
    );
    ctx.ui.panel(TABLE_PANEL, (host) => table.render(host));
    ctx.commands.register("annotations.showTable", () => ctx.ui.showPanel(TABLE_PANEL));
  },
};
