/**
 * The render service, as the plugin talks to it: through a runner's
 * service proxy (`<runner>/svc/render/...`, on this computer or at the
 * end of an SSH tunnel) or straight at a render service's own address.
 */

/** Where the render service is: a base URL (ending before `/sessions`) and the token it wants. */
export interface Link {
  base: string;
  token: string;
  /** The service answers through a runner (bearer token) rather than on its own (service token). */
  viaRunner: boolean;
  /** A paired host's own fetch (ctx.hosts: `path` relative to `/svc/`, the token added), used instead of base and token. */
  hostFetch?: (path: string, init?: RequestInit) => Promise<Response>;
  /** What to call it in messages. */
  label?: string;
}

/** A link through a host the app is paired with (ctx.hosts). */
export function hostLink(name: string, address: string, hostFetch: (path: string, init?: RequestInit) => Promise<Response>): Link {
  return { base: `${address.replace(/\/+$/, "")}/svc/render`, token: "", viaRunner: true, hostFetch, label: name };
}

/** A request to the service at `path` (from `/sessions` on). */
function go(link: Link, path: string, init: RequestInit = {}, json = false): Promise<Response> {
  if (link.hostFetch) {
    const h = new Headers(init.headers);
    if (json) h.set("Content-Type", "application/json");
    return link.hostFetch(`render${path}`, { ...init, headers: h });
  }
  return fetch(`${link.base}${path}`, { ...init, headers: { ...headers(link, json), ...(init.headers as Record<string, string> | undefined) } });
}

export function linkOf(address: string, token: string, viaRunner: boolean): Link {
  const a = address.trim().replace(/\/+$/, "");
  return { base: viaRunner ? `${a}/svc/render` : a, token: token.trim(), viaRunner };
}

function headers(link: Link, json: boolean): Record<string, string> {
  const h: Record<string, string> = {};
  if (link.token) {
    if (link.viaRunner) h.Authorization = `Bearer ${link.token}`;
    else h["X-NGP-Service-Token"] = link.token;
  }
  if (json) h["Content-Type"] = "application/json";
  return h;
}

export class ServiceError extends Error {}

async function call<T>(link: Link, method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const r = await go(link, path, { method, body: body === undefined ? undefined : JSON.stringify(body), signal }, body !== undefined);
  const text = await r.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = text;
  }
  if (!r.ok) {
    const msg = (data as { error?: string } | undefined)?.error ?? `${r.status} ${r.statusText}`;
    throw new ServiceError(`${method} ${path}: ${msg}`);
  }
  return data as T;
}

export interface ServiceInfo {
  service: string;
  version: string;
  gpu: { backend: string; name?: string; free_mb?: number; total_mb?: number; error?: string };
  presets: string[];
}

export interface PresetInfo {
  name: string;
  modality: string;
  description: string;
  density: number;
  [k: string]: unknown;
}

export interface VolumeMeta {
  url: string;
  level: string;
  shape: number[];
  voxel_mm: number[];
  /** Voxel (x, y, z) to physical mm, column-major. */
  affine: number[];
  lo: number;
  hi: number;
  percentiles: Record<string, number>;
  source_shape: number[];
  made: boolean;
  from_cache: boolean;
  seconds: number;
}

export interface SessionInfo {
  id: string;
  status: "loading" | "ready" | "failed";
  progress: number;
  message: string;
  error: string | null;
  volume: VolumeMeta | Record<string, never>;
  labels: { url: string; values: number[] } | null;
  samples: number;
  ms_per_pass: number;
}

/** What a frame is drawn from: the camera (column-major), size, the look. */
export interface ViewSpec {
  inv_view_projection: number[];
  width: number;
  height: number;
  /** Render at this fraction of the size (cheaper while the camera moves). */
  scale?: number;
  /** The point the view turns about (the viewer's position, display coordinates): movies move the camera around it. */
  orbit_center?: number[];
  /** Physical mm (x, y, z) to display coordinates, column-major. */
  world_from_physical?: number[];
  /** How many mm one display unit is. */
  unit_mm?: number;
  preset: string | Record<string, unknown>;
  overrides?: Record<string, number>;
  light?: { direction: [number, number, number]; rgb?: [number, number, number]; camera_space?: boolean };
  /** World planes (nx, ny, nz, d), kept where n.x + d >= 0. */
  clips?: [number, number, number, number][];
  labels?: { show?: boolean; mix?: number; hidden?: number[]; keep?: number[]; colors?: Record<string, [number, number, number, number]> };
  background?: [number, number, number, number];
  max_bounces?: number;
  max_samples?: number;
  aperture?: number;
  focus?: number;
}

export interface Frame {
  bitmap: ImageBitmap;
  number: number;
  samples: number;
  version: number;
  width: number;
  height: number;
  msPerPass: number;
}

export interface MovieInfo {
  id: string;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  progress: number;
  message: string;
  error: string | null;
  file: string | null;
}

export class RenderService {
  constructor(readonly link: Link) {}

  info(signal?: AbortSignal): Promise<ServiceInfo> {
    return call(this.link, "GET", "/info", undefined, signal);
  }
  presets(): Promise<PresetInfo[]> {
    return call(this.link, "GET", "/presets");
  }
  open(volume: { url: string; budget?: number; level?: string }, labels?: { url: string }): Promise<SessionInfo> {
    return call(this.link, "POST", "/sessions", { volume, labels });
  }
  session(id: string): Promise<SessionInfo> {
    return call(this.link, "GET", `/sessions/${id}`);
  }
  close(id: string): Promise<unknown> {
    return call(this.link, "DELETE", `/sessions/${id}`);
  }
  setView(id: string, view: ViewSpec): Promise<{ version: number }> {
    return call(this.link, "PUT", `/sessions/${id}/view`, view);
  }
  movie(id: string, spec: Record<string, unknown>): Promise<MovieInfo> {
    return call(this.link, "POST", `/sessions/${id}/movies`, spec);
  }
  movieInfo(id: string): Promise<MovieInfo> {
    return call(this.link, "GET", `/movies/${id}`);
  }
  cancelMovie(id: string): Promise<MovieInfo> {
    return call(this.link, "DELETE", `/movies/${id}`);
  }
  async movieFile(id: string): Promise<Blob> {
    const r = await go(this.link, `/movies/${id}/file`);
    if (!r.ok) throw new ServiceError(`movie file: ${r.status}`);
    return r.blob();
  }

  /** The next frame after `after`, or undefined when none came within the wait. */
  async frame(id: string, after: number, signal?: AbortSignal): Promise<Frame | undefined> {
    const r = await go(this.link, `/sessions/${id}/frame?after=${after}&timeout=20`, { signal });
    if (r.status === 204) return undefined;
    if (!r.ok) throw new ServiceError(`frame: ${r.status}`);
    const blob = await r.blob();
    const bitmap = await createImageBitmap(blob, { premultiplyAlpha: "none" });
    const n = (k: string) => Number(r.headers.get(k) ?? 0);
    return { bitmap, number: n("X-Frame"), samples: n("X-Samples"), version: n("X-Version"), width: n("X-Width"), height: n("X-Height"), msPerPass: n("X-Ms-Per-Pass") };
  }

  /** The depth (GL 0..1, 1 where nothing) of the view `version`, at the frame's size. */
  async depth(id: string): Promise<{ version: number; width: number; height: number; data: Float32Array } | undefined> {
    const r = await go(this.link, `/sessions/${id}/depth`);
    if (r.status === 204 || !r.ok) return undefined;
    const width = Number(r.headers.get("X-Width")), height = Number(r.headers.get("X-Height")), version = Number(r.headers.get("X-Version"));
    const stream = r.body!.pipeThrough(new DecompressionStream("deflate"));
    const buf = new Uint8Array(await new Response(stream).arrayBuffer());
    return { version, width, height, data: halfToFloat(new Uint16Array(buf.buffer, buf.byteOffset, buf.byteLength >> 1)) };
  }
}

/** IEEE half floats to float32. */
export function halfToFloat(h: Uint16Array): Float32Array {
  const out = new Float32Array(h.length);
  for (let i = 0; i < h.length; ++i) {
    const v = h[i];
    const s = v & 0x8000 ? -1 : 1;
    const e = (v >> 10) & 0x1f;
    const m = v & 0x3ff;
    out[i] = e === 0 ? s * m * 2 ** -24 : e === 31 ? (m ? NaN : s * Infinity) : s * (1 + m / 1024) * 2 ** (e - 15);
  }
  return out;
}
