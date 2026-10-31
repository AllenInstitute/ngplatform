/**
 * What every panel and sheet is handed: the platform's services.  Panels
 * change the workspace through `store` and run actions through `commands`;
 * only the engine adapter touches Neuroglancer.
 */
import type { CommandRegistry } from "../core/commands.js";
import type { KeybindingTable } from "../core/keybindings.js";
import type { FragmentParser } from "../core/state_io.js";
import type { ContextKeys } from "../core/when.js";
import type { Engine } from "../engine/engine.js";
import type { JobService } from "../platform/jobs.js";
import type { PluginHost } from "../platform/plugin_host.js";
import type { ExampleRegistry, InspectorRegistry, OpenHandlerRegistry } from "../platform/registries.js";
import type { ServiceRegistry } from "../platform/services.js";
import type { WorkspaceStore } from "../platform/workspace_store.js";
import type { ActivityLog } from "./panels/activity.js";
import type { DockManager } from "./docks.js";

export interface Workbench {
  engine: Engine;
  store: WorkspaceStore;
  commands: CommandRegistry;
  keybindings: KeybindingTable;
  context: ContextKeys;
  docks: DockManager;
  inspector: InspectorRegistry;
  examples: ExampleRegistry;
  openHandlers: OpenHandlerRegistry;
  jobs: JobService;
  services: ServiceRegistry;
  plugins: PluginHost;
  log: ActivityLog;
  parseFragment: FragmentParser;
  framed: boolean;
  /** Runs a command, reporting a failure in the log and a toast. */
  run(id: string, args?: unknown): void;
}
