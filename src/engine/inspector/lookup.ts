/**
 * A segmentation layer's lookup table, in its Render tab: one of the tables
 * that come with the app (or that it fetches from their publishers), or a
 * file from this computer.  Choosing one colours and names the segments
 * (see ../lookup_tables.ts); "None" takes its colours and names off again.
 */
import { inlineLookupSource, parseLookupTable } from "../../core/lookup_table.js";
import { applyLookupTable, catalogueUrl, layerLookupSource, LOOKUP_TABLES, lookupTitle, loadLookupTable } from "../lookup_tables.js";
import type { SegmentationUserLayer } from "../neuroglancer.js";
import { signal } from "./render.js";
import { button, el, type Scope } from "./ui.js";

/** File types offered when loading a table from this computer. */
const ACCEPT = ".txt,.lut,.ctbl,.label,.csv,.tsv,.xml,.json";

export function lookupTableControl(scope: Scope, layer: SegmentationUserLayer): HTMLElement {
  const select = el("select", { class: "ins-select", "aria-label": "Lookup table" }) as HTMLSelectElement;
  const status = el("p", { class: "ins-note ins-lut-status" });
  const fileInput = el("input", { type: "file", accept: ACCEPT, hidden: true }) as HTMLInputElement;
  const fromFile = button("File…", () => fileInput.click(), "Load a lookup table from this computer (FreeSurfer colour table, ITK-SNAP labels, FSL atlas XML, Allen structure graph JSON)");
  let busy = false;
  /** The table the status describes (null: none yet). */
  let described: string | undefined | null = null;

  const groups = [...new Set(LOOKUP_TABLES.map((t) => t.group))];
  const render = () => {
    const current = layerLookupSource(layer);
    const known = LOOKUP_TABLES.some((t) => catalogueUrl(t) === current);
    select.replaceChildren(
      el("option", { value: "" }, "None"),
      ...(current !== undefined && !known ? [el("option", { value: current }, lookupTitle(current))] : []),
      ...groups.map((g) =>
        el(
          "optgroup",
          { label: g },
          ...LOOKUP_TABLES.filter((t) => t.group === g).map((t) => el("option", { value: catalogueUrl(t), title: t.description ?? "" }, t.url !== undefined ? `${t.title} (downloaded)` : t.title)),
        ),
      ),
    );
    select.value = current ?? "";
    if (!busy && described !== current) {
      described = current;
      describe(current);
    }
  };

  /** How many labels the table has, and where it is from. */
  const describe = (url: string | undefined) => {
    if (url === undefined) {
      status.textContent = "";
      return;
    }
    const entry = LOOKUP_TABLES.find((t) => catalogueUrl(t) === url);
    status.textContent = "Reading the table…";
    loadLookupTable(url).then(
      (table) => {
        if (layerLookupSource(layer) !== url) return;
        status.textContent = `${table.entries.length.toLocaleString()} labels${entry ? ` · ${entry.source}` : ""}`;
        status.title = entry ? `${entry.description ?? entry.title}. Licence: ${entry.licence}.` : "";
      },
      (e: Error) => {
        if (layerLookupSource(layer) === url) status.textContent = e.message;
      },
    );
  };

  const apply = async (url: string | undefined, run: () => Promise<unknown>) => {
    busy = true;
    status.textContent = url === undefined ? "" : "Reading the table…";
    let error: string | undefined;
    try {
      await run();
    } catch (e) {
      error = (e as Error).message;
    }
    busy = false;
    described = null;
    render();
    if (error !== undefined) status.textContent = error;
  };

  select.addEventListener("change", () => {
    const url = select.value === "" ? undefined : select.value;
    void apply(url, () => applyLookupTable(layer, url));
  });
  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    fileInput.value = "";
    if (file === undefined) return;
    void apply(file.name, async () => {
      const table = parseLookupTable(await file.text());
      const url = await inlineLookupSource(file.name, table);
      await applyLookupTable(layer, url, table);
    });
  });

  scope.watchSoon([signal(layer.dataSourcesChanged)], render);
  return el("div", { class: "ins-lut" }, el("div", { class: "ins-inline" }, select, fromFile, fileInput), status);
}
