/**
 * Overviews of large images on this computer: their coarser levels made in
 * one pass over the file, in the background (a job, with progress, that
 * can be cancelled), and kept between visits within a budget
 * (src/virtual/images/overview_cache.ts).  Offered when a large image is
 * first viewed; started and cleared from the Datasets row menu; the budget
 * and what each image keeps are in View settings.
 */
import type { DatasetRecord } from "../core/workspace.js";
import type { OverviewStatus } from "../virtual/images/nifti.js";
import { DEFAULT_SETTINGS, listOverviews, type OverviewSettings, readSettings, removeOverviews, writeSettings } from "../virtual/images/overview_cache.js";
import { exportKind } from "../virtual/out/kinds.js";
import { clear, h } from "./dom.js";
import { offer, toast } from "./overlays.js";
import type { Workbench } from "./workbench.js";

/** Images at least this large are offered an overview build when first viewed. */
export const OFFER_BYTES = 2 ** 30;

export const sizeText = (bytes: number): string =>
  bytes >= 2 ** 40 ? `${(bytes / 2 ** 40).toFixed(1)} TB` : bytes >= 2 ** 30 ? `${(bytes / 2 ** 30).toFixed(1)} GB` : bytes >= 2 ** 20 ? `${(bytes / 2 ** 20).toFixed(0)} MB` : `${Math.ceil(bytes / 2 ** 10)} KB`;

const sourceOf = (dataset: DatasetRecord) => (typeof dataset.source === "string" ? dataset.source : String((dataset.source as { url?: string } | undefined)?.url ?? ""));

/** The URL of a local image's virtual store (NIfTI, MGH, NumPy, TIFF), for its overview; undefined for anything else. */
export function overviewUrl(wb: Workbench, dataset: DatasetRecord): string | undefined {
  const url = sourceOf(dataset).replace(/^[a-z0-9+]+:\/\/(?=https?:)/, "");
  const at = wb.localData.parse(url);
  const name = at?.path.replace(/\/$/, "").split("/").pop();
  return name !== undefined && exportKind(name) === "image" ? url.replace(/\/$/, "") : undefined;
}

const status = (wb: Workbench, url: string, what: string) => wb.localData.send(url, { overview: what }) as Promise<OverviewStatus>;

/** Builds an image's overview as a job, its progress polled from the store. */
export async function buildOverview(wb: Workbench, url: string, name: string): Promise<void> {
  try {
    let s = await status(wb, url, "build");
    const result = await wb.jobs.run(`Overview of ${name}`, async (control) => {
      let asked = false;
      while (s.state === "building") {
        control.progress(s.total > 0 ? s.done / s.total : 0, `Reading ${sizeText(s.fileBytes)} once; ${sizeText(s.cached.bytes)} kept of at most ${sizeText(s.budget)}`);
        await new Promise((resolve) => setTimeout(resolve, 500));
        if (control.cancelled && !asked) {
          asked = true;
          await status(wb, url, "cancel");
        }
        s = await status(wb, url, "status");
      }
      if (s.state === "failed") throw new Error(s.message ?? "the build failed");
      return s;
    });
    if (result.state === "done") toast(`Overview of ${name} built: ${sizeText(result.cached.bytes)} kept for later visits.`);
  } catch (e) {
    toast(`Overview of ${name}: ${(e as Error).message}`, "error");
  }
}

export async function clearOverview(wb: Workbench, url: string, name: string): Promise<void> {
  try {
    const before = await status(wb, url, "status");
    await status(wb, url, "clear");
    toast(`Cleared the overview of ${name} (${sizeText(before.cached.bytes)}).`);
  } catch (e) {
    toast(`Could not clear the overview of ${name}: ${(e as Error).message}`, "error");
  }
}

/** Offers to build the overview of a large image when the viewer first opens it (once a visit). */
export function offerOverviews(wb: Workbench): void {
  wb.localData.onVirtualOpen(({ url, file }) => {
    if (exportKind(file.name) !== "image" || file.size < OFFER_BYTES) return;
    void (async () => {
      const s = await status(wb, url, "status").catch(() => undefined);
      if (s === undefined || s.noCache || s.built || s.state === "building" || s.kept.whole.length === 0) return;
      // The budget, or all the computed levels when they take less.
      const kept = Math.min(s.budget, s.levels.reduce((n, l) => n + (l.from === "computed" ? l.bytes : 0), 0));
      offer(`Build the overview of this ${sizeText(file.size)} image in the background? The file is read once; at most ${sizeText(kept)} is kept for later visits.`, [
        { label: "Not now" },
        { label: "Build", primary: true, run: () => void buildOverview(wb, url, file.name) },
      ]);
    })();
  });
}

/** The overview cache's settings and what each image keeps, for View settings. */
export function renderOverviewSettings(host: HTMLElement, wb: Workbench): void {
  const list = h("div", { class: "overview-list" });
  const total = h("span", { class: "note" });
  const number = (value: number, step: number, min: number, max: number, label: string) => {
    const input = h("input", { type: "number", value: String(value), step: String(step), min: String(min), max: String(max), "aria-label": label }) as HTMLInputElement;
    return input;
  };
  let settings: OverviewSettings = DEFAULT_SETTINGS;
  const percent = number(settings.percent, 0.5, 0, 100, "Share of each image");
  const maxGB = number(settings.maxGB, 0.5, 0, 1000, "At most, per image (GB)");
  const totalGB = number(settings.totalGB, 1, 0, 10000, "At most, all images (GB)");
  const save = async () => {
    const read = (i: HTMLInputElement, d: number) => (Number.isFinite(Number(i.value)) && Number(i.value) >= 0 ? Number(i.value) : d);
    settings = { percent: read(percent, settings.percent), maxGB: read(maxGB, settings.maxGB), totalGB: read(totalGB, settings.totalGB) };
    await writeSettings(settings).catch((e) => toast((e as Error).message, "error"));
    // Images open now take the new budget at once.
    for (const d of wb.store.sceneDatasets()) {
      const url = overviewUrl(wb, d.dataset);
      if (url !== undefined) await status(wb, url, "settings").catch(() => {});
    }
    await refresh();
  };
  for (const input of [percent, maxGB, totalGB]) input.addEventListener("change", () => void save());
  const refresh = async () => {
    const all = await listOverviews();
    const bytes = all.reduce((n, o) => n + o.bytes, 0);
    total.textContent = all.length === 0 ? "Nothing kept." : `${sizeText(bytes)} kept for ${all.length} image${all.length === 1 ? "" : "s"}.`;
    clear(
      list,
      ...all.flatMap((o) => [
        h("span", { class: "name", title: o.lastModified ? `last changed ${new Date(o.lastModified).toLocaleString()}` : "" }, o.name),
        h("span", { class: "num", title: "The file's size" }, o.size ? sizeText(o.size) : ""),
        h("span", { class: "num", title: o.built ? "Built: every level it keeps" : "Kept as viewed" }, `${sizeText(o.bytes)}${o.built ? " ✓" : ""}`),
        h("button", { class: "btn outline small", type: "button", onclick: () => void clearOne(o.dir, o.name, o.size, o.lastModified) }, "Clear"),
      ]),
    );
  };
  /** An image open now is cleared through its store (which forgets what it kept); others by removing their folder. */
  const clearOne = async (dir: string, name: string, size: number, lastModified: number, again = true) => {
    let open = false;
    for (const d of wb.store.sceneDatasets()) {
      const url = overviewUrl(wb, d.dataset);
      if (url === undefined) continue;
      const found = await wb.localData.sourceFile(url).catch(() => undefined);
      if (found?.file.name === name && found.file.size === size && found.file.lastModified === lastModified) {
        open = (await status(wb, url, "clear").catch(() => undefined)) !== undefined || open;
      }
    }
    if (!open) await removeOverviews(dir);
    if (again) await refresh();
  };
  const clearAll = async () => {
    for (const o of await listOverviews()) await clearOne(o.dir, o.name, o.size, o.lastModified, false);
    await refresh();
  };
  clear(
    host,
    h(
      "h3",
      {
        class: "section-title",
        title:
          "The coarser levels of a large local image (TIFF, NIfTI, …) are made as they are viewed. The coarsest are kept in this browser for later visits, within this budget; finer levels are made again from the file. Images under 64 MB keep nothing.",
      },
      "Overviews of local images",
    ),
    h(
      "div",
      { class: "overview-settings" },
      h("label", {}, "Per image", percent, "% of its size, at most", maxGB, "GB"),
      h("label", {}, "All images", totalGB, "GB"),
    ),
    list,
    h("div", { class: "row-actions" }, total, h("button", { class: "btn outline small", type: "button", onclick: () => void clearAll() }, "Clear all")),
  );
  void readSettings().then((s) => {
    settings = s;
    percent.value = String(s.percent);
    maxGB.value = String(s.maxGB);
    totalGB.value = String(s.totalGB);
  });
  void refresh();
}
