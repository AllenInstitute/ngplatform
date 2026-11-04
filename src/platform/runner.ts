/**
 * The runner on this computer (runner/ in this repository: `python -m
 * ngplatform_runner`): its HTTP API, and the pairing kept in this browser.
 *
 * The runner listens on 127.0.0.1 only and answers requests that carry its
 * pairing token.  The address and token are kept in localStorage, never in
 * the link.  While something watches (the Jobs tab) or a job is running,
 * the job list is fetched every 1.5 s.
 */
import type { RunnerJob } from "../sdk/types.js";

export interface RunnerKind {
  kind: string;
  title: string;
  description: string;
}

export interface RunnerInfo {
  name: string;
  version: string;
  pid: number;
  address: string;
  roots: string[];
  python: string;
  /** zarr-vectors-tools' version where jobs run, or null when it is missing. */
  tools: string | null;
  maxRunning: number;
  kinds: RunnerKind[];
}

export interface RunnerServe {
  id: string;
  path: string;
  name: string;
  /** "store" (a folder), "file" (a NIfTI, as it is) or "virtual" (a file read by a process, served as a store). */
  mode: "store" | "file" | "virtual";
  url: string;
  /** The layer source: `<url>|zarr-vectors:` or `nifti://<url>`. */
  source: string;
  ready: boolean;
  job?: string | null;
  error?: string;
}

export interface RunnerEntry {
  name: string;
  path: string;
  type: "file" | "dir" | "store";
  size?: number;
  modified?: number;
}

export interface RunnerListing {
  path: string;
  parent: string | null;
  entries: RunnerEntry[];
  truncated: boolean;
}

export interface Pairing {
  address: string;
  token: string;
}

export type RunnerConnection = "unpaired" | "connecting" | "connected" | "unreachable" | "refused";

export class RunnerError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])$/;

/**
 * A runner address as typed ("127.0.0.1:8765", "http://localhost:8765/")
 * as `http://host:port`.  Only this computer's addresses are taken: the
 * runner never listens elsewhere.
 */
export function normaliseAddress(text: string): string {
  let value = text.trim();
  if (value === "") throw new RunnerError("Enter the runner's address, such as http://127.0.0.1:8765", 0);
  if (!/^[a-z]+:\/\//i.test(value)) value = `http://${value}`;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RunnerError(`${text} is not an address`, 0);
  }
  if (url.protocol !== "http:") throw new RunnerError("The runner's address starts with http://", 0);
  if (!LOOPBACK.test(url.hostname)) throw new RunnerError("The runner runs on this computer: its address is http://127.0.0.1:<port> or http://localhost:<port>", 0);
  return `http://${url.host}`;
}

/** The pairing a link's fragment carries (`#runner=<address>&token=<token>`, as the runner prints it), if any. */
export function pairingFromHash(hash: string): Pairing | undefined {
  if (!hash.startsWith("#runner=")) return undefined;
  const params = new URLSearchParams(hash.slice(1));
  const address = params.get("runner");
  const token = params.get("token");
  if (address === null || token === null || token.length < 16) return undefined;
  try {
    return { address: normaliseAddress(address), token };
  } catch {
    return undefined;
  }
}

/** The runner's API, for one address and token. */
export class RunnerClient {
  constructor(
    readonly address: string,
    readonly token: string,
    private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init),
  ) {}

  async request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.address}${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
        cache: "no-store",
      });
    } catch (e) {
      if ((e as Error).name === "AbortError") throw e;
      throw new RunnerError(`The runner at ${this.address} does not answer: is it running? (python -m ngplatform_runner --root <folder>)`, 0);
    }
    const text = await response.text();
    let value: unknown;
    try {
      value = text === "" ? undefined : JSON.parse(text);
    } catch {
      value = undefined;
    }
    if (!response.ok) {
      const message = (value as { error?: string } | undefined)?.error ?? `${response.status} ${response.statusText}`;
      throw new RunnerError(response.status === 401 ? "The runner refused the pairing token: pair again with the token it prints" : message, response.status);
    }
    return value as T;
  }

  status(signal?: AbortSignal): Promise<RunnerInfo> {
    return this.request("GET", "/status", undefined, signal);
  }
  async jobs(signal?: AbortSignal): Promise<RunnerJob[]> {
    return (await this.request<{ jobs: RunnerJob[] }>("GET", "/jobs", undefined, signal)).jobs;
  }
  job(id: string): Promise<RunnerJob> {
    return this.request("GET", `/jobs/${encodeURIComponent(id)}`);
  }
  start(kind: string, args: Record<string, unknown>): Promise<RunnerJob> {
    return this.request("POST", "/jobs", { kind, args });
  }
  cancel(id: string): Promise<RunnerJob> {
    return this.request("POST", `/jobs/${encodeURIComponent(id)}/cancel`);
  }
  async forget(id: string): Promise<void> {
    await this.request("DELETE", `/jobs/${encodeURIComponent(id)}`);
  }
  log(id: string, tail = 32768): Promise<{ text: string; size: number; truncated: boolean }> {
    return this.request("GET", `/jobs/${encodeURIComponent(id)}/log?tail=${tail}`);
  }
  files(path = ""): Promise<RunnerListing> {
    return this.request("GET", `/files?path=${encodeURIComponent(path)}`);
  }
  find(name: string): Promise<{ matches: { path: string; type: string; size: number }[]; complete: boolean }> {
    return this.request("GET", `/find?name=${encodeURIComponent(name)}`);
  }
  serve(path: string): Promise<RunnerServe> {
    return this.request("POST", "/serve", { path });
  }
  async serves(): Promise<RunnerServe[]> {
    return (await this.request<{ serves: RunnerServe[] }>("GET", "/serve")).serves;
  }
  async stopServing(id: string): Promise<void> {
    await this.request("DELETE", `/serve/${encodeURIComponent(id)}`);
  }
  async resolve(url: string): Promise<string | undefined> {
    return (await this.request<{ path: string | null }>("GET", `/resolve?url=${encodeURIComponent(url)}`)).path ?? undefined;
  }
}

const STORAGE_KEY = "ngplatform.runner";
const ACTIVE: RunnerJob["state"][] = ["queued", "running"];

export function isActive(job: RunnerJob): boolean {
  return ACTIVE.includes(job.state);
}

/** The pairing with this computer's runner, and its jobs as last fetched. */
export class RunnerService {
  private pairingValue: Pairing | undefined;
  private clientValue: RunnerClient | undefined;
  private state: RunnerConnection = "unpaired";
  private errorValue: string | undefined;
  private infoValue: RunnerInfo | undefined;
  private jobList: RunnerJob[] = [];
  private listeners = new Set<() => void>();
  private watchers = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<void> | undefined;
  /** What the last fetch found, to tell listeners only of changes. */
  private lastSeen = "";

  constructor(
    private readonly storage: Pick<Storage, "getItem" | "setItem" | "removeItem">,
    private readonly fetchImpl?: typeof fetch,
    /** ms between fetches while watched or while a job runs. */
    private readonly interval = 1500,
  ) {
    try {
      const raw = storage.getItem(STORAGE_KEY);
      const saved = raw === null ? undefined : (JSON.parse(raw) as Pairing);
      if (saved !== undefined && typeof saved.address === "string" && typeof saved.token === "string") this.use({ address: normaliseAddress(saved.address), token: saved.token });
    } catch {
      // A pairing that cannot be read is no pairing.
    }
  }

  private use(pairing: Pairing | undefined): void {
    this.pairingValue = pairing;
    this.clientValue = pairing === undefined ? undefined : new RunnerClient(pairing.address, pairing.token, this.fetchImpl);
    this.state = pairing === undefined ? "unpaired" : "connecting";
    this.infoValue = undefined;
    this.errorValue = undefined;
    this.jobList = [];
    // A fetch for the client before answers nothing here; the next refresh starts one for this client.
    this.inFlight = undefined;
  }

  pairing(): Pairing | undefined {
    return this.pairingValue;
  }
  client(): RunnerClient | undefined {
    return this.clientValue;
  }
  connection(): RunnerConnection {
    return this.state;
  }
  error(): string | undefined {
    return this.errorValue;
  }
  info(): RunnerInfo | undefined {
    return this.infoValue;
  }
  jobs(): RunnerJob[] {
    return [...this.jobList];
  }
  available(): boolean {
    return this.state === "connected";
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }

  /** Pairs with the runner at `address`: checks the token first, then keeps both in this browser. */
  async pair(address: string, token: string): Promise<RunnerInfo> {
    const pairing = { address: normaliseAddress(address), token: token.trim() };
    if (pairing.token === "") throw new RunnerError("Enter the token the runner printed", 0);
    const client = new RunnerClient(pairing.address, pairing.token, this.fetchImpl);
    const info = await client.status();
    if (info.name !== "ngplatform-runner") throw new RunnerError(`${pairing.address} is not an ngplatform runner`, 0);
    this.storage.setItem(STORAGE_KEY, JSON.stringify(pairing));
    this.use(pairing);
    this.infoValue = info;
    this.state = "connected";
    this.notify();
    await this.refresh();
    return info;
  }

  unpair(): void {
    this.storage.removeItem(STORAGE_KEY);
    this.use(undefined);
    this.stopTimer();
    this.notify();
  }

  /** Fetches the runner's status (when not yet known) and its jobs. */
  refresh(): Promise<void> {
    this.inFlight ??= this.fetchNow().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async fetchNow(): Promise<void> {
    const client = this.clientValue;
    if (client === undefined) return;
    try {
      if (this.infoValue === undefined || this.state !== "connected") this.infoValue = await client.status();
      const jobs = await client.jobs();
      if (client !== this.clientValue) return;
      this.jobList = jobs;
      this.state = "connected";
      this.errorValue = undefined;
    } catch (e) {
      if (client !== this.clientValue) return;
      this.state = (e as RunnerError).status === 401 || (e as RunnerError).status === 403 ? "refused" : "unreachable";
      this.errorValue = (e as Error).message;
    }
    // Listeners (the Jobs tab redraws) hear of a change, or of a job still
    // running (its elapsed time), not of every poll: a redraw every 1.5 s
    // would drop focus and clicks in the tab.
    const seen = JSON.stringify([this.state, this.errorValue, this.jobList]);
    if (seen !== this.lastSeen || this.jobList.some(isActive)) this.notify();
    this.lastSeen = seen;
    this.schedule();
  }

  private stopTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(): void {
    this.stopTimer();
    if (this.clientValue === undefined) return;
    const busy = this.jobList.some(isActive) || this.waiting > 0;
    if (this.watchers === 0 && !busy) return;
    // An unreachable runner is asked again less often.
    const delay = this.state === "connected" ? this.interval : Math.max(this.interval, 5000);
    this.timer = setTimeout(() => void this.refresh(), delay);
  }

  /** Keeps the job list fresh while the returned function has not been called (the Jobs tab, while shown). */
  watch(): () => void {
    this.watchers++;
    void this.refresh();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.watchers--;
      if (this.watchers === 0 && !this.jobList.some(isActive)) this.stopTimer();
    };
  }

  private need(): RunnerClient {
    if (this.clientValue === undefined) throw new RunnerError("This browser is not paired with a runner: pair it in the Jobs tab, under This computer", 0);
    return this.clientValue;
  }

  async start(kind: string, args: Record<string, unknown>): Promise<RunnerJob> {
    const job = await this.need().start(kind, args);
    this.jobList = [job, ...this.jobList.filter((j) => j.id !== job.id)];
    this.notify();
    void this.refresh();
    return job;
  }

  async cancel(id: string): Promise<void> {
    await this.need().cancel(id);
    await this.refresh();
  }

  /** The files and folders the runner serves to the viewer. */
  serves(): Promise<RunnerServe[]> {
    return this.need().serves();
  }

  /** Stops serving a file: its record goes too, so a restarted runner does not serve it again. */
  async stopServing(serveId: string): Promise<void> {
    await this.need().stopServing(serveId);
    await this.refresh();
  }

  async forget(id: string): Promise<void> {
    await this.need().forget(id);
    this.jobList = this.jobList.filter((j) => j.id !== id);
    this.notify();
  }

  /** Takes every finished job off the list (their outputs stay). */
  async clearFinished(): Promise<void> {
    for (const job of this.jobList.filter((j) => !isActive(j) && j.kind !== "serve")) await this.need().forget(job.id).catch(() => {});
    await this.refresh();
  }

  private waiting = 0;

  /** Resolves with the job once it has finished. */
  wait(id: string, onProgress?: (job: RunnerJob) => void, signal?: AbortSignal): Promise<RunnerJob> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
        return;
      }
      this.waiting++;
      let done = false;
      let off = () => {};
      const onAbort = () => finish(() => reject(signal!.reason ?? new DOMException("Aborted", "AbortError")));
      // Once only: a job's end, an abort, an unpairing or the job gone, whichever comes first.
      const finish = (f: () => void) => {
        if (done) return;
        done = true;
        off();
        signal?.removeEventListener("abort", onAbort);
        this.waiting--;
        f();
      };
      let seen = false;
      const check = () => {
        if (this.connection() === "unpaired") return finish(() => reject(new RunnerError("The runner was unpaired", 0)));
        const job = this.jobList.find((j) => j.id === id);
        if (job === undefined) {
          // Gone from a list that had it (forgotten, or the runner's state cleared).
          if (seen) finish(() => reject(new RunnerError(`The job ${id} is no longer on the runner`, 404)));
          return;
        }
        seen = true;
        onProgress?.(job);
        if (!isActive(job)) finish(() => resolve(job));
      };
      off = this.onChange(check);
      signal?.addEventListener("abort", onAbort);
      check();
      void this.refresh();
    });
  }

  /** Serves a path under the runner's folders; resolves once it can be read (a large file is read first). */
  async serve(path: string, signal?: AbortSignal): Promise<RunnerServe> {
    const client = this.need();
    let served = await client.serve(path);
    if (served.job) void this.refresh();
    const deadline = Date.now() + 6 * 3600_000;
    while (!served.ready && served.error === undefined && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, this.interval));
      if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
      served = (await client.serves()).find((s) => s.id === served.id) ?? { ...served, error: "The runner stopped serving it" };
    }
    if (!served.ready) throw new RunnerError(served.error ?? `${served.name} is not served`, 0);
    return served;
  }

  /** The path on this computer a layer source reads, when this runner serves it. */
  async pathOf(source: string): Promise<string | undefined> {
    const client = this.clientValue;
    if (client === undefined) return undefined;
    const bare = source.replace(/^[a-z+]+:\/\/(?=https?:)/, "").replace(/\|.*$/, "");
    if (!bare.startsWith(`${client.address}/stores/`)) return undefined;
    return client.resolve(bare);
  }
}
