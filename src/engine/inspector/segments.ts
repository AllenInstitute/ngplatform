/**
 * The Segments tab: a segmentation layer's segments, searched with
 * Neuroglancer's query language (ids, a label prefix, /regex, #tag,
 * property ranges, <prop or >prop to sort, |prop to show a column), with
 * tag and property filters built from the results, and a list where each
 * segment can be shown, starred, recoloured and copied.
 */
import {
  changeTagConstraintInSegmentQuery,
  executeSegmentQuery,
  type FilterQuery,
  getBaseObjectColor,
  packColor,
  parseSegmentQuery,
  type PreprocessedSegmentPropertyMap,
  type PropertyHistogram,
  type QueryResult,
  type SegmentationUserLayer,
  unparseSegmentQuery,
  updatePropertyHistograms,
} from "../neuroglancer.js";
import { signal } from "./render.js";
import { button, el, fromHex, type Scope, section, toHex, type Watch } from "./ui.js";

const ROW = 24;

interface Listing {
  /** How many segments the list holds. */
  count: number;
  id(i: number): bigint;
  result: QueryResult | undefined;
  /** The query's parsed form, when it is a filter (not a list of ids). */
  filter: FilterQuery | undefined;
}

export function segmentsTab(scope: Scope, layer: SegmentationUserLayer): HTMLElement[] {
  const ds = layer.displayState as any;
  const host = el("div", { class: "ins-segments" });
  let built: Scope | undefined;
  // Linking the layer to another swaps its group: build again.
  scope.watch(ds.segmentationGroupState as Watch<unknown>, () => {
    built?.dispose();
    built = scope.child();
    host.replaceChildren(...segmentsView(built, layer));
  });
  return [host];
}

function segmentsView(scope: Scope, layer: SegmentationUserLayer): HTMLElement[] {
  const ds = layer.displayState as any;
  const group = ds.segmentationGroupState.value;
  const colours = () => ds.segmentationColorGroupState.value;
  const query = group.segmentQuery as Watch<string>;
  const propertyMap = ds.segmentPropertyMap as Watch<PreprocessedSegmentPropertyMap | undefined>;
  const visible = group.visibleSegments;
  const starred = group.selectedSegments;

  // ------------------------------------------------------------- query box
  const input = el("input", {
    type: "search",
    class: "ins-text ins-query",
    placeholder: "ids, label prefix, /regex, #tag, prop>1, <prop sorts, |prop shows",
    "aria-label": "Segment query",
    spellcheck: "false",
  }) as HTMLInputElement;
  let typing: ReturnType<typeof setTimeout> | undefined;
  input.addEventListener("input", () => {
    clearTimeout(typing);
    typing = setTimeout(() => (query.value = input.value), 120);
  });
  scope.add(() => clearTimeout(typing));
  const errors = el("div", { class: "ins-messages" });
  const status = el("p", { class: "ins-note ins-status" });
  const tags = el("div", { class: "ins-tags" });
  const histograms = el("div", { class: "ins-histograms" });
  const sortSelect = el("select", { class: "ins-select", "aria-label": "Sort by" }) as HTMLSelectElement;
  const header = el("div", { class: "ins-seg-row ins-seg-head" });
  const body = el("div", { class: "ins-seg-body" });
  const viewport = el("div", { class: "ins-seg-list", tabindex: "0" }, el("div", { class: "ins-seg-spacer" }, body));
  const spacer = viewport.firstElementChild as HTMLElement;
  const colourInput = el("input", { type: "color", class: "ins-hidden-colour" }) as HTMLInputElement;
  let recolouring: bigint | undefined;
  colourInput.addEventListener("input", () => {
    if (recolouring === undefined) return;
    colours().segmentStatedColors.set(recolouring, BigInt(packColor(fromHex(colourInput.value) as never)));
  });

  let listing: Listing = { count: 0, id: () => 0n, result: undefined, filter: undefined };
  let columns: { id: string; values: ArrayLike<number> }[] = [];
  const histogramState: PropertyHistogram[] = [];

  const setQuery = (q: FilterQuery) => {
    const db = propertyMap.value;
    const text = unparseSegmentQuery(db, q);
    input.value = text;
    query.value = text;
  };

  // --------------------------------------------------------------- compute
  const compute = () => {
    const db = propertyMap.value;
    if (document.activeElement !== input) input.value = query.value;
    const text = query.value.trim();
    const inline = db?.segmentPropertyMap.inlineProperties;
    let result: QueryResult | undefined;
    if (text === "") {
      // No query: the starred segments.
      const ids = [...starred] as bigint[];
      ids.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      listing = { count: ids.length, id: (i) => ids[i], result: undefined, filter: undefined };
    } else {
      const parsed = parseSegmentQuery(db, text);
      result = executeSegmentQuery(db, parsed);
      const filter = parsed.errors === undefined && parsed.ids === undefined ? (parsed as FilterQuery) : undefined;
      if (result.explicitIds !== undefined) {
        const ids = result.explicitIds;
        listing = { count: ids.length, id: (i) => ids[i], result, filter };
      } else if (result.indices !== undefined && inline !== undefined) {
        const { indices } = result;
        listing = { count: indices.length, id: (i) => inline.ids[indices[i]], result, filter };
      } else listing = { count: 0, id: () => 0n, result, filter };
    }
    errors.replaceChildren(...(result?.errors ?? []).map((e) => el("p", { class: "ins-message sev-2" }, `${e.message} (at ${e.begin + 1})`)));
    errors.hidden = errors.childElementCount === 0;

    // Columns: properties the query shows, sorts or filters by.
    const numeric = db?.numericalProperties ?? [];
    const shown = new Set<string>();
    for (const c of listing.filter?.includeColumns ?? []) shown.add(c);
    for (const s of listing.filter?.sortBy ?? []) shown.add(s.fieldId);
    for (const n of listing.filter?.numericalConstraints ?? []) shown.add(n.fieldId);
    columns = numeric.filter((p) => shown.has(p.id)).map((p) => ({ id: p.id, values: p.values }));

    renderStatus(db);
    renderTags(db);
    renderHistograms(db);
    renderSort(db);
    renderHeader(db);
    renderRows();
  };

  const renderStatus = (db: PreprocessedSegmentPropertyMap | undefined) => {
    const total = db?.segmentPropertyMap.inlineProperties?.ids.length;
    const text = query.value.trim();
    if (text === "") {
      status.replaceChildren(
        `${starred.size.toLocaleString()} starred, ${visible.size.toLocaleString()} shown. `,
        total !== undefined ? button(`List all ${total.toLocaleString()}`, () => {
          input.value = "<id";
          query.value = "<id";
        }, "List every segment, by id") : "",
      );
    } else {
      const r = listing.result;
      status.textContent = r?.errors ? "" : `${listing.count.toLocaleString()}${r !== undefined && r.total >= 0 ? ` of ${r.total.toLocaleString()}` : ""} match.`;
    }
  };

  const renderTags = (db: PreprocessedSegmentPropertyMap | undefined) => {
    const filter = listing.filter;
    const counts = listing.result?.tags;
    if (filter === undefined || counts === undefined || counts.length === 0 || db?.tags === undefined) {
      tags.hidden = true;
      return;
    }
    tags.hidden = false;
    tags.replaceChildren(
      ...counts.map(({ tag, count, desc }) => {
        const included = filter.includeTags.includes(tag);
        const excluded = filter.excludeTags.includes(tag);
        return el(
          "button",
          {
            type: "button",
            class: `ins-tag${included ? " on" : ""}${excluded ? " off" : ""}`,
            title: `${desc ?? tag}. Click to require it, shift-click to exclude it.`,
            onclick: (e: MouseEvent) => {
              const include = !e.shiftKey;
              const value = include ? !included : !excluded;
              setQuery(changeTagConstraintInSegmentQuery(filter, tag, include, value));
            },
          },
          `#${tag}`,
          el("span", { class: "ins-faint" }, ` ${count.toLocaleString()}`),
        );
      }),
    );
  };

  /** Per-property histograms of the matches, with a range to filter by. */
  const renderHistograms = (db: PreprocessedSegmentPropertyMap | undefined) => {
    const filter = listing.filter;
    const numeric = db?.numericalProperties ?? [];
    if (filter === undefined || numeric.length === 0 || listing.result === undefined) {
      histograms.hidden = true;
      return;
    }
    const bounds = numeric.map((p) => {
      const constraint = filter.numericalConstraints.find((c) => c.fieldId === p.id);
      return (constraint?.bounds ?? p.bounds) as [number, number];
    });
    updatePropertyHistograms(db, listing.result, histogramState, bounds as never);
    histograms.hidden = false;
    histograms.replaceChildren(
      ...numeric.map((p, k) => {
        const hist = histogramState[k];
        const constraint = filter.numericalConstraints.find((c) => c.fieldId === p.id);
        const [lo, hi] = (constraint?.bounds ?? p.bounds) as [number, number];
        const setRange = (a: number, b: number) => {
          const others = filter.numericalConstraints.filter((c) => c.fieldId !== p.id);
          const [pl, ph] = p.bounds as [number, number];
          const full = a <= pl && b >= ph;
          setQuery({ ...filter, numericalConstraints: full ? others : [...others, { fieldId: p.id, bounds: [a, b] as never }] });
        };
        const num = (v: number, set: (x: number) => void) => {
          const box = el("input", { type: "number", class: "ins-number", step: "any", value: Number(v.toPrecision(6)) }) as HTMLInputElement;
          box.addEventListener("change", () => {
            const x = Number(box.value);
            if (Number.isFinite(x)) set(x);
          });
          return box;
        };
        return el(
          "div",
          { class: `ins-histogram-row${constraint ? " on" : ""}`, title: p.description },
          el("span", { class: "ins-label" }, p.id),
          histogramSvg(hist?.histogram),
          el("div", { class: "ins-inline" }, num(lo, (x) => setRange(x, hi)), el("span", { class: "ins-faint" }, "to"), num(hi, (x) => setRange(lo, x))),
          constraint ? button("×", () => setRange(-Infinity, Infinity), "Remove this range", "ins-chip-x") : el("span"),
        );
      }),
    );
  };

  const renderSort = (db: PreprocessedSegmentPropertyMap | undefined) => {
    const filter = listing.filter;
    const numeric = db?.numericalProperties ?? [];
    sortSelect.hidden = filter === undefined;
    if (filter === undefined) return;
    const options = [
      { key: "", label: "Not sorted" },
      { key: "<id", label: "Id, ascending" },
      { key: ">id", label: "Id, descending" },
      ...(db?.labels ? [{ key: "<label", label: "Label, A to Z" }, { key: ">label", label: "Label, Z to A" }] : []),
      ...numeric.flatMap((p) => [
        { key: `<${p.id}`, label: `${p.id}, ascending` },
        { key: `>${p.id}`, label: `${p.id}, descending` },
      ]),
    ];
    sortSelect.replaceChildren(...options.map((o) => el("option", { value: o.key }, o.label)));
    const first = filter.sortBy[0];
    sortSelect.value = first ? `${first.order}${first.fieldId}` : "";
    sortSelect.onchange = () => {
      const v = sortSelect.value;
      setQuery({ ...filter, sortBy: v === "" ? [] : [{ fieldId: v.slice(1), order: v[0] as "<" | ">" }] });
    };
  };

  const renderHeader = (db: PreprocessedSegmentPropertyMap | undefined) => {
    header.replaceChildren(
      el("span", { title: "Shown" }, "👁"),
      el("span", { title: "Starred" }, "★"),
      el("span"),
      el("span", {}, "id"),
      el("span", {}, db?.labels ? "label" : ""),
      ...columns.map((c) => el("span", { class: "num" }, c.id)),
    );
    const template = `22px 22px 18px minmax(70px, auto) minmax(60px, 1fr)${columns.map(() => " 72px").join("")}`;
    header.style.gridTemplateColumns = template;
    body.dataset.template = template;
  };

  // ------------------------------------------------------------------ rows
  const renderRows = () => {
    const db = propertyMap.value;
    spacer.style.height = `${listing.count * ROW}px`;
    const first = Math.max(0, Math.floor(viewport.scrollTop / ROW) - 5);
    const last = Math.min(listing.count, Math.ceil((viewport.scrollTop + viewport.clientHeight) / ROW) + 5);
    body.style.transform = `translateY(${first * ROW}px)`;
    const template = body.dataset.template ?? "";
    const colour = new Float32Array(4);
    const rows: HTMLElement[] = [];
    for (let i = first; i < last; ++i) {
      const id = listing.id(i);
      const index = db?.getSegmentInlineIndex(id) ?? -1;
      getBaseObjectColor(ds, id, colour);
      const shown = el("input", { type: "checkbox", class: "ins-check", title: "Show" }) as HTMLInputElement;
      shown.checked = visible.has(id);
      shown.addEventListener("change", () => visible.set(id, shown.checked));
      const isStarred = starred.has(id);
      const star = el("button", { type: "button", class: `ins-star${isStarred ? " on" : ""}`, title: isStarred ? "Unstar" : "Star" }, isStarred ? "★" : "☆");
      star.addEventListener("click", () => starred.set(id, !isStarred));
      const stated = colours().segmentStatedColors.has(id);
      const swatch = el("button", {
        type: "button",
        class: `ins-swatch${stated ? " stated" : ""}`,
        title: stated ? "Its own colour. Click to change, right-click to go back to the hashed colour." : "Click to give it its own colour",
        style: `background:${toHex(colour)}`,
      });
      swatch.addEventListener("click", () => {
        recolouring = id;
        colourInput.value = toHex(colour);
        colourInput.click();
      });
      swatch.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        colours().segmentStatedColors.delete(id);
      });
      const idCell = el("button", { type: "button", class: "ins-id-btn", title: "Copy the id" }, id.toString());
      idCell.addEventListener("click", () => void navigator.clipboard?.writeText(id.toString()));
      const label = index >= 0 ? (db?.getSegmentLabel(id) ?? "") : "";
      const row = el(
        "div",
        { class: `ins-seg-row${shown.checked ? " shown" : ""}`, style: `grid-template-columns:${template}` },
        shown,
        star,
        swatch,
        idCell,
        el("span", { class: "ins-seg-label", title: label }, label),
        ...columns.map((c) => el("span", { class: "num" }, index >= 0 ? fmt(c.values[index]) : "")),
      );
      row.addEventListener("mouseenter", () => ds.segmentSelectionState?.set(id));
      row.addEventListener("mouseleave", () => ds.segmentSelectionState?.set(null));
      rows.push(row);
    }
    body.replaceChildren(...rows);
  };
  viewport.addEventListener("scroll", () => requestAnimationFrame(renderRows));

  // --------------------------------------------------------------- actions
  const listed = (): bigint[] => {
    const out: bigint[] = [];
    for (let i = 0; i < listing.count; ++i) out.push(listing.id(i));
    return out;
  };
  const actions = el(
    "div",
    { class: "ins-actions" },
    button("Show all", () => visible.set(listed(), true), "Show every segment listed"),
    button("Hide all", () => visible.set(listed(), false), "Hide every segment listed"),
    button("Star all", () => starred.set(listed(), true), "Star every segment listed"),
    button("Unstar all", () => starred.set(listed(), false), "Unstar every segment listed"),
    button("Copy ids", () => void navigator.clipboard?.writeText(listed().join(", ")), "Copy the listed ids, comma separated"),
  );

  scope.watchSoon(
    [query, propertyMap, signal(visible.changed), signal(starred.changed), signal(colours().segmentStatedColors.changed), ds.segmentColorHash, ds.segmentDefaultColor],
    compute,
  );
  return [
    section("Search", el("div", { class: "ins-query-row" }, input, sortSelect), errors, status, tags, histograms),
    el("section", { class: "ins-section ins-seg-section" }, actions, header, viewport, colourInput),
  ];
}

function fmt(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  return Number.isInteger(v) ? v.toLocaleString() : Number(v.toPrecision(4)).toString();
}

/** A small bar chart of a histogram's counts. */
function histogramSvg(counts: ArrayLike<number> | undefined): Element {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("class", "ins-hist");
  svg.setAttribute("viewBox", "0 0 100 20");
  svg.setAttribute("preserveAspectRatio", "none");
  if (counts === undefined || counts.length === 0) return svg;
  // Neuroglancer's histograms keep an under- and an overflow bin at the ends.
  const n = counts.length;
  let max = 0;
  for (let i = 0; i < n; ++i) max = Math.max(max, counts[i]);
  if (max === 0) return svg;
  const w = 100 / n;
  for (let i = 0; i < n; ++i) {
    const h = (20 * Math.log1p(counts[i])) / Math.log1p(max);
    const r = document.createElementNS(ns, "rect");
    r.setAttribute("x", String(i * w));
    r.setAttribute("y", String(20 - h));
    r.setAttribute("width", String(Math.max(w - 0.3, 0.2)));
    r.setAttribute("height", String(h));
    svg.append(r);
  }
  return svg;
}
