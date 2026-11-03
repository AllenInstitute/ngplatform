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
import type { AuthRegistry } from "../platform/auth.js";
import type { GoogleSignIn } from "../platform/google_auth.js";
import type { SignInRules } from "../platform/sign_in_rules.js";
import type { JobService } from "../platform/jobs.js";
import type { RunnerService } from "../platform/runner.js";
import type { ComputedImages } from "../virtual/computed.js";
import type { LocalData } from "../virtual/local_data.js";
import type { PluginHost } from "../platform/plugin_host.js";
import type { ExampleRegistry, OpenHandlerRegistry } from "../platform/registries.js";
import type { ServiceRegistry } from "../platform/services.js";
import type { Manifest } from "../sdk/types.js";
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
  examples: ExampleRegistry;
  openHandlers: OpenHandlerRegistry;
  jobs: JobService;
  /** The runner on this computer (Python jobs the app starts and watches), when paired. */
  runner: RunnerService;
  services: ServiceRegistry;
  /** The sign-in methods (the Auth tab's). */
  auth: AuthRegistry;
  /** The Google accounts of this browser. */
  google: GoogleSignIn;
  /** This browser's sign-in rules: which sign-in (and Google account) reads which bucket or server. */
  rules: SignInRules;
  plugins: PluginHost;
  /** Which plugins are on, and switching them (which reloads the page). */
  pluginSwitches: {
    manifests: Manifest[];
    enabled: Set<string>;
    blocked: Map<string, string[]>;
    toggle(id: string, on: boolean): Promise<void>;
  };
  log: ActivityLog;
  /** Data on this computer, served to the viewer (see src/virtual/local_data.ts). */
  localData: LocalData;
  /** Images computed as they are viewed, by chunkmirage's engine (see src/virtual/computed.ts). */
  computed: ComputedImages;
  parseFragment: FragmentParser;
  framed: boolean;
  /** Runs a command, reporting a failure in the log and a toast. */
  run(id: string, args?: unknown): void;
}
