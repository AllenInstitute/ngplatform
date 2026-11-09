/**
 * Segmentation layers whose segments have precomputed meshes, as Luxar
 * draws them: the URL of the virtual mesh store for the segments a layer
 * shows (read in the worker, ./precomputed_meshes.ts), and which segments
 * it holds.  Light and pure, for the panel and the tests.
 */

const SCHEME = "precomputed-meshes:";

/** At most this many segments' meshes in one store. */
export const MAX_SEGMENTS = 2000;

const ascending = (a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0);

/** The store URL of a volume's meshes for these segments (`volume`: its http(s) URL, ending in "/"). */
export function meshStoreUrl(volume: string, ids: Iterable<bigint>): string {
  return `${SCHEME}${volume}#segments=${[...new Set(ids)].sort(ascending).join(",")}`;
}

/** A mesh store URL's volume and segments; undefined for any other URL. */
export function parseMeshStoreUrl(url: string): { volume: string; ids: bigint[] } | undefined {
  if (!url.startsWith(SCHEME)) return undefined;
  const hash = url.indexOf("#segments=");
  if (hash < 0) return undefined;
  const ids = url
    .slice(hash + "#segments=".length)
    .split(",")
    .filter((s) => /^\d+$/.test(s))
    .map((s) => BigInt(s));
  return { volume: url.slice(SCHEME.length, hash), ids };
}

/**
 * The segments a layer's mesh store holds: those it shows (at most
 * MAX_SEGMENTS), or the store's own while they include every one shown, so
 * letting a segment go reads nothing again (the layer's table hides it) and
 * only a segment not yet read makes a new store.
 */
export function meshIdsFor(shown: ArrayLike<bigint>, current: readonly bigint[] | undefined): bigint[] {
  const ids = Array.from(shown).sort(ascending).slice(0, MAX_SEGMENTS);
  if (current !== undefined && ids.length > 0) {
    const held = new Set(current);
    if (ids.every((id) => held.has(id))) return [...current];
  }
  return ids;
}

/**
 * Whether a precomputed volume (its http(s) URL, ending in "/") is a
 * segmentation with meshes: its `info` names a mesh directory.
 */
export async function volumeHasMeshes(volume: string): Promise<boolean> {
  try {
    const response = await fetch(`${volume}info`);
    if (!response.ok) return false;
    const info = await response.json();
    return info?.type === "segmentation" && typeof info.mesh === "string" && info.mesh !== "";
  } catch {
    return false;
  }
}
