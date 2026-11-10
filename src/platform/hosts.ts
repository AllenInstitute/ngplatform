/**
 * The computers with runners this browser is paired with: This computer
 * (the runner of runner.ts, `ctx.runner`), and others reached through an
 * SSH tunnel (`python -m ngplatform_runner tunnel host` prints a link with
 * `&name=`), each by its name.
 *
 * Each other host is a RunnerService of its own (its jobs, serving,
 * pairing), whose pairing is kept in this browser's list of hosts
 * (`ngplatform.hosts`) instead of `ngplatform.runner`.  A check every 5 s
 * asks each host's runner for its status (its computer, GPUs, services),
 * which marks it up or down; the checks pause while the page is hidden
 * (another tab in front, the window minimised) and start again when it is
 * shown.
 */
import type { Host, HostDetails, HostInfo, HostsApi } from "../sdk/types.js";
import { eitherSignal, SERVICE_TIMEOUT, seconds, timedOut } from "./deadline.js";
import { normaliseAddress, type Pairing, type RunnerInfo, RunnerError, RunnerService } from "./runner.js";

/** The name of the runner on this computer, which `ctx.runner` is. */
export const LOCAL_HOST = "This computer";
const HOSTS_KEY = "ngplatform.hosts";
/** The host chosen in Settings › Compute for work that can run on any (pick() tries it first). */
const PREFERRED_KEY = "ngplatform.hosts.preferred";

export interface SavedHost {
  name: string;
  address: string;
  token: string;
}

type KeyStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

interface HostState {
  available: boolean;
  info?: HostDetails;
  error?: string;
  /** When it was last asked (ms since 1970). */
  checked?: number;
}

/** A name for a host, as typed or as a link gives it. */
export function hostName(text: string): string {
  const name = text.trim().replace(/\s+/g, " ");
  if (name === "") throw new RunnerError("Give the computer a name, such as workstation", 0);
  if (name.length > 64) throw new RunnerError("The name is longer than 64 characters", 0);
  return name;
}

function details(info: RunnerInfo): HostDetails {
  return { hostname: info.hostname ?? "", platform: info.platform ?? "", gpus: info.gpus ?? [], services: info.services ?? {} };
}

const shortGpu = (name: string) => name.replace(/^NVIDIA\s+/i, "");
const gb = (mib: number) => `${Math.round(mib / 1024)} GB`;

/** A host in one line: "workstation (czi001): RTX A6000, 47 GB free — render ready". */
export function hostStatusLine(host: HostInfo): string {
  const head = host.info !== undefined && host.info.hostname !== "" && host.info.hostname !== host.name ? `${host.name} (${host.info.hostname})` : host.name;
  if (!host.available) return `${head}: ${host.error ?? (host.info === undefined ? "connecting…" : "does not answer")}`;
  const info = host.info!;
  const gpus = info.gpus.map((g) => (g.ok ? `${shortGpu(g.name)}${g.memoryFree !== null ? `, ${gb(g.memoryFree)} free` : ""}` : `${shortGpu(g.name)} (${(g.problem ?? "not usable").toLowerCase()})`));
  const services = Object.entries(info.services).map(([name, s]) => `${name} ${s.ready ? "ready" : s.error ? (/not started again/.test(s.error) ? "failed" : "restarting") : "starting"}`);
  return `${head}: ${gpus.length > 0 ? gpus.join("; ") : "no GPU"}${services.length > 0 ? ` — ${services.join(", ")}` : ""}`;
}

/** What the checks need of the page: whether it is hidden, and to hear when that changes. */
export type VisiblePage = Pick<Document, "hidden" | "addEventListener" | "removeEventListener">;

/** Whether a host has a GPU that can be used. */
export const hasGpu = (host: HostInfo) => host.info?.gpus.some((g) => g.ok) ?? false;

export class HostList {
  private saved: SavedHost[] = [];
  private runners = new Map<string, RunnerService>();
  private states = new Map<string, HostState>();
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private lastSeen = "";
  private checking: Promise<void> | undefined;
  /** The page whose being hidden pauses the checks, and what hears of it. */
  private page: VisiblePage | undefined;
  private onVisibility: (() => void) | undefined;

  constructor(
    /** This computer's runner. */
    readonly local: RunnerService,
    private readonly storage: KeyStore,
    private readonly fetchImpl?: typeof fetch,
    /** ms between checks. */
    private readonly interval = 5000,
    /** ms a check waits for an answer. */
    private readonly timeout = 4000,
    /** ms between checks of a host that did not answer (a runner that is not started, a tunnel that is closed). */
    private readonly downInterval = 30000,
    /** ms a host's service may take to start answering a request (a half-open tunnel never does). */
    private readonly serviceTimeout = SERVICE_TIMEOUT,
  ) {
    try {
      const raw = storage.getItem(HOSTS_KEY);
      const list = raw === null ? [] : (JSON.parse(raw) as SavedHost[]);
      for (const host of Array.isArray(list) ? list : []) {
        if (typeof host?.name !== "string" || typeof host.address !== "string" || typeof host.token !== "string") continue;
        const name = hostName(host.name);
        if (name === LOCAL_HOST || this.saved.some((h) => h.name === name)) continue;
        this.saved.push({ name, address: normaliseAddress(host.address), token: host.token });
        this.runners.set(name, this.makeRunner(name));
      }
    } catch {
      // A list that cannot be read is no list.
    }
    local.onChange(() => {
      // This computer's runner answered: no need to wait for its next check.
      if (local.available() && !this.state(LOCAL_HOST).available) void this.check(true);
      this.changed();
    });
  }

  private persist(): void {
    if (this.saved.length === 0) this.storage.removeItem(HOSTS_KEY);
    else this.storage.setItem(HOSTS_KEY, JSON.stringify(this.saved));
  }

  /** A host's runner keeps its pairing in the list of hosts, under its name. */
  private makeRunner(name: string): RunnerService {
    const storage: KeyStore = {
      getItem: () => {
        const host = this.saved.find((h) => h.name === name);
        return host === undefined ? null : JSON.stringify({ address: host.address, token: host.token });
      },
      setItem: (_key, value) => {
        const pairing = JSON.parse(value) as Pairing;
        const host = { name, address: pairing.address, token: pairing.token };
        const at = this.saved.findIndex((h) => h.name === name);
        if (at >= 0) this.saved[at] = host;
        else this.saved.push(host);
        this.persist();
      },
      removeItem: () => {
        this.saved = this.saved.filter((h) => h.name !== name);
        this.runners.delete(name);
        this.states.delete(name);
        this.persist();
        this.changed(true);
      },
    };
    return new RunnerService(storage, this.fetchImpl, undefined, name);
  }

  /** This computer (when paired) first, then the others in the order they were paired. */
  names(): string[] {
    return [...(this.local.pairing() !== undefined ? [LOCAL_HOST] : []), ...this.saved.map((h) => h.name)];
  }

  /** The other hosts' names (not This computer), paired or not. */
  others(): string[] {
    return this.saved.map((h) => h.name);
  }

  runner(name: string): RunnerService | undefined {
    return name === LOCAL_HOST ? this.local : this.runners.get(name);
  }

  /**
   * Pairs with the runner at `address` as the host `name` (This computer's
   * name pairs This computer): checks the token first, then keeps it in
   * this browser.  A host of that name already is paired again.
   */
  async add(name: string, address: string, token: string): Promise<RunnerInfo> {
    const key = hostName(name);
    if (key === LOCAL_HOST) return this.local.pair(address, token);
    const existing = this.runners.get(key);
    const runner = existing ?? this.makeRunner(key);
    const info = await runner.pair(address, token);
    this.runners.set(key, runner);
    this.states.set(key, { available: true, info: details(info), checked: Date.now() });
    this.changed(true);
    return info;
  }

  /** Forgets a host (This computer: unpairs it). */
  remove(name: string): void {
    if (name === LOCAL_HOST) this.local.unpair();
    else this.runners.get(name)?.unpair();
  }

  private state(name: string): HostState {
    return this.states.get(name) ?? { available: false };
  }

  info(name: string): HostInfo | undefined {
    const pairing = this.runner(name)?.pairing();
    if (pairing === undefined) return undefined;
    const state = this.state(name);
    return { name, address: pairing.address, available: state.available, ...(state.info ? { info: state.info } : {}), ...(state.error ? { error: state.error } : {}) };
  }

  list(): HostInfo[] {
    return this.names()
      .map((name) => this.info(name))
      .filter((h): h is HostInfo => h !== undefined);
  }

  get(name: string): Host | undefined {
    if (this.runner(name)?.pairing() === undefined) return undefined;
    const hosts = this;
    return {
      name,
      get address() {
        return hosts.runner(name)?.pairing()?.address ?? "";
      },
      available: () => hosts.info(name)?.available ?? false,
      info: () => hosts.info(name) ?? { name, address: "", available: false, error: "Not paired" },
      fetch: (path, init) => hosts.fetch(name, path, init),
    };
  }

  pick(options: { gpu?: boolean; service?: string } = {}): Host | undefined {
    const matching = this.list().filter((h) => h.available && (!options.gpu || hasGpu(h)) && (options.service === undefined || h.info?.services[options.service]?.ready === true));
    // The chosen host when it has what is asked for; else stable, in the list's order, GPU hosts first.
    const preferred = this.preferred();
    const best = matching.find((h) => h.name === preferred) ?? [...matching.filter(hasGpu), ...matching.filter((h) => !hasGpu(h))][0];
    return best === undefined ? undefined : this.get(best.name);
  }

  /** The host chosen for work that can run on any, or undefined (automatic: a GPU host first). */
  preferred(): string | undefined {
    const name = this.storage.getItem(PREFERRED_KEY);
    return name !== null && this.names().includes(name) ? name : undefined;
  }

  prefer(name: string | undefined): void {
    if (name === undefined || name === "") this.storage.removeItem(PREFERRED_KEY);
    else this.storage.setItem(PREFERRED_KEY, hostName(name));
    this.changed(true);
  }

  /** A request to `<address>/svc/<path>` on a host, with its token. */
  async fetch(name: string, path: string, init: RequestInit = {}): Promise<Response> {
    const client = this.runner(name)?.client();
    if (client === undefined) throw new RunnerError(`${name} is not paired: pair it in Settings → Compute`, 0);
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${client.token}`);
    const fetchImpl = this.fetchImpl ?? ((input: RequestInfo | URL, options?: RequestInit) => fetch(input, options));
    // Given up when the service has not started answering in time; once it
    // has, its answer (a long render, a stream) may take as long as it needs.
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new DOMException("The service did not answer in time", "TimeoutError")), this.serviceTimeout);
    try {
      return await fetchImpl(`${client.address}/svc/${path.replace(/^\/+/, "")}`, {
        cache: "no-store",
        ...init,
        headers,
        signal: eitherSignal(init.signal ?? undefined, deadline.signal),
      });
    } catch (e) {
      if (timedOut(e)) throw new RunnerError(`${name} (${client.address}) did not answer in ${seconds(this.serviceTimeout)}: is the tunnel open and the runner running?`, 0);
      if ((e as Error).name === "AbortError") throw e;
      throw new RunnerError(`${name} (${client.address}) does not answer: is the tunnel open and the runner running?`, 0);
    } finally {
      clearTimeout(timer);
    }
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Tells listeners when what list() says has changed (or always, `force`). */
  private changed(force = false): void {
    const seen = JSON.stringify(this.list());
    if (!force && seen === this.lastSeen) return;
    this.lastSeen = seen;
    for (const listener of [...this.listeners]) listener();
  }

  /**
   * Asks every host's runner for its status once, now; those that did not
   * answer last time only every 30 s, unless `all`.
   */
  check(all = false): Promise<void> {
    this.checking ??= this.checkNow(all).finally(() => {
      this.checking = undefined;
    });
    return this.checking;
  }

  private async checkNow(all: boolean): Promise<void> {
    const now = Date.now();
    await Promise.all(
      this.names().map(async (name) => {
        const client = this.runner(name)?.client();
        if (client === undefined) return;
        const last = this.states.get(name);
        if (!all && last !== undefined && !last.available && now - (last.checked ?? 0) < this.downInterval) return;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeout);
        try {
          const info = await client.status(controller.signal);
          if (this.runner(name)?.client() !== client) return;
          if (info.name !== "ngplatform-runner") this.states.set(name, { available: false, error: `${client.address} is not an ngplatform runner`, checked: now });
          else this.states.set(name, { available: true, info: details(info), checked: now });
        } catch (e) {
          if (this.runner(name)?.client() !== client) return;
          const status = (e as RunnerError).status;
          const error = (e as Error).name === "AbortError" ? "does not answer" : status === 401 ? "refused the pairing token: pair it again" : status === 403 ? (e as Error).message : "does not answer";
          this.states.set(name, { available: false, info: this.states.get(name)?.info, error, checked: now });
        } finally {
          clearTimeout(timer);
        }
      }),
    );
    this.changed();
  }

  /**
   * Checks every 5 s from now on (until stop), while `page` is shown: hidden,
   * the checks pause, and shown again, one is made at once.
   */
  start(page: VisiblePage | undefined = typeof document === "undefined" ? undefined : document): void {
    if (this.running) return;
    this.running = true;
    this.page = page;
    const loop = () => {
      this.timer = undefined;
      if (!this.running || this.page?.hidden === true) return;
      void this.check().finally(() => {
        // One timer, however many loops waited on this check (one before the page was hidden, one after it was shown).
        if (this.running && this.page?.hidden !== true && this.timer === undefined) this.timer = setTimeout(loop, this.interval);
      });
    };
    this.onVisibility = () => {
      if (this.page?.hidden === true) {
        if (this.timer !== undefined) clearTimeout(this.timer);
        this.timer = undefined;
      } else if (this.running && this.timer === undefined) loop();
    };
    page?.addEventListener("visibilitychange", this.onVisibility);
    loop();
  }

  stop(): void {
    this.running = false;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.onVisibility !== undefined) this.page?.removeEventListener("visibilitychange", this.onVisibility);
    this.onVisibility = undefined;
    this.page = undefined;
  }

  /** The SDK's `ctx.hosts`. */
  api(): HostsApi {
    return {
      list: () => this.list(),
      onChanged: (callback) => this.onChange(callback),
      get: (name) => this.get(name),
      pick: (options) => this.pick(options),
    };
  }
}
