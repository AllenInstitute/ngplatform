/**
 * The annotations plugin: labels on the views (./labels.ts), with the Labels
 * tab to make and arrange them.
 */
import type { PlatformContext, PluginModule } from "@ngplatform/sdk";
import { Labels, STYLE } from "./labels.js";
import { LABELS_PANEL } from "./manifest.js";

export const plugin: PluginModule = {
  activate(ctx: PlatformContext) {
    const style = document.createElement("style");
    style.textContent = STYLE;
    document.head.append(style);
    const labels = new Labels(ctx);
    ctx.subscriptions.push(() => {
      labels.dispose();
      style.remove();
    });
    ctx.ui.panel(LABELS_PANEL, (host) => labels.render(host));
  },
};
