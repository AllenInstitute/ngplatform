/**
 * The Display tab's Vertex colour section (Colour by), for a Zarr Vectors layer of points,
 * lines or meshes (a surface has its own Surface section): colour its
 * vertices by their segments, by a group they belong to (a taxonomy's tier,
 * each group in the store's colour or a palette's, with the groups shown
 * chosen from a list), or by an attribute through a colour map between a
 * low and a high value, what lies outside hidden if asked.  The choices
 * are written as the layer's shader (../colour_shader.ts), so they are
 * saved and shared with the workspace.  An attribute the layer does not
 * show yet (a store with hundreds, a gene panel) is asked for by name in
 * the source (`#attributes=`), which reloads the layer.
 */
import { attributeRange, type ColourByLook, colourLookOf, colourShader, COLOUR_BY_COLORMAPS, MAX_RUNS } from "../colour_shader.js";
import type { SegmentationUserLayer } from "../neuroglancer.js";
import { button, el, note, row, type Scope, section, select, showWhen, type Watch } from "./ui.js";

interface Group {
  name: string;
  attribute: string;
  colorAttribute?: string;
  count: number;
  names?: string[];
}

interface ColourByView {
  attributes: { id: string; name: string; components: number }[];
  available: string[];
  groups: Group[];
  surface: boolean;
  storeUrl: string;
  values(id: string): number[];
}

/** What a Zarr Vectors layer can be coloured by, if it is one (see the plugin's layer.ts). */
export function colourByViewOf(layer: unknown): ColourByView | undefined {
  return (layer as { zarrVectorsColourBy?: () => ColourByView | undefined }).zarrVectorsColourBy?.();
}

/** As many attributes as the layer can show at once (the plugin's MAX_ATTRIBUTES). */
const MAX_SHOWN = 12;
/** Each section's attribute list its own id. */
let lists = 0;
/** Groups listed at once (the rest by searching). */
const LISTED = 300;

/** The section, rebuilt as the layer loads (its attributes come with its data). */
export function colourBySection(scope: Scope, l: SegmentationUserLayer): HTMLElement {
  const host = el("div", { class: "ins-deferred" });
  let inner: Scope | undefined;
  let shownFor = "";
  scope.watchSoon([{ value: undefined, changed: (l as any).layersChanged }], () => {
    const view = colourByViewOf(l);
    const key = view === undefined || view.surface ? "" : `${view.storeUrl}|${view.attributes.map((a) => a.id).join(",")}|${view.groups.length}`;
    if (key === shownFor) return;
    shownFor = key;
    inner?.dispose();
    inner = undefined;
    host.replaceChildren();
    if (key === "") return;
    inner = scope.child();
    host.append(build(inner, l, view!));
  });
  return host;
}

function build(scope: Scope, l: SegmentationUserLayer, view: ColourByView): HTMLElement {
  const ds = l.displayState as any;
  const shader = ds.skeletonRenderingOptions.shader as Watch<string>;
  const look = (): ColourByLook => colourLookOf(shader.value) ?? { by: "segment" };
  const custom = () => colourLookOf(shader.value) === undefined && !/^\s*void main\(\)\s*\{\s*emitDefault\(\);\s*\}\s*$/.test(shader.value);
  const write = (next: ColourByLook) => {
    const text = colourShader(next);
    if (text !== shader.value) shader.value = text;
  };
  const shownIds = () => new Set(view.attributes.map((a) => a.id));
  // Attributes the look needs that the layer does not show: asked for by name in the source (the layer reloads).
  const need = (names: string[], then: ColourByLook) => {
    write(then);
    const missing = names.filter((n) => !shownIds().has(safeId(n)));
    if (missing.length === 0) return;
    const source = (l as any).dataSources?.[0];
    if (source === undefined) return;
    const keep = view.attributes.map((a) => a.name).filter((n) => !names.includes(n));
    const list = [...keep, ...names].slice(-MAX_SHOWN);
    const base = String(source.spec.url).replace(/#.*$/, "");
    source.spec = { ...source.spec, url: `${base}#attributes=${list.map(encodeURIComponent).join(",")}`, setManually: true };
  };
  // An attribute chosen before its values were drawn gets its range once they are (a while after the layer reloads).
  let tries = 0;
  const fillRange = () => {
    const current = look();
    if (scope.disposed || current.by !== "attribute" || current.attribute === undefined || current.range !== undefined) return;
    const values = view.values(current.attribute);
    if (values.length > 0) write({ ...current, ...attributeRange(values) });
    else if (++tries < 60) setTimeout(fillRange, 500);
  };
  fillRange();

  const changed = [shader];
  const modeOf = (k: ColourByLook) => (custom() ? "custom" : k.by === "group" ? `group:${k.group?.tier ?? ""}` : k.by);
  const tierOf = (name: string) => view.groups.find((g) => g.name === name);
  const groupLook = (g: Group, colours?: "stored" | "palette"): ColourByLook => ({
    by: "group",
    group: { tier: g.name, attribute: safeId(g.attribute), ...(g.colorAttribute ? { colorAttribute: safeId(g.colorAttribute) } : {}), colours: colours ?? (g.colorAttribute ? "stored" : "palette") },
  });
  const rows: HTMLElement[] = [];
  rows.push(
    row(
      "Colour by",
      select<string>(
        scope,
        [
          { value: "segment", label: "Segments" },
          ...view.groups.map((g) => ({ value: `group:${g.name}`, label: `Group: ${g.name} (${g.count})` })),
          { value: "attribute", label: "Attribute" },
          ...(custom() ? [{ value: "custom", label: "Custom shader" }] : []),
        ],
        () => modeOf(look()),
        (v) => {
          if (v === "segment") write({ by: "segment" });
          else if (v.startsWith("group:")) {
            const g = tierOf(v.slice(6));
            if (g !== undefined) need([g.attribute, ...(g.colorAttribute ? [g.colorAttribute] : [])], groupLook(g));
          } else if (v === "attribute") {
            const first = view.attributes.find((a) => a.components === 1 && !view.groups.some((g) => g.attribute === a.name || g.colorAttribute === a.name));
            write({ by: "attribute", attribute: first?.id, colormap: "viridis", ...(first ? attributeRange(view.values(first.id)) : {}) });
          }
        },
        changed,
      ),
      "Segments in the layer's colours; a group the vertex belongs to (a tier of the store's taxonomy); or an attribute through a colour map",
    ),
  );

  // ----------------------------------------------------------- by group
  const isGroup = { get value() { return look().by === "group" && !custom(); }, changed: shader.changed };
  const colours = select<string>(
    scope,
    [{ value: "stored", label: "The store's colours" }, { value: "palette", label: "A palette" }],
    () => look().group?.colours ?? "palette",
    (v) => {
      const k = look();
      if (k.group !== undefined) write({ ...k, group: { ...k.group, colours: v as "stored" | "palette" } });
    },
    changed,
  );
  rows.push(showWhen(scope, row("Colours", colours, "Each group in the colour the store gives it, or one from a palette"), isGroup));
  const search = el("input", { class: "text-input", type: "search", placeholder: "Search groups", "aria-label": "Search groups" }) as HTMLInputElement;
  const list = el("div", { class: "ins-group-list" });
  const shownNote = el("div", { class: "ins-faint" });
  const setShown = (shown: number[] | undefined) => {
    const k = look();
    if (k.group !== undefined) write({ ...k, group: { ...k.group, shown } });
  };
  const drawList = () => {
    const k = look();
    const g = k.group ? tierOf(k.group.tier) : undefined;
    list.replaceChildren();
    if (g === undefined) return;
    const shown = k.group?.shown === undefined ? undefined : new Set(k.group.shown);
    const q = search.value.trim().toLowerCase();
    const names = Array.from({ length: g.count }, (_, i) => g.names?.[i] ?? `Group ${i}`);
    const matching = names.map((n, i) => [n, i] as const).filter(([n]) => q === "" || n.toLowerCase().includes(q));
    for (const [name, i] of matching.slice(0, LISTED)) {
      const box = el("input", { type: "checkbox" }) as HTMLInputElement;
      box.checked = shown === undefined || shown.has(i);
      box.addEventListener("change", () => {
        const now = look().group?.shown;
        const set = new Set(now ?? names.map((_, j) => j));
        if (box.checked) set.add(i);
        else set.delete(i);
        setShown(set.size === g.count ? undefined : [...set]);
      });
      list.append(el("label", { class: "ins-check-row" }, box, el("span", { class: "ins-label" }, name)));
    }
    const n = shown === undefined ? g.count : shown.size;
    shownNote.textContent =
      `${n} of ${g.count} shown` +
      (matching.length > LISTED ? `; the first ${LISTED} of ${matching.length} listed (search for others)` : "") +
      (k.group?.shown !== undefined && countRuns(k.group.shown) > MAX_RUNS ? `; too scattered to hide the rest (at most ${MAX_RUNS} runs)` : "");
  };
  search.addEventListener("input", drawList);
  scope.watch(shader, drawList);
  const matchingIndices = () => {
    const g = look().group ? tierOf(look().group!.tier) : undefined;
    if (g === undefined) return [];
    const q = search.value.trim().toLowerCase();
    return Array.from({ length: g.count }, (_, i) => i).filter((i) => q === "" || (g.names?.[i] ?? `Group ${i}`).toLowerCase().includes(q));
  };
  rows.push(
    showWhen(
      scope,
      row(
        "Groups",
        el("div", { class: "stack" },
          search,
          el("div", { class: "row" },
            button("Show these", () => setShown(search.value.trim() === "" ? undefined : matchingIndices()), "Show the groups listed (all, or those the search finds) and hide the rest"),
            button("Add these", () => {
              const now = look().group?.shown;
              if (now === undefined) return;
              setShown([...new Set([...now, ...matchingIndices()])]);
            }, "Show the groups listed as well"),
            button("Hide these", () => {
              const g = look().group ? tierOf(look().group!.tier) : undefined;
              if (g === undefined) return;
              const drop = new Set(matchingIndices());
              const base = look().group?.shown ?? Array.from({ length: g.count }, (_, i) => i);
              setShown(base.filter((i) => !drop.has(i)));
            }, "Hide the groups listed"),
          ),
          list,
          shownNote,
        ),
        "Which groups show: tick them, or search and show, add or hide those found",
      ),
      isGroup,
    ),
  );

  // ----------------------------------------------------------- by attribute
  const isAttribute = { get value() { return look().by === "attribute" && !custom(); }, changed: shader.changed };
  const groupAttributes = new Set(view.groups.flatMap((g) => [g.attribute, g.colorAttribute].filter((x): x is string => x !== undefined)));
  const choices = view.available.filter((n) => !groupAttributes.has(n));
  const attrInput = el("input", { class: "text-input", type: "search", list: `zv-attrs-${++lists}`, placeholder: `Search ${choices.length} attributes`, "aria-label": "Attribute" }) as HTMLInputElement;
  const datalist = el("datalist", { id: attrInput.getAttribute("list")! }, ...choices.map((n) => el("option", { value: n })));
  const nameOf = (id: string | undefined) => view.attributes.find((a) => a.id === id)?.name ?? choices.find((n) => safeId(n) === id) ?? "";
  scope.watch(shader, () => {
    if (attrInput.ownerDocument.activeElement !== attrInput) attrInput.value = nameOf(look().attribute);
  });
  attrInput.addEventListener("change", () => {
    const name = attrInput.value.trim();
    if (!choices.includes(name) && !view.attributes.some((a) => a.name === name)) return;
    const id = safeId(name);
    const k = look();
    tries = 0;
    need([name], { by: "attribute", attribute: id, colormap: k.colormap ?? "viridis", hideOutside: k.hideOutside, ...(shownIds().has(id) ? attributeRange(view.values(id)) : {}) });
    fillRange();
  });
  rows.push(showWhen(scope, row("Attribute", el("div", { class: "stack" }, attrInput, datalist), "Any value the store holds per vertex: type to search (an attribute not shown yet is loaded)"), isAttribute));
  rows.push(
    showWhen(
      scope,
      row(
        "Colour map",
        select<string>(scope, COLOUR_BY_COLORMAPS.map((m) => ({ value: m.id, label: m.label })), () => look().colormap ?? "viridis", (v) => write({ ...look(), colormap: v }), changed),
        "From the low value's colour to the high value's",
      ),
      isAttribute,
    ),
  );
  const hide = el("input", { type: "checkbox" }) as HTMLInputElement;
  hide.addEventListener("change", () => write({ ...look(), hideOutside: hide.checked }));
  scope.watch(shader, () => (hide.checked = look().hideOutside === true));
  rows.push(
    showWhen(
      scope,
      row(
        "Threshold",
        el("div", { class: "row" },
          el("label", { class: "ins-inline" }, hide, "hide outside low to high"),
          button("Fit", () => {
            const k = look();
            if (k.attribute !== undefined) write({ ...k, ...attributeRange(view.values(k.attribute)) });
          }, "Set the sliders' range and the window to the values drawn now"),
        ),
        "Values outside the window: hidden, or drawn in the colour map's end colours",
      ),
      isAttribute,
    ),
  );
  return section("Vertex colour", ...rows, note("Low and high are the shader's controls, below."));
}

function countRuns(indices: number[]): number {
  const s = [...new Set(indices)].sort((a, b) => a - b);
  let n = 0;
  for (let i = 0; i < s.length; ++i) if (i === 0 || s[i] !== s[i - 1] + 1) ++n;
  return n;
}

/** An attribute's shader name, as the plugin makes it (`safeAttributeId`, for names without clashes). */
function safeId(name: string): string {
  let base = name.replace(/[^a-zA-Z0-9_]/g, "_");
  if (!/^[a-z]/.test(base)) base = `a_${base}`;
  return base.replace(/__+/g, "_");
}
