/**
 * Images computed in the page by chunkmirage's browser engine
 * (vendor/chunkmirage/web/src/engine.ts): a pipeline of chunkmirage ops over
 * any image the viewer reads (an OME-Zarr, N5 or precomputed volume at a
 * URL, or a file on this computer under <app>/local/), served as OME-Zarr
 * 0.5 under <app>/virtual/ngp/<view>/.  <view> is the pipeline itself
 * (deflated JSON in base64url), so a link carries all of it and any tab of
 * the app answers it.  The engine (its reader, and Pyodide workers once ops
 * need Python) loads the first time a pipeline is asked for.
 *
 * A chunk is computed when the viewer asks for it, at the level it shows;
 * chunks the viewer stops waiting for are dropped.  Ops run on each level's
 * own voxels, so a coarse level is a preview of the fine result.
 *
 * Ops of chunkmirage's `python` kind run the Python they carry: a link from
 * elsewhere runs them only once this browser has allowed that pipeline
 * (`allow`), or when the code is one of the platform's own (`OWN_PYTHON`).
 */
import type { Engine } from "chunkmirage-web/engine";
import { route } from "chunkmirage-web/routes";
import type { Ask, PipelineView } from "chunkmirage-web/types";

export type { PipelineView };

/** Under the app's base: where pipelines are served. */
export const COMPUTED_PATH = "virtual/ngp/";
const ALLOWED_KEY = "ngplatform.computed.allowed";

function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(text: string): Uint8Array {
  const s = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

async function through(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  return new Uint8Array(await new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(stream)).arrayBuffer());
}

/** A pipeline as the path segment it is served under. */
export async function encodePipeline(spec: PipelineView): Promise<string> {
  return base64url(await through(new TextEncoder().encode(JSON.stringify(spec)), new CompressionStream("deflate-raw")));
}

export async function decodePipeline(code: string): Promise<PipelineView> {
  const spec = JSON.parse(new TextDecoder().decode(await through(fromBase64url(code), new DecompressionStream("deflate-raw")))) as PipelineView;
  if (typeof spec?.source !== "string" || !Array.isArray(spec.chunk)) throw new Error("not a pipeline");
  return spec;
}

/**
 * A layer's source as chunkmirage reads it: Neuroglancer's scheme prefix
 * (zarr3://, zarr://, n5://) and its pipeline (`|zarr3:`) taken off; a
 * precomputed:// URL is kept, chunkmirage reads that prefix itself.
 */
export function engineSource(source: string): string {
  const url = source.replace(/\|.*$/, "");
  if (url.startsWith("precomputed://")) return url;
  return url.replace(/^(zarr3?|zarr2|n5|ome-zarr):\/\//, "");
}

/** The pipeline a computed layer's source URL carries, if it is one. */
export function pipelineCode(source: string): string | undefined {
  const at = source.indexOf(`/${COMPUTED_PATH}`);
  if (at === -1) return undefined;
  return source.slice(at + COMPUTED_PATH.length + 1).split("/")[0] || undefined;
}

/** Python of the platform's own, which any link may run: by its text, whatever its #halo. */
const OWN_PYTHON = new Set<string>();
const anyHalo = (code: string) => code.replace(/^#halo[ \d]*$/m, "#halo");

/**
 * Marks code as the platform's own (a filter written as a python op), its
 * #halo line any width: the plugin sets that from the filter's size.
 */
export function ownPython(code: string): string {
  OWN_PYTHON.add(anyHalo(code));
  return code;
}

function pythonOf(spec: PipelineView): string[] {
  return (spec.ops ?? []).filter((o) => o.op === "python").map((o) => String(o.code ?? ""));
}

async function digest(text: string): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(hash.subarray(0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
}

function allowedSet(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(ALLOWED_KEY) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}

/** Whether this browser runs `spec`'s Python: the platform's own, or allowed here. */
export async function mayRun(spec: PipelineView): Promise<boolean> {
  const code = pythonOf(spec).filter((c) => !OWN_PYTHON.has(anyHalo(c)));
  if (code.length === 0) return true;
  const allowed = allowedSet();
  for (const c of code) if (!allowed.has(await digest(c))) return false;
  return true;
}

/** Lets this browser run `spec`'s Python (it was written or read here). */
export async function allow(spec: PipelineView): Promise<void> {
  const allowed = allowedSet();
  for (const c of pythonOf(spec)) allowed.add(await digest(c));
  try {
    localStorage.setItem(ALLOWED_KEY, JSON.stringify([...allowed]));
  } catch {
    // No storage (a private window): allowed for this visit only.
  }
}

/** The engine's own answer to a relayed request (routes.ts's handler), which pipelines are passed on to. */
type Replier = { reply(ask: Ask, port: MessagePort): Promise<void> };

export interface ComputedStatus {
  /** What the engine is doing, as it says (starting, loading Python). */
  status: string;
  computed: number;
  dropped: number;
  failed: number;
  failure: { view: string; message: string } | null;
}

export class ComputedImages {
  private engine?: Promise<Engine>;
  /** Pipelines served, by their code: the engine's view name. */
  private served = new Map<string, Promise<string>>();
  private listeners = new Set<() => void>();
  private message = "";
  private started?: Engine;

  /** `base`: the app's base URL. */
  constructor(readonly base = new URL(".", location.href).href) {}

  /**
   * Answers <app>/virtual/ngp/... from now on (the service worker asks
   * every open tab of the app; src/sw.ts), and tells the worker when this
   * tab is the one in use, which it asks first.
   */
  listen(): void {
    if (!("serviceWorker" in navigator) || !window.isSecureContext) return;
    route(`/${COMPUTED_PATH}`, (ask, port) => void this.reply(ask, port));
    const active = () => {
      if (document.visibilityState === "visible") navigator.serviceWorker.controller?.postMessage({ type: "ngp-active" });
    };
    document.addEventListener("visibilitychange", active);
    window.addEventListener("focus", active);
    navigator.serviceWorker.addEventListener("controllerchange", active);
    active();
  }

  /** The source URL Neuroglancer reads `spec` at. */
  async url(spec: PipelineView): Promise<string> {
    return `zarr3://${this.base}${COMPUTED_PATH}${await encodePipeline(spec)}/`;
  }

  get status(): ComputedStatus {
    const e = this.started;
    return { status: this.message, computed: e?.counts.computed ?? 0, dropped: e?.counts.dropped ?? 0, failed: e?.counts.failed ?? 0, failure: e?.failure ?? null };
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const l of this.listeners) l();
  }

  /** The engine, started the first time a pipeline is asked for. */
  private start(): Promise<Engine> {
    this.engine ??= (async () => {
      const { Engine } = await import("chunkmirage-web/engine");
      const engine = new Engine(() => {
        // Its last word was about loading Python: done, once a chunk is.
        if (engine.counts.computed + engine.counts.failed > 0) this.message = "";
        this.changed();
      });
      await engine.start({}, (s) => {
        this.message = s;
        this.changed();
      });
      this.started = engine;
      this.message = "";
      this.changed();
      return engine;
    })();
    this.engine.catch(() => (this.engine = undefined));
    return this.engine;
  }

  /** The engine's view for a pipeline's code, served the first time. */
  private view(code: string): Promise<string> {
    let served = this.served.get(code);
    if (served === undefined) {
      served = (async () => {
        const spec = await decodePipeline(code);
        if (!(await mayRun(spec))) throw new Refused("This layer runs Python from its link. Add it again from the Filters tab to allow it here.");
        const engine = await this.start();
        const name = `p${await digest(code)}`;
        const source = /^[a-z][a-z0-9+.-]*:\/\//i.test(spec.source) ? spec.source : new URL(spec.source, this.base).href;
        await engine.add({ [name]: { ...spec, source } });
        return name;
      })();
      this.served.set(code, served);
      served.catch(() => this.served.delete(code));
    }
    return served;
  }

  private async reply(ask: Ask, port: MessagePort): Promise<void> {
    const at = ask.path.indexOf(`/${COMPUTED_PATH}`);
    const [code, ...rest] = ask.path.slice(at + COMPUTED_PATH.length + 1).split("/");
    try {
      const view = await this.view(code);
      const engine = await this.start();
      await (engine as unknown as Replier).reply({ ...ask, path: `/virtual/${engine.page}/${view}/${rest.join("/")}` }, port);
    } catch (e) {
      const refused = e instanceof Refused;
      port.postMessage({ status: refused ? 403 : 500, body: (e as Error).message ?? String(e), type: "text/plain" });
    }
  }
}

class Refused extends Error {}

/** Whether the engine still answers relayed requests the way this module passes them on. */
export function engineReplies(engine: object): boolean {
  return typeof (engine as Partial<Replier>).reply === "function";
}
