/**
 * The starter plugin's manifest: what the platform knows of a plugin before
 * loading its code (its id, name, panel, commands and state).  Copy this
 * folder to begin a plugin of your own; see README.md.
 */
import type { Manifest } from "@ngplatform/sdk";

export const STARTER_PANEL = "starter.panel";

export const STARTER_MANIFEST: Manifest = {
  // Reverse-DNS and stable: it keys the plugin's state in links.
  id: "org.example.starter",
  name: "Starter",
  version: "0.1.0",
  kind: "tool",
  enabledByDefault: false,
  description: "An empty tool plugin to copy: a panel listing the scene's layers, a counter kept in the scene, and a command.",
  guide: `A starting point for a plugin: copy \`plugins/starter_ts\`, rename it, and change what it does.

## What it shows
In the Tools dock, under *Other*:
- **Layers**: the scene's layers, kept up to date, and **Open data…** when there are none.
- **Counter**: a number kept in the scene's state: in the link, undone with undo, separate for each scene.
- A **command**, *Starter: say hello*, in the command palette.`,
  license: "Apache-2.0",
  activation: ["onStartup"],
  contributes: {
    // A tool's panel (slot "left") is listed in the Tools dock under its group: Image, Labels, Space, Vectors or Other.
    panels: [{ id: STARTER_PANEL, title: "Starter", slot: "left", group: "Other", order: 99 }],
    commands: [{ id: "starter.hello", title: "Starter: say hello", group: "Starter" }],
    // The plugin's slice of the workspace state, under this key; raise the version when its shape changes.
    appState: { key: "starter", version: 1 },
  },
};
