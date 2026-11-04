/**
 * A few words saying what changed between two settled workspace states, for
 * the history menu beside undo and redo ("Layout: 3d", "Hid SRB 2026a",
 * "Track filtering").  Worked out from the two states, so every change gets
 * one, whoever made it.
 */
import type { StepInfo } from "./history.js";
import { datasetKey, type Json } from "./workspace.js";

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

/** "// Colour map: viridis" in a shader the Layer tab's colour maps wrote. */
const colourMap = (shader: unknown) => (typeof shader === "string" ? /\/\/ Colour map: (\S+)/.exec(shader)?.[1] : undefined);

/** The words for a layer's changes, and the names of the layers they touched. */
function layerChanges(before: Json[], after: Json[]): { words: string[]; touched: string[] } {
  const name = (l: Json) => String(l.name ?? "");
  const old = new Map(before.map((l) => [name(l), l]));
  const now = new Map(after.map((l) => [name(l), l]));
  const added = after.filter((l) => !old.has(name(l)));
  const removed = before.filter((l) => !now.has(name(l)));
  if (added.length === 1 && removed.length === 1) return { words: [`Renamed ${name(removed[0])} to ${name(added[0])}`], touched: [name(added[0])] };
  const out: string[] = [];
  const touched: string[] = [];
  for (const l of added) {
    out.push(`Added ${name(l)}`);
    touched.push(name(l));
  }
  for (const l of removed) {
    out.push(`Removed ${name(l)}`);
    touched.push(name(l));
  }
  for (const [n, l] of now) {
    const was = old.get(n);
    if (was === undefined || same(was, l)) continue;
    touched.push(n);
    if ((was.visible === false) !== (l.visible === false)) {
      out.push(`${l.visible === false ? "Hid" : "Showed"} ${n}`);
      continue;
    }
    const keys = [...new Set([...Object.keys(was), ...Object.keys(l)])].filter((k) => !same(was[k], l[k]));
    const map = keys.includes("shader") ? colourMap(l.shader) : undefined;
    const word = (k: string) => (k === "shader" && map !== undefined && map !== colourMap(was.shader) ? `colour map ${map}` : (LAYER_WORDS[k] ?? humanise(k).toLowerCase()));
    const words = [...new Set(keys.map(word))];
    out.push(`${n}: ${words.slice(0, 2).join(", ")}`);
  }
  if (out.length === 0 && !same(before.map(name), after.map(name))) out.push("Reordered layers");
  return { words: out, touched };
}

export function describeChange(before: Workspace | undefined, after: Workspace): string {
  return describeStep(before, after).label;
}

/**
 * What changed, with the scene it was made in and the datasets whose
 * layers it touched (by name), for the history view: "Scene 2 · SRB 2026a:
 * colour map viridis".
 */
export function describeStep(before: Workspace | undefined, after: Workspace): StepInfo {
  const platform = (app: Json) => (app.platform ?? {}) as Json;
  const scenes = (app: Json) => (Array.isArray(platform(app).scenes) ? (platform(app).scenes as Json[]) : []);
  const sceneName = (app: Json, id: unknown) => {
    const scene = scenes(app).find((s) => s.id === id);
    return scene === undefined ? undefined : String(scene.name ?? "");
  };
  const active = sceneName(after.app, platform(after.app).activeScene);
  if (before === undefined) return { label: "Opened" };
  const { ng: a, app: b } = before;
  const { ng: c, app: d } = after;
  const [sa, sb] = [scenes(b), scenes(d)];
  if (sb.length > sa.length) return { label: "Added a scene", scene: active };
  if (sb.length < sa.length) {
    const gone = sa.find((s) => !sb.some((t) => t.id === s.id));
    return { label: "Removed a scene", scene: gone === undefined ? undefined : String(gone.name ?? "") };
  }
  if (platform(b).activeScene !== platform(d).activeScene) return { label: "Switched scene", scene: active };
  const renamed = sb.find((s) => sceneName(b, s.id) !== undefined && sceneName(b, s.id) !== String(s.name ?? ""));
  if (renamed !== undefined) return { label: "Renamed a scene", scene: String(renamed.name ?? "") };
  if (!same(sa.map((s) => s.id), sb.map((s) => s.id))) return { label: "Moved a scene", scene: active };
  const parts: string[] = [];
  const layers = layerChanges(layersOf(a), layersOf(c));
  parts.push(...layers.words);
  if (!same(a.layout, c.layout)) parts.push(`Layout: ${typeof c.layout === "string" ? c.layout : "custom"}`);
  for (const [keys, word] of VIEW_WORDS) if (keys.some((k) => !same(a[k], c[k]))) parts.push(word);
  for (const key of new Set([...Object.keys(b), ...Object.keys(d)])) {
    if (key !== "platform" && !same(b[key], d[key])) parts.push(humanise(key));
  }
  const known = new Set(["layers", "layout", "selectedLayer", "selection", ...VIEW_WORDS.flatMap(([k]) => k)]);
  for (const key of new Set([...Object.keys(a), ...Object.keys(c)])) {
    if (!known.has(key) && !same(a[key], c[key])) parts.push(humanise(key));
  }
  // Datasets added, removed or renamed in the workspace (not through a layer).
  const datasets = (app: Json) => (Array.isArray(platform(app).datasets) ? (platform(app).datasets as Json[]) : []);
  const names = new Set<string>();
  for (const layer of layers.touched) {
    const spec = layersOf(c).find((l) => String(l.name ?? "") === layer) ?? layersOf(a).find((l) => String(l.name ?? "") === layer);
    const key = spec === undefined ? undefined : datasetKey(spec);
    const record = datasets(d).find((r) => r.key === key) ?? datasets(b).find((r) => r.key === key);
    if (record !== undefined) names.add(String(record.name ?? ""));
  }
  const [da, db] = [datasets(b), datasets(d)];
  for (const r of db) {
    const was = da.find((x) => x.id === r.id);
    if (was === undefined || was.name !== r.name) names.add(String(r.name ?? ""));
  }
  for (const r of da) if (!db.some((x) => x.id === r.id)) names.add(String(r.name ?? ""));
  if (parts.length === 0) {
    const renamed = db.find((r) => da.some((x) => x.id === r.id && x.name !== r.name));
    const gone = da.find((r) => !db.some((x) => x.id === r.id));
    if (renamed !== undefined) parts.push(`Renamed ${String(da.find((x) => x.id === renamed.id)!.name)} to ${String(renamed.name)}`);
    else if (gone !== undefined) parts.push(`Deleted ${String(gone.name)}`);
  }
  const label = parts.length === 0 ? "Changed" : parts.length <= 2 ? parts.join(", ") : `${parts.slice(0, 2).join(", ")} +${parts.length - 2}`;
  return { label, scene: active, datasets: [...names].filter((n) => n !== "") };
}
