/**
 * Settings › View and the chunk statistics of Settings › Developer: the
 * viewer's own settings (Neuroglancer's settings panel) as the app's
 * fields, and its chunk counts as rows for a table.
 *
 * The settings are grouped as the rest of the app groups a sheet: memory
 * limits shown and typed with their units, the options as ticked boxes
 * before their labels, each bound two ways to the viewer, so a change made
 * by undo or by a link shows here at once.
 */
import { type Child, el } from "../sdk/dom.js";
import { bytesText, parseBytes } from "../sdk/format.js";
import { colour, Scope, type Watch } from "./inspector/ui.js";
import { columnSpecifications, getChunkSourceIdentifier, getFormattedNames, type Viewer } from "./neuroglancer.js";

/** Adds the view settings to `host`: the title, then a group each for the views, their backgrounds and loading. */
export function mountViewSettings(host: HTMLElement, viewer: Viewer): () => void {
  const scope = new Scope();

  const check = (label: string, w: Watch<boolean>) => {
    const box = el("input", { type: "checkbox" });
    box.addEventListener("change", () => (w.value = box.checked));
    scope.watch(w, () => (box.checked = w.value));
    return el("label", { class: "field check" }, box, el("span", {}, label));
  };
  const swatch = (label: string, w: Watch<ArrayLike<number> | undefined>) => el("label", { class: "field check" }, colour(scope, w), el("span", {}, label));
  // A size in bytes, as "954 MB"; typed with a unit, or a bare number of MB.
  const bytes = (label: string, w: Watch<number>) => {
    const input = el("input", { class: "text-input mono", type: "text", spellcheck: "false", placeholder: "e.g. 2 GB" });
    const show = () => (input.value = bytesText(w.value));
    input.addEventListener("change", () => {
      const v = parseBytes(input.value);
      if (v !== undefined && v > 0) w.value = v;
      show();
    });
    scope.watch(w, () => {
      if (document.activeElement !== input) show();
    });
    return el("label", { class: "field" }, el("span", {}, label), input);
  };
  const count = (label: string, w: Watch<number>) => {
    const input = el("input", { class: "text-input mono", type: "number", min: 1, step: 1 });
    input.addEventListener("change", () => {
      const v = Math.round(Number(input.value));
      if (v >= 1) w.value = v;
      input.value = String(w.value);
    });
    scope.watch(w, () => (input.value = String(w.value)));
    return el("label", { class: "field" }, el("span", {}, label), input);
  };

  const title = el("input", { class: "text-input", type: "text", placeholder: "Untitled" });
  title.addEventListener("change", () => (viewer.title.value = title.value.trim() || undefined));
  scope.watch(viewer.title, () => (title.value = viewer.title.value ?? ""));

  const group = (name: string, ...children: Child[]) => el("section", {}, el("h3", { class: "section-title" }, name), ...children);
  const { capacities } = viewer.chunkQueueManager;
  host.append(
    el("label", { class: "field" }, el("span", {}, "Title"), title),
    group(
      "Views",
      el(
        "div",
        { class: "options" },
        check("Axis lines", viewer.showAxisLines),
        check("Scale bar", viewer.showScaleBar),
        check("Sections in the 3-D view", viewer.showPerspectiveSliceViews),
        check("No background behind the sections in 3-D", viewer.hideCrossSectionBackground3D),
        check("Default annotations", viewer.showDefaultAnnotations),
        check("Wire frame", viewer.wireFrame),
      ),
    ),
    group(
      "Background",
      el("div", { class: "options" }, swatch("Sections", viewer.crossSectionBackgroundColor), swatch("3-D view", viewer.perspectiveViewBackgroundColor)),
    ),
    group(
      "Loading",
      el(
        "div",
        { class: "view-limits" },
        bytes("GPU memory", capacities.gpuMemory.sizeLimit),
        bytes("System memory", capacities.systemMemory.sizeLimit),
        count("Downloads at once", capacities.download.itemLimit),
      ),
      el(
        "div",
        { class: "options" },
        check("Prefetch the chunks nearby", viewer.chunkQueueManager.enablePrefetch),
        check("Coarser levels while moving (adaptive downsampling)", viewer.enableAdaptiveDownsampling),
      ),
    ),
  );
  return () => scope.dispose();
}

// ----------------------------------------------------------- statistics

/** The chunks of one source, as Settings › Developer lists them. */
export interface ChunkSourceStatistics {
  /** The kind of source, e.g. "zarr volume". */
  kind: string;
  /** What tells it from the other sources: its URL, a scale. */
  details: string[];
  /** Everything Neuroglancer knows of it, as JSON, for a tooltip. */
  id: string;
  /** Chunks the views need: all of them, downloading, in system memory, on the GPU, failed. */
  visible: number;
  downloading: number;
  memory: number;
  gpu: number;
  failed: number;
  /** GPU memory of the chunks the views need, in bytes. */
  gpuBytes: number;
  /** The mean download time, in ms; NaN before the first. */
  latency: number;
}

const column = (key: string) => {
  const c = columnSpecifications.find((c) => c.key === key);
  return (statistics: Float64Array) => (c === undefined ? NaN : c.getter(statistics));
};
const COLUMNS = {
  visible: column("visibleChunksTotal"),
  downloading: column("visibleChunksDownloading"),
  memory: column("visibleChunksSystemMemory"),
  gpu: column("visibleChunksGpuMemory"),
  failed: column("visibleChunksFailed"),
  gpuBytes: column("visibleGpuMemory"),
  latency: column("downloadLatency"),
};

/** "zarr/VolumeChunkSource" as "zarr volume". */
function kindOf(type: string): string {
  const [format, name = ""] = type.split("/");
  const words = name
    .replace(/(Chunk)?Source$/, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase();
  return `${format} ${words}`.trim();
}

/**
 * A URL by its last part, then the one before (a store's level, then the
 * store: "0 · brain.ome.zarr"), so a cut-off line still tells them apart;
 * anything else as "name value".
 */
function detailOf(key: string, value: string): string {
  if (/^[a-z0-9+-]+:\/\//i.test(value)) {
    const parts = value.replace(/[?#].*$/, "").replace(/\/+$/, "").split("/").slice(3);
    return parts.length >= 2 ? `${parts.at(-1)} · ${parts.at(-2)}` : value;
  }
  const name = key.replace(/^\.(parameters\.|spec\.)?/, "");
  return name === "" || name === "url" ? value : `${name} ${value}`;
}

/** What each chunk source has loaded for the views, as Neuroglancer's statistics panel counts it. */
export async function chunkStatistics(viewer: Viewer): Promise<ChunkSourceStatistics[]> {
  const data = await viewer.chunkQueueManager.getStatistics();
  const sources = [...data.keys()];
  const names = getFormattedNames(sources.map(getChunkSourceIdentifier));
  return sources.map((source, i) => {
    const statistics = data.get(source)!;
    let parts: Record<string, string>;
    try {
      const parsed = JSON.parse(names[i]) as unknown;
      parts = parsed !== null && typeof parsed === "object" ? (parsed as Record<string, string>) : { "": String(parsed) };
    } catch {
      parts = { "": names[i] };
    }
    const { ".type": type = "", ...rest } = parts;
    return {
      kind: kindOf(type),
      details: Object.entries(rest).map(([k, v]) => detailOf(k, v)),
      id: JSON.stringify(getChunkSourceIdentifier(source)),
      visible: COLUMNS.visible(statistics),
      downloading: COLUMNS.downloading(statistics),
      memory: COLUMNS.memory(statistics),
      gpu: COLUMNS.gpu(statistics),
      failed: COLUMNS.failed(statistics),
      gpuBytes: COLUMNS.gpuBytes(statistics),
      latency: COLUMNS.latency(statistics),
    };
  });
}
