/**
 * What the view aids keep in the workspace (each scene's own, in the link,
 * undoable): the cube and labels switches, what Hide graphics turned off
 * (to put back exactly), and the bookmarks.
 */
import { type Camera, readCamera } from "./camera.js";

export interface Bookmark {
  id: string;
  name: string;
  /** A small picture of the 3-D view (a data URL). */
  thumbnail?: string;
  camera: Camera;
}

/** Neuroglancer's switches Hide graphics turns off. */
export const GRAPHICS = ["showAxisLines", "showDefaultAnnotations", "showScaleBar"] as const;
export type GraphicsKey = (typeof GRAPHICS)[number];

export interface Saved {
  cube: boolean;
  labels: boolean;
  /** While graphics are hidden: what each of Neuroglancer's switches was before. */
  hidden?: Record<GraphicsKey, boolean>;
  bookmarks: Bookmark[];
}

/** Thumbnails' size, pixels (shown at half). */
export const THUMB = { width: 128, height: 80 };

/** Reads the saved state, whatever an older version (or nothing) left. */
export function readSaved(raw: unknown): Saved {
  const r = (raw ?? {}) as Partial<Record<keyof Saved, unknown>>;
  const saved: Saved = {
    cube: r.cube !== false,
    labels: r.labels !== false,
    bookmarks: [],
  };
  if (r.hidden !== null && typeof r.hidden === "object") {
    const h = r.hidden as Record<string, unknown>;
    saved.hidden = Object.fromEntries(GRAPHICS.map((k) => [k, h[k] !== false])) as Record<GraphicsKey, boolean>;
  }
  if (Array.isArray(r.bookmarks)) {
    for (const b of r.bookmarks as Record<string, unknown>[]) {
      if (b === null || typeof b !== "object" || typeof b.id !== "string") continue;
      saved.bookmarks.push({
        id: b.id,
        name: typeof b.name === "string" ? b.name : "View",
        ...(typeof b.thumbnail === "string" && b.thumbnail.startsWith("data:image/") ? { thumbnail: b.thumbnail } : {}),
        camera: readCamera(b.camera),
      });
    }
  }
  return saved;
}

/** A name for a new bookmark: "View 1", "View 2"… the first not taken. */
export function nextName(bookmarks: readonly { name: string }[]): string {
  const taken = new Set(bookmarks.map((b) => b.name));
  let k = bookmarks.length + 1;
  while (taken.has(`View ${k}`)) k++;
  return `View ${k}`;
}

/** The state's values Hide graphics changes: all off. */
export function graphicsOff(): Record<GraphicsKey, boolean> {
  return Object.fromEntries(GRAPHICS.map((k) => [k, false])) as Record<GraphicsKey, boolean>;
}

/** Each of Neuroglancer's switches as the state has it (Neuroglancer's default, on, when not written). */
export function graphicsNow(part: (key: string) => unknown): Record<GraphicsKey, boolean> {
  return Object.fromEntries(GRAPHICS.map((k) => [k, part(k) !== false])) as Record<GraphicsKey, boolean>;
}
