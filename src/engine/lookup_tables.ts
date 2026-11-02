/**
 * Lookup tables in Neuroglancer: a `lut://` data source that gives a
 * segmentation layer its segments' names (a segment property map, which the
 * Segments tab, hover values and the segment query read), and the colours
 * set as the layer's own segment colours, which the state keeps.
 *
 * The tables shipped with the app are in data/lookup-tables/ (bundled, so
 * they work offline); tables whose licence does not allow us to ship them
 * are fetched from their publishers when chosen; a table from this computer
 * travels in the link, compressed (see src/core/lookup_table.ts).
 */
import {
  hexColour,
  inlineLookupText,
  type LookupSource,
  type LookupTable,
  LookupTableError,
  lookupSourceUrl,
  parseLookupSource,
  parseLookupTable,
} from "../core/lookup_table.js";
import CATALOGUE from "../../data/lookup-tables/tables.json";
import {
  emptyValidCoordinateSpace,
  makeIdentityTransform,
  normalizeInlineSegmentPropertyMap,
  packColor,
  registerProvider,
  SegmentationUserLayer,
  SegmentPropertyMap,
  type UserLayer,
} from "./neuroglancer.js";

export interface CatalogueTable {
  id: string;
  title: string;
  /** For grouping in menus ("Human", "Mouse"). */
  group: string;
  description?: string;
  /** A file in data/lookup-tables/, bundled with the app. */
  file?: string;
  /** Or where the publisher serves it, fetched when chosen (its licence does not let us ship it). */
  url?: string;
  /** FSL atlas XML: the image value of label index 0. */
  xmlOffset?: number;
  source: string;
  licence: string;
}

export const LOOKUP_TABLES = CATALOGUE as CatalogueTable[];

// The bundled tables' text, each its own chunk loaded when first used.
const BUNDLED = import.meta.glob("../../data/lookup-tables/*.txt", { query: "?raw", import: "default" }) as Record<string, () => Promise<string>>;

const cache = new Map<string, Promise<LookupTable>>();

/** The table a `lut://` URL names (a table from this computer has names only, no colours). */
export function loadLookupTable(url: string): Promise<LookupTable> {
  let table = cache.get(url);
  if (table === undefined) {
    table = readTable(url);
    cache.set(url, table);
    table.catch(() => cache.delete(url));
  }
  return table;
}

async function readTable(url: string): Promise<LookupTable> {
  const source = parseLookupSource(url);
  if (source === undefined) throw new LookupTableError(`Not a lookup table: ${url}`);
  switch (source.kind) {
    case "bundled": {
      const entry = LOOKUP_TABLES.find((t) => t.id === source.id);
      if (entry === undefined) throw new LookupTableError(`No lookup table called “${source.id}” comes with this app.`);
      if (entry.url !== undefined) return fetchTable(entry.url, entry.xmlOffset);
      const load = BUNDLED[`../../data/lookup-tables/${entry.file}`];
      if (load === undefined) throw new LookupTableError(`The lookup table “${source.id}” is missing from this build.`);
      return parseLookupTable(await load());
    }
    case "remote":
      return fetchTable(source.url);
    case "inline":
      return parseLookupTable(await inlineLookupText(source.data));
  }
}

async function fetchTable(url: string, xmlOffset?: number): Promise<LookupTable> {
  let response: Response;
  try {
    response = await fetch(url);
  } catch (e) {
    throw new LookupTableError(`Could not fetch the lookup table from ${url}: ${(e as Error).message}`);
  }
  if (!response.ok) throw new LookupTableError(`Could not fetch the lookup table from ${url}: ${response.status} ${response.statusText}`);
  return parseLookupTable(await response.text(), { xmlOffset });
}

/** Names and descriptions as Neuroglancer's segment properties. */
function propertyMap(table: LookupTable): SegmentPropertyMap {
  const { entries } = table;
  const ids = BigUint64Array.from(entries.map((e) => e.value));
  const properties: { id: string; type: "label" | "description"; values: string[] }[] = [{ id: "label", type: "label", values: entries.map((e) => e.name) }];
  if (entries.some((e) => e.description !== undefined)) properties.push({ id: "description", type: "description", values: entries.map((e) => e.description ?? "") });
  return new SegmentPropertyMap({ inlineProperties: normalizeInlineSegmentPropertyMap({ ids, properties }) });
}

registerProvider({
  scheme: "lut",
  description: "Label lookup table: segment names",
  async get(options: { providerUrl: string }) {
    const table = await loadLookupTable(`lut://${options.providerUrl}`);
    return {
      modelTransform: makeIdentityTransform(emptyValidCoordinateSpace),
      subsources: [{ id: "default", default: true, subsource: { segmentPropertyMap: propertyMap(table) } }],
    };
  },
} as never);

// ------------------------------------------------------- layer state

/** The `lut://` source of a segmentation layer, if it has one. */
export function layerLookupSource(layer: UserLayer): string | undefined {
  return layer.dataSources.map((d) => d.spec.url).find((u) => u.startsWith("lut://"));
}

/** A label for a `lut://` URL: the catalogue's title, the file's name, or the URL. */
export function lookupTitle(url: string): string {
  const source: LookupSource | undefined = parseLookupSource(url);
  if (source?.kind === "bundled") return LOOKUP_TABLES.find((t) => t.id === source.id)?.title ?? source.id;
  if (source?.kind === "inline") return source.title;
  if (source?.kind === "remote") return source.url.split("/").pop() ?? source.url;
  return url;
}

/**
 * Gives a segmentation layer a table: its colours as the layer's segment
 * colours, its names through a `lut://` source.  The colours of the table
 * it had before are taken off first, except those changed since by hand.
 * `colours` is the table itself when `url` holds names only (a file's).
 */
export async function applyLookupTable(layer: SegmentationUserLayer, url: string | undefined, colours?: LookupTable): Promise<LookupTable | undefined> {
  const previous = layerLookupSource(layer);
  const table = url === undefined ? undefined : (colours ?? (await loadLookupTable(url)));
  const ds = layer.displayState as any;
  const stated = ds.segmentationColorGroupState.value.segmentStatedColors as { get(k: bigint): bigint | undefined; set(k: bigint, v: bigint): void; delete(k: bigint): void };
  if (previous !== undefined && previous !== url) {
    const old = await loadLookupTable(previous).catch(() => undefined);
    // An inline table has no colours of its own: drop what the layer's colours say it set.
    for (const e of old?.entries ?? []) {
      const packed = stated.get(e.value);
      if (packed !== undefined && (old!.generatedColours || packed === BigInt(packColor(rgb(e.colour))))) stated.delete(e.value);
    }
  }
  if (table !== undefined) {
    for (const e of table.entries) stated.set(e.value, BigInt(packColor(rgb(e.colour))));
    // FreeSurfer's 0 is "Unknown": the background.
    if (table.entries.some((e) => e.value === 0n)) ds.hideSegmentZero.value = true;
  }
  setLookupSource(layer, url);
  return table;
}

function rgb(colour: readonly number[]): Parameters<typeof packColor>[0] {
  return Float32Array.from(colour, (c) => c / 255) as never;
}

function setLookupSource(layer: UserLayer, url: string | undefined): void {
  const existing = layer.dataSources.find((d) => d.spec.url.startsWith("lut://"));
  if (existing !== undefined) {
    if (url === undefined) existing.spec = { ...existing.spec, url: "" };
    else if (existing.spec.url !== url) existing.spec = { ...existing.spec, url };
    return;
  }
  if (url !== undefined) layer.addDataSource({ url, transform: undefined, enableDefaultSubsources: true, subsources: new Map() });
}

/** A catalogue table's `lut://` URL. */
export function catalogueUrl(table: CatalogueTable): string {
  return lookupSourceUrl({ kind: "bundled", id: table.id });
}

export { hexColour };
