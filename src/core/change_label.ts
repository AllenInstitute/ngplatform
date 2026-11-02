/**
 * A few words saying what changed between two settled workspace states, for
 * the history menu beside undo and redo ("Layout: 3d", "Hid SRB 2026a",
 * "Track filtering").  Worked out from the two states, so every change gets
 * one, whoever made it.
 */
import type { Json } from "./workspace.js";

interface Workspace {
  ng: Json;
  app: Json;
}

const VIEW_WORDS: [keys: string[], word: string][] = [
  [["position"], "Moved"],
  [["crossSectionScale", "projectionScale"], "Zoomed"],
  [["crossSectionOrientation", "projectionOrientation"], "Rotated"],
  [["dimensions"], "Dimensions"],
];

const LAYER_WORDS: Record<string, string> = {
  shader: "shader",
  shaderControls: "contrast",
  opacity: "opacity",
  blend: "blending",
  source: "source",
  segments: "segments",
  segmentColors: "segment colours",
  segmentDefaultColor: "colour",
  annotations: "annotations",
  annotationColor: "colour",
  volumeRendering: "volume rendering",
  objectAlpha: "opacity",
  selectedAlpha: "opacity",
  crossSectionRenderScale: "resolution",
};

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function layersOf(ng: Json): Json[] {
  return Array.isArray(ng.layers) ? (ng.layers as Json[]) : [];
}

/** "trackFiltering" → "Track filtering". */
function humanise(key: string): string {
  const words = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").toLowerCase().trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function layerChanges(before: Json[], after: Json[]): string[] {
  const name = (l: Json) => String(l.name ?? "");
  const old = new Map(before.map((l) => [name(l), l]));
  const now = new Map(after.map((l) => [name(l), l]));
  const added = after.filter((l) => !old.has(name(l)));
  const removed = before.filter((l) => !now.has(name(l)));
  if (added.length === 1 && removed.length === 1) return [`Renamed ${name(removed[0])} to ${name(added[0])}`];
  const out: string[] = [];
  for (const l of added) out.push(`Added ${name(l)}`);
  for (const l of removed) out.push(`Removed ${name(l)}`);
  for (const [n, l] of now) {
    const was = old.get(n);
    if (was === undefined || same(was, l)) continue;
    if ((was.visible === false) !== (l.visible === false)) {
      out.push(`${l.visible === false ? "Hid" : "Showed"} ${n}`);
      continue;
    }
    const keys = [...new Set([...Object.keys(was), ...Object.keys(l)])].filter((k) => !same(was[k], l[k]));
    const words = [...new Set(keys.map((k) => LAYER_WORDS[k] ?? humanise(k).toLowerCase()))];
    out.push(`${n}: ${words.slice(0, 2).join(", ")}`);
  }
  if (out.length === 0 && !same(before.map(name), after.map(name))) out.push("Reordered layers");
  return out;
}

export function describeChange(before: Workspace | undefined, after: Workspace): string {
  if (before === undefined) return "Opened";
  const parts: string[] = [];
  const { ng: a, app: b } = before;
  const { ng: c, app: d } = after;
  const platform = (app: Json) => (app.platform ?? {}) as Json;
  const scenes = (app: Json) => (Array.isArray(platform(app).scenes) ? (platform(app).scenes as Json[]) : []);
  const [sa, sb] = [scenes(b), scenes(d)];
  if (sb.length > sa.length) parts.push("Added a scene");
  else if (sb.length < sa.length) parts.push("Removed a scene");
  else if (platform(b).activeScene !== platform(d).activeScene) parts.push("Switched scene");
  else if (!same(sa.map((s) => s.name), sb.map((s) => s.name))) parts.push("Renamed a scene");
  if (parts.length > 0) return parts[0];
  parts.push(...layerChanges(layersOf(a), layersOf(c)));
  if (!same(a.layout, c.layout)) parts.push(`Layout: ${typeof c.layout === "string" ? c.layout : "custom"}`);
  for (const [keys, word] of VIEW_WORDS) if (keys.some((k) => !same(a[k], c[k]))) parts.push(word);
  for (const key of new Set([...Object.keys(b), ...Object.keys(d)])) {
    if (key !== "platform" && !same(b[key], d[key])) parts.push(humanise(key));
  }
  const known = new Set(["layers", "layout", "selectedLayer", "selection", ...VIEW_WORDS.flatMap(([k]) => k)]);
  for (const key of new Set([...Object.keys(a), ...Object.keys(c)])) {
    if (!known.has(key) && !same(a[key], c[key])) parts.push(humanise(key));
  }
  if (parts.length === 0) return "Changed";
  return parts.length <= 2 ? parts.join(", ") : `${parts.slice(0, 2).join(", ")} +${parts.length - 2}`;
}
