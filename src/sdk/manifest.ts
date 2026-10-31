/**
 * The plugin manifest's schema and checks.
 *
 * A manifest is read without running any plugin code: it is enough to list
 * the plugin, show its commands in the palette and its panels in the docks,
 * and decide when to load it.
 */
import { type Schema, validate } from "../core/schema.js";
import { whenKeys } from "../core/when.js";
import type { Manifest } from "./types.js";

const id: Schema = { type: "string", pattern: "^[A-Za-z0-9_.:-]+$" };
const when: Schema = { type: "string" };
const slot: Schema = { type: "string", enum: ["left", "right", "bottom"] };

export const MANIFEST_SCHEMA: Schema = {
  type: "object",
  required: ["id", "name", "version", "kind"],
  properties: {
    id: { type: "string", pattern: "^[a-z0-9]+(\\.[a-z0-9-]+)+$" },
    name: { type: "string" },
    version: { type: "string", pattern: "^\\d+\\.\\d+\\.\\d+" },
    kind: { type: "string", enum: ["datatype", "tool"] },
    description: { type: "string" },
    enabledByDefault: { type: "boolean" },
    license: { type: "string" },
    engines: { type: "object", properties: { ngplatform: { type: "string" } } },
    main: { type: "string" },
    activation: {
      type: "array",
      items: { type: "string", pattern: "^(onStartup|onCommand:.+|onView:.+|onDatasetKind:.+|onOpen:.+)$" },
    },
    permissions: { type: "object", properties: { network: { type: "array", items: { type: "string" } } } },
    provides: { type: "object", properties: { services: { type: "array", items: { type: "string" } } } },
    requires: {
      type: "object",
      properties: { plugins: { type: "array", items: { type: "string" } }, services: { type: "array", items: { type: "string" } } },
    },
    contributes: {
      type: "object",
      additionalProperties: false,
      properties: {
        commands: {
          type: "array",
          items: {
            type: "object",
            required: ["id", "title"],
            properties: { id, title: { type: "string" }, group: { type: "string" }, hint: { type: "string" }, args: { type: "object" }, when },
          },
        },
        keybindings: {
          type: "array",
          items: { type: "object", required: ["key", "command"], properties: { key: { type: "string" }, command: id, when } },
        },
        panels: {
          type: "array",
          items: {
            type: "object",
            required: ["id", "title", "slot"],
            properties: { id, title: { type: "string" }, slot, order: { type: "number" }, when },
          },
        },
        datasetActions: {
          type: "array",
          items: { type: "object", required: ["command"], properties: { command: id, title: { type: "string" }, when } },
        },
        openHandlers: {
          type: "array",
          items: { type: "object", required: ["id", "pattern"], properties: { id, pattern: { type: "string" }, title: { type: "string" } } },
        },
        examples: {
          type: "array",
          items: {
            type: "object",
            required: ["id", "title", "description"],
            properties: { id, title: { type: "string" }, description: { type: "string" }, remote: { type: "boolean" }, state: { type: "object" } },
          },
        },
        appState: { type: "object", required: ["key", "version"], properties: { key: id, version: { type: "integer", minimum: 1 } } },
        settings: { type: "object" },
        contextKeys: { type: "array", items: { type: "string" } },
      },
    },
  },
};

/** Context keys the platform itself sets; plugins may read them in `when` clauses. */
export const PLATFORM_CONTEXT_KEYS = [
  "hasLayers",
  "sceneIsEmpty",
  "sceneCount",
  "selectedLayer",
  "selectedLayerType",
  "datasetKind",
  "sourceFormat",
  "canUndo",
  "canRedo",
  "framed",
];

/**
 * Problems with a manifest, as messages; empty when it is sound.  Beyond the
 * schema: menus and keys must name commands the plugin declares, `when`
 * clauses may only read declared context keys, and activation events must
 * name things the plugin contributes.
 */
export function checkManifest(manifest: unknown): string[] {
  const errors = validate(MANIFEST_SCHEMA, manifest);
  if (errors.length > 0) return errors;
  const m = manifest as Manifest;
  const c = m.contributes ?? {};
  const commands = new Set((c.commands ?? []).map((x) => x.id));
  const panels = new Set((c.panels ?? []).map((x) => x.id));
  const keys = new Set([...PLATFORM_CONTEXT_KEYS, ...(c.contextKeys ?? [])]);
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const x of c.commands ?? []) {
    if (seen.has(x.id)) problems.push(`command ${x.id} is declared twice`);
    seen.add(x.id);
  }
  for (const k of c.keybindings ?? []) {
    if (!commands.has(k.command)) problems.push(`keybinding ${k.key} names undeclared command ${k.command}`);
  }
  for (const a of c.datasetActions ?? []) {
    if (!commands.has(a.command)) problems.push(`dataset action names undeclared command ${a.command}`);
  }
  for (const event of m.activation ?? []) {
    const [kind, target] = [event.split(":")[0], event.slice(event.indexOf(":") + 1)];
    if (kind === "onCommand" && !commands.has(target)) problems.push(`activation ${event} names undeclared command`);
    if (kind === "onView" && !panels.has(target)) problems.push(`activation ${event} names undeclared panel`);
    if (kind === "onOpen") {
      try {
        new RegExp(target);
      } catch {
        problems.push(`activation ${event} is not a valid pattern`);
      }
    }
  }
  const clauses = [
    ...(c.commands ?? []).map((x) => x.when),
    ...(c.keybindings ?? []).map((x) => x.when),
    ...(c.panels ?? []).map((x) => x.when),
    ...(c.datasetActions ?? []).map((x) => x.when),
  ];
  for (const clause of clauses) {
    for (const key of whenKeys(clause)) {
      if (!keys.has(key)) problems.push(`when clause "${clause}" reads undeclared context key ${key}`);
    }
  }
  if (m.kind === "datatype" && (c.commands?.length || c.panels?.length)) {
    problems.push("a data type plugin contributes a format, not commands or panels: make those a tool plugin that requires it");
  }
  for (const h of c.openHandlers ?? []) {
    try {
      new RegExp(h.pattern);
    } catch {
      problems.push(`open handler ${h.id} has an invalid pattern`);
    }
  }
  return problems;
}
