/**
 * Zarr-vectors store facts, as a built-in plugin.
 *
 * It goes through the same manifest and context as any plugin (an inspector
 * section shown when the selected dataset is a zarr-vectors store), which
 * keeps the plugin API honest.
 */
import { fetchableUrl } from "../core/state_io.js";
import type { Manifest, PluginModule } from "../sdk/types.js";
import { clear, h } from "../ui/dom.js";
import { fmt } from "../ui/panels/format.js";

export const ZARR_VECTORS_MANIFEST: Manifest = {
  id: "org.ngplatform.zarr-vectors",
  name: "Zarr-vectors",
  version: "0.2.0",
  description: "Store facts for zarr-vectors datasets: geometry, objects, levels, extent, chunking and format.",
  license: "Apache-2.0",
  contributes: {
    inspector: [{ id: "zarr-vectors.store", title: "Zarr-vectors store", order: 20, when: "sourceFormat == zarr-vectors" }],
  },
};

interface StoreFacts {
  geometry: string;
  version: string;
  objects?: number;
  levels?: number;
  bounds?: string;
  chunk?: string;
  space?: string;
}

/** The store URL inside a layer source, when it is one we can fetch. */
export function zarrVectorsStore(source: string): string | undefined {
  let url = source;
  if (url.startsWith("zarr-vectors://")) url = url.slice("zarr-vectors://".length);
  else if (/\|zarr-vectors:/.test(url)) url = url.split("|zarr-vectors:")[0];
  else if (!/\.zarrvectors\/?$/.test(url)) return undefined;
  if (url.includes("|")) return undefined; // inside a zip or another adapter
  url = fetchableUrl(url);
  if (!/^https?:\/\//.test(url)) return undefined;
  return url.endsWith("/") ? url : url + "/";
}

const cache = new Map<string, Promise<StoreFacts | null>>();

async function loadFacts(store: string): Promise<StoreFacts | null> {
  try {
    const root = await (await fetch(store + "zarr.json")).json();
    const zv = root?.attributes?.zarr_vectors ?? {};
    const facts: StoreFacts = {
      geometry: (zv.geometry_types ?? []).join(", ") || "unknown",
      version: String(zv.zv_version ?? "?"),
    };
    const ms = zv.multiscales ?? root?.attributes?.multiscales;
    const datasets = Array.isArray(ms) ? ms[0]?.datasets : ms?.datasets;
    if (Array.isArray(datasets)) facts.levels = datasets.length;
    if (Array.isArray(zv.bounds)) {
      const [lo, hi] = zv.bounds as number[][];
      facts.bounds = lo.map((l, i) => fmt(hi[i] - l)).join(" × ");
    }
    if (Array.isArray(zv.chunk_shape)) facts.chunk = (zv.chunk_shape as number[]).map((c) => fmt(c)).join(" × ");
    if (zv.crs?.input_space) facts.space = `${zv.crs.input_space} → ${zv.crs.output_space ?? "?"}`;
    try {
      const index = await (await fetch(store + "0/object_index/zarr.json")).json();
      const n = index?.attributes?.num_objects;
      if (typeof n === "number") facts.objects = n;
    } catch {
      // A store without an object index still has the root facts.
    }
    return facts;
  } catch {
    return null;
  }
}

/** Facts per store URL; a rewritten store needs a reload, as in the viewer itself. */
function factsFor(store: string): Promise<StoreFacts | null> {
  let pending = cache.get(store);
  if (pending === undefined) {
    pending = loadFacts(store);
    cache.set(store, pending);
  }
  return pending;
}

export const zarrVectorsPlugin: PluginModule = {
  activate(ctx) {
    ctx.ui.inspectorSection("zarr-vectors.store", (host, target) => {
      const source = target.layer?.sources.find((s) => zarrVectorsStore(s) !== undefined);
      const store = source && zarrVectorsStore(source);
      if (store === undefined) return;
      host.append(h("p", { class: "note" }, "Reading store metadata…"));
      let live = true;
      void factsFor(store).then((facts) => {
        if (!live) return;
        if (facts === null) {
          clear(host, h("p", { class: "note" }, "Could not read this store's metadata."));
          return;
        }
        const rows: [string, string | undefined][] = [
          ["Geometry", facts.geometry],
          ["Objects", facts.objects?.toLocaleString()],
          ["Levels", facts.levels?.toString()],
          ["Extent", facts.bounds && facts.bounds + " mm"],
          ["Chunk", facts.chunk && facts.chunk + " mm"],
          ["Space", facts.space],
          ["Format", facts.version],
        ];
        clear(
          host,
          h("dl", { class: "facts" }, ...rows.filter(([, v]) => v !== undefined).flatMap(([k, v]) => [h("dt", {}, k), h("dd", {}, v!)])),
        );
      });
      return () => {
        live = false;
      };
    });
  },
};
