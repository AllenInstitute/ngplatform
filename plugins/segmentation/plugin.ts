/**
 * The Segmentation plugin: label volumes drawn by hand.  The editor
 * (./editor.ts) holds the volumes and the tools; the tab (./panel.ts) and
 * the tool bar over the views (./toolbar.ts) show them.
 */
import type { PlatformContext, PluginModule } from "@ngplatform/sdk";
import { Voxels } from "../annotations/voxels.js";
import { Editor } from "./editor.js";
import { SEGMENTATION_PANEL } from "./manifest.js";
import { Panel } from "./panel.js";
import { STYLE } from "./style.js";
import { Toolbar } from "./toolbar.js";

export const plugin: PluginModule = {
  activate(ctx: PlatformContext) {
    const style = document.createElement("style");
    style.textContent = STYLE;
    document.head.append(style);
    // A worker reading images: their levels, and their values on the label grid.
    const voxels = new Voxels();
    const editor = new Editor(ctx, voxels);
    const toolbar = new Toolbar(ctx, editor);
    const panel = new Panel(ctx, editor, voxels);
    ctx.subscriptions.push(() => {
      toolbar.dispose();
      editor.dispose();
      voxels.dispose();
      style.remove();
    });
    ctx.ui.panel(SEGMENTATION_PANEL, (host) => panel.render(host));
  },
};
