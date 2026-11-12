/**
 * Offers of tool plugins that are off, from the data in the active scene
 * (rules: src/platform/plugin_offers.ts; each plugin's: plugins/offers.ts).
 *
 * - The Layers panel lists the plugins that would serve this scene's data,
 *   each a button that turns it on, with "Not now".
 * - A plugin worth a toast is offered once in one: several at once share
 *   one toast.
 * - A workspace holding state of a plugin that is off (a link with track
 *   groups, say) says so, with "Turn on"; the state stays in the workspace
 *   either way.
 */
import type { CatalogueEntry } from "../../plugins/index.js";
import type { OfferScene } from "../../plugins/offers.js";
import {
  listNames,
  loadOfferPrefs,
  offerCandidates,
  type OfferPrefs,
  offersToToast,
  offWithState,
  saveOfferPrefs,
} from "../platform/plugin_offers.js";
import type { Json } from "../core/workspace.js";
import { gcsReadable } from "../sdk/sources.js";
import { offer } from "./overlays.js";
import type { Workbench } from "./workbench.js";

/**
 * Track filtering's regions layer (`<dataset> regions`, one `color`
 * property), which it writes from its groups: not the user's annotations.
 * As Annotations tells it apart (plugins/annotations/annotate.ts, isManaged).
 */
function regionsLayer(spec: Json | undefined): boolean {
  const props = (spec?.annotationProperties as { id?: unknown }[] | undefined) ?? [];
  return / regions$/.test(String(spec?.name ?? "")) && props.length === 1 && props[0].id === "color";
}

export interface OfferItem {
  id: string;
  name: string;
  pitch: string;
  /** The workspace holds this plugin's state. */
  uses: boolean;
}

export class PluginOffers {
  private prefs: OfferPrefs = loadOfferPrefs();
  private applicable: string[] = [];
  private uses: string[] = [];
  /** Plugins the workspace notice named this visit. */
  private noticed = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private readonly json = new Map<string, Promise<unknown>>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;
  private closeToast: (() => void) | undefined;
  private closeNotice: (() => void) | undefined;

  constructor(
    private readonly wb: Workbench,
    private readonly catalogue: CatalogueEntry[],
    private readonly turnOn: (ids: string[]) => Promise<void>,
  ) {}

  start(): void {
    const later = () => this.schedule();
    this.wb.engine.onLayersChanged(later);
    this.wb.store.onChange(later);
    this.schedule();
  }

  /** Looks again soon (layers settle in bursts). */
  schedule(delay = 600): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.evaluate(), delay);
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }

  /** For the Layers panel: the plugins this scene's data or the workspace's state calls for. */
  list(): OfferItem[] {
    const ids = [...new Set([...this.uses, ...this.applicable])];
    return ids
      .map((id) => this.catalogue.find((e) => e.manifest.id === id))
      .filter((e): e is CatalogueEntry => e !== undefined && !this.wb.pluginSwitches.enabled.has(e.manifest.id))
      .map((e) => ({ id: e.manifest.id, name: e.manifest.name, pitch: e.offer?.pitch ?? e.summary, uses: this.uses.includes(e.manifest.id) }));
  }

  get enabled(): boolean {
    return !this.prefs.off;
  }

  /** Settings: offers on or off.  Turning them on again forgets every "Not now". */
  setEnabled(on: boolean): void {
    this.prefs = { ...this.prefs, off: !on, dismissed: on ? [] : this.prefs.dismissed };
    saveOfferPrefs(this.prefs);
    if (!on) this.closeToast?.();
    this.applicable = on ? this.applicable : [];
    this.changed();
    this.schedule(0);
  }

  notNow(ids: string[]): void {
    this.prefs = { ...this.prefs, dismissed: [...new Set([...this.prefs.dismissed, ...ids])] };
    saveOfferPrefs(this.prefs);
    this.applicable = this.applicable.filter((id) => !ids.includes(id));
    this.changed();
  }

  /** Turns a plugin on from an offer. */
  accept(ids: string[]): void {
    void this.turnOn(ids).then(() => this.schedule(0));
  }

  private scene(): OfferScene {
    const { engine, localData } = this.wb;
    return {
      layers: engine
        .layers()
        .filter((l) => !l.archived)
        .map((l) => ({ name: l.name, type: l.type, sources: l.sources, managed: l.type === "annotation" && regionsLayer(engine.layerSpec(l.name)) })),
      hasTimeAxis: (name) => {
        const t = engine.layerTransform(name);
        return t !== undefined && t.input.names.some((n, i) => t.input.units[i] === "s" || n.replace(/['^]$/, "") === "t");
      },
      hasLookupTable: (name) => engine.lookupTable(name) !== undefined,
      json: (url) => {
        let p = this.json.get(url);
        if (p === undefined) {
          p = fetch(gcsReadable(url))
            .then((r) => (r.ok ? r.json() : undefined))
            .catch(() => undefined);
          this.json.set(url, p);
          // Data on this computer may not be served yet: asked again next time. The web's answers are kept.
          if (localData.parse(url) !== undefined) void p.then((value) => value === undefined && this.json.delete(url));
        }
        return p;
      },
      isLocal: (url) => localData.parse(url) !== undefined,
    };
  }

  private async evaluate(): Promise<void> {
    const generation = ++this.generation;
    const { enabled } = this.wb.pluginSwitches;
    const manifests = this.catalogue.map((e) => e.manifest);
    // The workspace's state of plugins that are off.
    const uses = offWithState(manifests, enabled, (key) => this.wb.store.rawSlice(key));
    const candidates = offerCandidates(
      this.catalogue.map((e) => ({ id: e.manifest.id, hasOffer: e.offer !== undefined })),
      enabled,
      this.prefs,
    );
    const scene = this.scene();
    const applicable: string[] = [];
    // Listed only, never toasted, for this data.
    const listOnly = new Set<string>();
    for (const id of candidates) {
      const entry = this.catalogue.find((e) => e.manifest.id === id)!;
      try {
        const applies = await entry.offer!.applies(scene);
        if (applies) applicable.push(id);
        if (applies === "list") listOnly.add(id);
      } catch {
        // An offer that cannot tell offers nothing.
      }
      if (generation !== this.generation) return;
    }
    const before = JSON.stringify([this.uses, this.applicable]);
    this.uses = uses;
    this.applicable = applicable;
    if (JSON.stringify([uses, applicable]) !== before) this.changed();
    this.notice(uses.filter((id) => !this.noticed.has(id)));
    this.toast(offersToToast(applicable, (id) => !listOnly.has(id) && this.catalogue.find((e) => e.manifest.id === id)?.offer?.toast === true, this.prefs, this.noticed));
  }

  private nameOf(id: string): string {
    return this.catalogue.find((e) => e.manifest.id === id)?.manifest.name ?? id;
  }

  /** "This workspace uses Track filtering, which is off": once a visit for each plugin. */
  private notice(ids: string[]): void {
    if (ids.length === 0) return;
    for (const id of ids) this.noticed.add(id);
    const names = listNames(ids.map((id) => this.nameOf(id)));
    const message = `This workspace uses ${names}, which ${ids.length === 1 ? "is" : "are"} off.`;
    this.wb.log.add(`${message} Its state is kept in the workspace.`);
    this.closeNotice?.();
    this.closeNotice = offer(
      message,
      [
        { label: "Not now" },
        { label: "Turn on", primary: true, run: () => this.accept(ids) },
      ],
      60000,
    );
  }

  /** One toast for the offers new here; each is toasted once per browser. */
  private toast(ids: string[]): void {
    if (ids.length === 0) return;
    this.prefs = { ...this.prefs, toasted: [...new Set([...this.prefs.toasted, ...ids])] };
    saveOfferPrefs(this.prefs);
    this.closeToast?.();
    const pitch = (id: string) => this.catalogue.find((e) => e.manifest.id === id)?.offer?.pitch ?? "";
    this.closeToast =
      ids.length === 1
        ? offer(`${this.nameOf(ids[0])}: ${pitch(ids[0])}.`, [
            { label: "Not now", run: () => this.notNow(ids) },
            { label: "Turn on", primary: true, run: () => this.accept(ids) },
          ])
        : offer(`Tools for this data: ${ids.map((id) => `${this.nameOf(id)} (${pitch(id)})`).join("; ")}.`, [
            { label: "Not now", run: () => this.notNow(ids) },
            ...ids.map((id) => ({ label: `Turn on ${this.nameOf(id)}`, primary: true, run: () => this.accept([id]) })),
          ]);
  }
}
