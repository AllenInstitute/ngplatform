/**
 * Which of a layer's sources it draws.  A source with its default parts off
 * and none switched on draws nothing: a track-filtering group with a store
 * of its own keeps the dataset's source that way (for its segment
 * properties) beside its own store, which is what it shows.  Pure, so the
 * tests can use it.
 */

type SourceSpec = string | { url?: unknown; enableDefaultSubsources?: unknown; subsources?: unknown };

/** Whether a source, as the layer's specification gives it, draws anything. */
function draws(source: SourceSpec): boolean {
  if (typeof source !== "object" || source === null) return true;
  if (source.enableDefaultSubsources !== false) return true;
  const parts = source.subsources;
  if (parts === null || typeof parts !== "object") return false;
  return Object.values(parts as Record<string, unknown>).some((v) => v === true || (typeof v === "object" && v !== null));
}

/** The layer's source URLs (as `LayerInfo.sources` lists them) less those its specification says draw nothing. */
export function drawnSources(sources: string[], spec: { source?: unknown } | undefined): string[] {
  const raw = spec?.source;
  const list: SourceSpec[] = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw as SourceSpec];
  const silent = new Set(list.filter((s) => !draws(s)).map((s) => (typeof s === "object" && s !== null ? String(s.url) : String(s))));
  return sources.filter((url) => !silent.has(url));
}
