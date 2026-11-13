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

function headers(link: Link, json: boolean): Record<string, string> {
  const h: Record<string, string> = {};
  if (link.token) {
    if (link.viaRunner) h.Authorization = `Bearer ${link.token}`;
    else h["X-NGP-Service-Token"] = link.token;
  }
  if (json) h["Content-Type"] = "application/json";
  return h;
}

/**
 * An answer from the service that is not a success: its HTTP status (404: it
 * no longer knows the session; 410: the session failed; 503, 429, 507: a
 * refusal, below), what the answer said besides its error (`reason`,
 * `need_mb`…), and the seconds its `Retry-After` asks to wait.
 */
export class ServiceError extends Error {
  constructor(message: string, readonly status = 0, readonly detail: Record<string, unknown> = {}, readonly retryAfter?: number) {
    super(message);
  }
}

/** Megabytes in a few words: "900 MB", "1.2 GB". */
export function sizeText(mb: number): string {
  return mb < 1024 ? `${Math.round(mb)} MB` : `${(mb / 1024).toFixed(mb < 10240 ? 1 : 0)} GB`;
}

/**
 * The service's refusals in plain words: its GPU busy (503), too many jobs
 * waiting (429), its disk nearly full (507), and whether trying again can
 * help (a job that could never fit, a 400, cannot).  Undefined for any
 * other error.
 */
export function refusal(e: unknown): { text: string; retry: boolean } | undefined {
  if (!(e instanceof ServiceError)) return undefined;
  const d = e.detail;
  const mb = (k: string) => (typeof d[k] === "number" ? sizeText(d[k] as number) : undefined);
  if (d.reason === "gpu-budget" || (e.status === 503 && d.need_mb !== undefined)) {
    const need = mb("need_mb"), free = mb("free_mb");
    return { text: `The render computer's GPU is busy${need && free ? ` (needs ${need}, ${free} free)` : ""}. Retry, or close another view.`, retry: true };
  }
  if (d.reason === "queue-full" || e.status === 429) return { text: "Too many jobs waiting on the render computer. Retry when one has finished.", retry: true };
  if (d.reason === "disk" || e.status === 507) {
    const need = mb("need_mb"), free = mb("free_mb");
    return { text: `The render computer's disk is nearly full${need ? ` (needs ${need}${free ? `, ${free} free` : ""})` : ""}. Free some space there, then Retry.`, retry: true };
  }
  if (e.status === 400 && typeof d.error === "string") return { text: d.error, retry: false };
  return undefined;
}

async function call<T>(link: Link, method: string, path: string, body?: unknown, signal?: AbortSignal, init: RequestInit = {}): Promise<T> {
  const r = await go(link, path, { ...init, method, body: body === undefined ? undefined : JSON.stringify(body), signal }, body !== undefined);
  const text = await r.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = text;
  }
  if (!r.ok) {
    const detail = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
    const msg = typeof detail.error === "string" ? detail.error : `${r.status} ${r.statusText}`;
    const wait = Number(r.headers.get("Retry-After"));
    const retryAfter = Number.isFinite(wait) && wait > 0 ? wait : undefined;
    // A refusal (or a request the service says it cannot take) in its plain words; anything else with the request.
    const plain = refusal(new ServiceError("", r.status, detail));
    throw new ServiceError(plain ? plain.text : `${method} ${path}: ${msg}`, r.status, detail, retryAfter);
  }
  return data as T;
}

export interface ServiceInfo {
  service: string;
  version: string;
  gpu: { backend: string; name?: string; free_mb?: number; total_mb?: number; error?: string };
  presets: string[];
  lightmaps?: string[];
  /** Whether the host can fit splats (a Python with torch and gsplat), the gsplat version the fit is written for, and a warning when another is installed; hosts before splats say nothing. */
  splats?: { python: string | null; ready: boolean; gsplat?: string; error?: string; pinned?: string; warning?: string };
  /** Whether the host has ffmpeg, which movies need; hosts before this say nothing. */
  ffmpeg?: boolean;
  /** The GPU memory every session and job draws on (MB), and what holds it; older hosts say nothing. */
  budget?: { total_mb: number; used_mb: number; free_mb: number; held?: { what: string; mb: number }[] };
  /** The stills, movies and splats: the one running and those waiting, in turn. */
  queue?: { running: { kind: string; id: string } | null; waiting: { kind: string; id: string }[]; max_waiting: number };
  /** The space free where jobs write (MB). */
  disk?: { output: string; free_mb: number };
  cache?: Record<string, unknown>;
}

/** The Remote card's line for a host: its GPU, the budget in use and the queue ("GPU: 12.3 of 38 GB in use · 1 job running"). */
export function serviceText(info: ServiceInfo): string {
  const g = info.gpu;
  if (g.backend !== "cuda") return `No GPU: ${g.error ?? ""}`;
  const gb = (mb: number) => (mb / 1024).toFixed(mb < 102400 ? 1 : 0).replace(/\.0$/, "");
  const parts = [g.name ?? "GPU"];
  if (info.budget) parts.push(`GPU: ${gb(info.budget.used_mb)} of ${gb(info.budget.total_mb)} GB in use`);
  else parts.push(`${Math.round((g.free_mb ?? 0) / 1024)} of ${Math.round((g.total_mb ?? 0) / 1024)} GB free`);
  const q = info.queue;
  if (q && (q.running || q.waiting.length > 0)) {
    const n = q.waiting.length;
    parts.push([q.running ? "1 job running" : "", n ? `${n} waiting` : ""].filter(Boolean).join(", "));
  }
  return parts.join(" · ");
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
  /** The loaded level's numpy type ("uint16", "float32"…). */
  dtype?: string;
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
  /** The box holding the tissue (physical mm, x, y, z: low, high). */
  tissue_mm?: [number[], number[]] | null;
  /** The channel and time point shown (from 0), and how many the image has; older hosts say nothing. */
  channel?: number;
  time?: number;
  channels?: number;
  times?: number;
  axes?: string[];
}

export interface SessionInfo {
  id: string;
  status: "loading" | "ready" | "failed";
  progress: number;
  message: string;
  error: string | null;
  volume: VolumeMeta | Record<string, never>;
  labels: { url: string; values: number[] } | null;
  /** The objects read (meshes and the image within them), when the session was opened with some. */
  objects?: { url: string; ids: string[]; triangles: number; level: string; page: number[]; bricks: number; inside_voxels: number } | null;
  samples: number;
  ms_per_pass: number;
}

/** What a frame is drawn from: the camera (column-major), size, the look. */
/** Objects for a session: a precomputed segmentation's segments (their meshes), the meshes' level of detail, and the voxels the image within them may take. */
export interface ObjectsSpec {
  url: string;
  ids: string[];
  lod?: number;
  budget?: number;
}

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
  overrides?: Record<string, number | number[]>;
  light?: { direction: [number, number, number]; rgb?: [number, number, number]; camera_space?: boolean };
  /** World planes (nx, ny, nz, d), kept where n.x + d >= 0. */
  clips?: [number, number, number, number][];
  labels?: { show?: boolean; mix?: number; hidden?: number[]; keep?: number[]; colors?: Record<string, [number, number, number, number]> };
  /** The session's objects: shown or not, the chance a path meeting a surface is scattered by it, the image within them, its tint, colours by segment id. */
  objects?: { show?: boolean; surface?: number; image?: boolean; mix?: number; colors?: Record<string, [number, number, number]> };
  background?: [number, number, number, number];
  /** A clip box: fractions (0..1) of the volume along its x, y, z, low and high. */
  crop_fraction?: [[number, number, number], [number, number, number]];
  /** Crops (up to 8): boxes as fractions of the volume; keep: the inside, else it is cut out. */
  boxes?: { lo: number[]; hi: number[]; keep: boolean }[];
  max_bounces?: number;
  /** Filter the image while it has few samples (the service's; default on). */
  denoise?: boolean;
  /** "jpeg": frames as a JPEG and an alpha plane (quicker to make than the default WebP). */
  frame_format?: "jpeg" | "webp";
  /** The light: a light map by name ("" for the preset's sky colours), turned about the camera's up by `rotation` degrees. */
  environment?: { map?: string; rotation?: number; scale?: number };
  max_samples?: number;
  aperture?: number;
  focus?: number;
}

export interface Frame {
  bitmap: ImageBitmap;
  /** The alpha plane (one byte a pixel, rows from the top), when the colour came as a JPEG (not premultiplied). */
  alpha?: Uint8Array;
  /** What finer detail the host holds or is reading for the view, in a few words. */
  detail?: string;
  number: number;
  samples: number;
  version: number;
  width: number;
  height: number;
  msPerPass: number;
  /** Each pixel's distance to tissue for the frame's view (every second pixel), when the page asked with one it lacked. */
  distance?: Distance;
}

/** The distance along each pixel's ray (from the near plane) to where it first meets tissue, -1 where nothing: the frame's points. */
export interface Distance {
  version: number;
  width: number;
  height: number;
  data: Float32Array;
}

export interface MovieInfo {
  id: string;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  progress: number;
  message: string;
  error: string | null;
  /** While it waits its turn: its place (1: next) and the jobs before it, the one running included. */
  queue_position?: number;
  jobs_ahead?: number;
  file: string | null;
  /** The movie's size and frames, as the host makes it (its sides even for H.264). */
  width?: number;
  height?: number;
  frames?: number;
}

/** A still being path-traced on the host, as a job. */
export type StillInfo = Omit<MovieInfo, "width" | "height" | "frames">;

/** Gaussian splats being made on the host: views path-traced from all round, then fitted to them. */
export interface SplatInfo {
  id: string;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  progress: number;
  message: string;
  error: string | null;
  queue_position?: number;
  jobs_ahead?: number;
  /** The folder on the host with the views, the cameras and the fitted splat. */
  folder: string;
  /** The files of a finished splat the page can fetch ("scene.splat", "splat.ply", "cameras.json", "fit.json"). */
  files: string[];
  result: { gaussians: number; views: number; psnr_held_out: number | null; seconds: number } | null;
}

export class RenderService {
  constructor(readonly link: Link) {}

  info(signal?: AbortSignal): Promise<ServiceInfo> {
    return call(this.link, "GET", "/info", undefined, signal);
  }
  /** A preset at this session's image's data values (its window or histogram matching resolved): for the editor. */
  resolve(id: string, preset: string | Record<string, unknown>, overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return call(this.link, "POST", `/sessions/${id}/resolve`, { preset, overrides });
  }

  presets(): Promise<PresetInfo[]> {
    return call(this.link, "GET", "/presets");
  }
  /** Opens a session on an image (at a channel and time point, from 0; a new session is needed to change either). */
  open(
    volume: { url: string; budget?: number; level?: string; cylinder?: number; detail_budget?: number; channel?: number; time?: number },
    labels?: { url: string },
    objects?: ObjectsSpec,
  ): Promise<SessionInfo> {
    return call(this.link, "POST", "/sessions", { volume, labels, objects });
  }
  session(id: string): Promise<SessionInfo> {
    return call(this.link, "GET", `/sessions/${id}`);
  }
  /** Closes a session; `keepalive` lets the request finish as the page closes. */
  close(id: string, keepalive = false): Promise<unknown> {
    return call(this.link, "DELETE", `/sessions/${id}`, undefined, undefined, keepalive ? { keepalive: true } : {});
  }
  setView(id: string, view: ViewSpec): Promise<{ version: number }> {
    return call(this.link, "PUT", `/sessions/${id}/view`, view);
  }
  /** One view path-traced to a sample count at a size, as a job: its progress with stillInfo, its PNG with stillFile. */
  still(id: string, spec: Record<string, unknown>): Promise<StillInfo> {
    return call(this.link, "POST", `/sessions/${id}/stills`, spec);
  }
  stillInfo(id: string): Promise<StillInfo> {
    return call(this.link, "GET", `/stills/${id}`);
  }
  cancelStill(id: string): Promise<StillInfo> {
    return call(this.link, "DELETE", `/stills/${id}`);
  }
  async stillFile(id: string): Promise<Blob> {
    const r = await go(this.link, `/stills/${id}/file`);
    if (!r.ok) throw new ServiceError(`still file: ${r.status}`, r.status);
    return r.blob();
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
  /** Splats of the view: `views` path-traced at `size` (the longer side) and `samples`, over a cap of `cover` degrees (180: all round), then fitted for `steps` (0: views only). */
  splat(id: string, spec: Record<string, unknown>): Promise<SplatInfo> {
    return call(this.link, "POST", `/sessions/${id}/splats`, spec);
  }
  splatInfo(id: string): Promise<SplatInfo> {
    return call(this.link, "GET", `/splats/${id}`);
  }
  cancelSplat(id: string): Promise<SplatInfo> {
    return call(this.link, "DELETE", `/splats/${id}`);
  }
  async splatFile(id: string, name: string): Promise<ArrayBuffer> {
    const r = await go(this.link, `/splats/${id}/file/${name}`);
    if (!r.ok) throw new ServiceError(`splat file: ${r.status}`);
    return r.arrayBuffer();
  }
  async movieFile(id: string): Promise<Blob> {
    const r = await go(this.link, `/movies/${id}/file`);
    if (!r.ok) throw new ServiceError(`movie file: ${r.status}`);
    return r.blob();
  }

  /**
   * The next frame after `after`, or undefined when none came within the wait.  `have`: the view whose
   * distances the page has; a frame of another view comes with its own (a host that sends them).
   */
  async frame(id: string, after: number, signal?: AbortSignal, have = -1): Promise<Frame | undefined> {
    const r = await go(this.link, `/sessions/${id}/frame?after=${after}&timeout=20&have=${have}`, { signal });
    if (r.status === 204) return undefined;
    if (!r.ok) {
      const error = ((await r.json().catch(() => ({}))) as { error?: string }).error;
      throw new ServiceError(`frame: ${error ?? r.status}`, r.status);
    }
    let blob = await r.blob();
    const n = (k: string) => Number(r.headers.get(k) ?? 0);
    const version = n("X-Version");
    // After the picture: its points (every second pixel's distance, as float16 over a scale), deflated.
    const dOffset = n("X-Distance-Offset");
    let distance: Promise<Distance> | undefined;
    if (dOffset && r.headers.get("X-Distance-Format") === "float16-zlib") {
      const tail = blob.slice(dOffset);
      blob = blob.slice(0, dOffset);
      const width = n("X-Distance-Width"), height = n("X-Distance-Height"), scale = n("X-Distance-Scale");
      distance = new Response(tail.stream().pipeThrough(new DecompressionStream("deflate"))).arrayBuffer().then((b) => ({ version, width, height, data: scaledDistance(new Uint16Array(b), scale) }));
    }
    const offset = n("X-Alpha-Offset");
    // A JPEG then its alpha plane deflated, or a WebP with its alpha.
    const [bitmap, alpha, dist] = await Promise.all([
      createImageBitmap(offset ? blob.slice(0, offset, "image/jpeg") : blob, { premultiplyAlpha: "none" }),
      offset ? new Response(blob.slice(offset).stream().pipeThrough(new DecompressionStream("deflate"))).arrayBuffer().then((b) => new Uint8Array(b)) : undefined,
      distance,
    ]);
    return { bitmap, alpha, detail: r.headers.get("X-Detail") ?? undefined, number: n("X-Frame"), samples: n("X-Samples"), version, width: n("X-Width"), height: n("X-Height"), msPerPass: n("X-Ms-Per-Pass"), distance: dist };
  }

  /** The distance along each pixel's ray (from the near plane) to where it first meets tissue, -1 where nothing: the frame's points, to draw it moving with the view. */
  async distance(id: string): Promise<{ version: number; width: number; height: number; data: Float32Array } | undefined> {
    const r = await go(this.link, `/sessions/${id}/depth?channel=distance`);
    if (r.status === 204 || !r.ok || r.headers.get("X-Format") !== "float32-zlib") return undefined;
    const width = Number(r.headers.get("X-Width")), height = Number(r.headers.get("X-Height")), version = Number(r.headers.get("X-Version"));
    const buf = await new Response(r.body!.pipeThrough(new DecompressionStream("deflate"))).arrayBuffer();
    return { version, width, height, data: new Float32Array(buf) };
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

/** Distances sent as half floats over a scale: times the scale, with -1 (nothing there) kept. */
export function scaledDistance(h: Uint16Array, scale: number): Float32Array {
  const out = halfToFloat(h);
  for (let i = 0; i < out.length; ++i) out[i] = out[i] < 0 ? -1 : out[i] * scale;
  return out;
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
