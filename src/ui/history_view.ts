/**
 * The history view (the ⋯ beside undo and redo, or *History of changes…*):
 * the history tree of src/core/history.ts, newest at the top.
 *
 * It shows the current path (from opening, through the state shown now, to
 * what redo would bring back) in order.  Where other changes were made from
 * a state on it (after going back), a "↳ 3 other changes" row sits just
 * above that state; opening it shows those branches, indented, each in the
 * same way.  Choosing any row goes to that state; the view stays open and
 * follows.  A filter shows only the changes made in one scene, or to one
 * dataset, from every branch.
 *
 * Keys: ↑ ↓ move, Home End go to the ends, Enter or Space chooses, → opens
 * a fold and ← closes it (or goes to the fold a branch row is in), Escape
 * closes the view.
 */
import type { HistoryNode } from "../core/history.js";
import { h } from "./dom.js";
import { closeMenu } from "./overlays.js";

export type ViewRow =
  | { kind: "node"; node: HistoryNode; depth: number }
  /** Other changes made from the state `at`: `count` of them, in `branches` branches. */
  | { kind: "fold"; at: number; depth: number; count: number; branches: number; open: boolean };

export interface ViewFilter {
  scene?: string;
  dataset?: string;
}

/**
 * The rows of the view, newest first: the current path with its folds (the
 * branches off a state open when its id is in `open`), or, with a filter,
 * every matching change from every branch.
 */
export function viewRows(nodes: HistoryNode[], open: ReadonlySet<number>, filter: ViewFilter = {}): ViewRow[] {
  if (filter.scene !== undefined || filter.dataset !== undefined) {
    return nodes
      .filter((n) => (filter.scene === undefined || n.scene === filter.scene) && (filter.dataset === undefined || (n.datasets ?? []).includes(filter.dataset)))
      .sort((a, b) => b.time - a.time || b.id - a.id)
      .map((node) => ({ kind: "node", node, depth: 0 }));
  }
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const size = (n: HistoryNode): number => 1 + n.children.reduce((sum, c) => sum + size(byId.get(c)!), 0);
  const line = (start: HistoryNode, depth: number): ViewRow[] => {
    const chain: HistoryNode[] = [];
    for (let n: HistoryNode | undefined = start; n !== undefined; n = n.next === undefined ? undefined : byId.get(n.next)) chain.push(n);
    const rows: ViewRow[] = [];
    for (let i = chain.length - 1; i >= 0; i--) {
      const n = chain[i];
      const others = n.children.filter((c) => c !== n.next).map((c) => byId.get(c)!);
      if (others.length > 0) {
        const isOpen = open.has(n.id);
        rows.push({ kind: "fold", at: n.id, depth, count: others.reduce((sum, c) => sum + size(c), 0), branches: others.length, open: isOpen });
        if (isOpen) for (const other of [...others].reverse()) rows.push(...line(other, depth + 1));
      }
      rows.push({ kind: "node", node: n, depth });
    }
    return rows;
  };
  const root = nodes.find((n) => n.parent === undefined);
  return root === undefined ? [] : line(root, 0);
}

/** "Scene 2 · SRB 2026a: colour map viridis", with the scene when the history spans more than one. */
export function nodeText(node: HistoryNode, withScene: boolean): { text: string; datasets: string[] } {
  const text = withScene && node.scene !== undefined && node.scene !== "" ? `${node.scene} · ${node.label}` : node.label;
  return { text, datasets: (node.datasets ?? []).filter((d) => !node.label.includes(d)) };
}

function when(time: number): string {
  const date = new Date(time);
  const clock = date.toLocaleTimeString(undefined, { hour12: false });
  return date.toDateString() === new Date().toDateString() ? clock : `${date.toLocaleDateString(undefined, { day: "numeric", month: "short" })} ${clock}`;
}

export interface HistorySource {
  historyTree(): HistoryNode[];
  goToNode(id: number): boolean;
  onChange(listener: () => void): () => void;
}

let closeOpen: (() => void) | undefined;

/** Opens the history view below `anchor`. */
export function showHistoryView(anchor: HTMLElement, source: HistorySource): void {
  closeOpen?.();
  closeMenu();
  const open = new Set<number>();
  let filter: ViewFilter = {};
  let focusKey: string | undefined;

  const select = h("select", { class: "history-filter", "aria-label": "Show the changes of a scene or dataset" }) as HTMLSelectElement;
  const list = h("div", { class: "history-rows", role: "tree", "aria-label": "Changes" });
  const view = h(
    "div",
    { class: "menu history-view", role: "dialog", "aria-label": "History of changes" },
    h("div", { class: "history-head" }, h("span", { class: "history-title" }, "History of changes"), select),
    list,
  );

  const keyOf = (row: ViewRow) => (row.kind === "node" ? `n${row.node.id}` : `f${row.at}`);

  const fillFilter = (nodes: HistoryNode[]) => {
    const scenes = [...new Set(nodes.map((n) => n.scene).filter((s): s is string => s !== undefined && s !== ""))].sort();
    const datasets = [...new Set(nodes.flatMap((n) => n.datasets ?? []))].sort();
    const value = select.value;
    select.replaceChildren(
      h("option", { value: "" }, "All changes"),
      ...(scenes.length > 0 ? [h("optgroup", { label: "Scene" }, ...scenes.map((s) => h("option", { value: `s:${s}` }, s)))] : []),
      ...(datasets.length > 0 ? [h("optgroup", { label: "Dataset" }, ...datasets.map((d) => h("option", { value: `d:${d}` }, d)))] : []),
    );
    select.value = [...select.options].some((o) => o.value === value) ? value : "";
  };

  const render = () => {
    const nodes = source.historyTree();
    fillFilter(nodes);
    const withScene = new Set(nodes.map((n) => n.scene).filter((s) => s !== undefined)).size > 1;
    const rows = viewRows(nodes, open, filter);
    const had = focusKey ?? (document.activeElement instanceof HTMLElement && list.contains(document.activeElement) ? document.activeElement.dataset.key : undefined);
    list.replaceChildren(
      ...rows.map((row) => {
        if (row.kind === "fold") {
          return h(
            "button",
            {
              class: "history-row fold",
              type: "button",
              role: "treeitem",
              "aria-expanded": row.open ? "true" : "false",
              "data-key": keyOf(row),
              style: `--depth: ${row.depth}`,
              title: row.branches === 1 ? "Changes made from the state below after going back to it" : `${row.branches} branches made from the state below after going back to it`,
              onclick: () => toggle(row.at),
            },
            h("span", { class: "history-label" }, `${row.open ? "▾" : "↳"} ${row.count} other change${row.count === 1 ? "" : "s"}`),
          );
        }
        const n = row.node;
        const { text, datasets } = nodeText(n, withScene);
        const details = [n.scene && `Scene: ${n.scene}`, (n.datasets ?? []).length > 0 && `Datasets: ${n.datasets!.join(", ")}`, new Date(n.time).toLocaleString()].filter(Boolean).join("\n");
        const state = { done: "", current: "The state shown now", undone: "Undone: redo brings it back", branch: "On another branch" }[n.state];
        return h(
          "button",
          {
            class: `history-row node ${n.state}`,
            type: "button",
            role: "treeitem",
            "aria-current": n.state === "current" ? "true" : undefined,
            "data-key": keyOf(row),
            style: `--depth: ${row.depth}`,
            title: [state, details].filter(Boolean).join("\n"),
            onclick: () => {
              focusKey = keyOf(row);
              if (n.state !== "current") source.goToNode(n.id);
            },
          },
          h("span", { class: "history-mark", "aria-hidden": "true" }, n.state === "current" ? "●" : ""),
          h("span", { class: "history-label" }, text, datasets.length > 0 ? h("span", { class: "history-datasets" }, ` · ${datasets.join(", ")}`) : null),
          h("span", { class: "menu-detail" }, when(n.time)),
        );
      }),
    );
    if (rows.length === 0) list.append(h("div", { class: "history-empty" }, filter.scene || filter.dataset ? "No changes there." : "No changes yet."));
    const target = (had !== undefined ? list.querySelector<HTMLElement>(`[data-key="${had}"]`) : null) ?? list.querySelector<HTMLElement>(".history-row.current");
    focusKey = undefined;
    if (target !== null && (document.activeElement === document.body || list.contains(document.activeElement) || document.activeElement === null)) {
      target.focus({ preventScroll: true });
    }
    target?.scrollIntoView({ block: "nearest" });
  };

  const toggle = (at: number) => {
    focusKey = `f${at}`;
    if (open.has(at)) open.delete(at);
    else open.add(at);
    render();
  };

  select.addEventListener("change", () => {
    const v = select.value;
    filter = v.startsWith("s:") ? { scene: v.slice(2) } : v.startsWith("d:") ? { dataset: v.slice(2) } : {};
    render();
  });

  list.addEventListener("keydown", (e) => {
    const rows = [...list.querySelectorAll<HTMLElement>(".history-row")];
    const at = rows.indexOf(document.activeElement as HTMLElement);
    const go = (i: number) => rows[Math.max(0, Math.min(rows.length - 1, i))]?.focus();
    const row = rows[at];
    if (e.key === "ArrowDown") go(at + 1);
    else if (e.key === "ArrowUp") go(at - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(rows.length - 1);
    else if (e.key === "ArrowRight" && row?.classList.contains("fold") && row.getAttribute("aria-expanded") === "false") row.click();
    else if (e.key === "ArrowLeft" && row?.classList.contains("fold") && row.getAttribute("aria-expanded") === "true") row.click();
    else if (e.key === "ArrowLeft" && row !== undefined) {
      // To the fold this branch row sits in.
      const depth = Number(row.style.getPropertyValue("--depth"));
      for (let i = at - 1; i >= 0; i--) {
        if (rows[i].classList.contains("fold") && Number(rows[i].style.getPropertyValue("--depth")) === depth - 1) {
          go(i);
          break;
        }
      }
    } else return;
    e.preventDefault();
    e.stopPropagation();
  });

  document.body.append(view);
  render();
  const rect = anchor.getBoundingClientRect();
  view.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - view.offsetWidth - 8))}px`;
  view.style.top = `${Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - view.offsetHeight - 8))}px`;
  (list.querySelector<HTMLElement>(".history-row.current") ?? list.querySelector<HTMLElement>(".history-row"))?.focus({ preventScroll: true });

  const unsubscribe = source.onChange(() => render());
  const dismiss = (e: Event) => {
    if (e instanceof KeyboardEvent ? e.key !== "Escape" : e.target instanceof Node && (view.contains(e.target) || anchor.contains(e.target))) return;
    close();
  };
  const close = () => {
    unsubscribe();
    view.remove();
    document.removeEventListener("mousedown", dismiss, true);
    document.removeEventListener("keydown", dismiss, true);
    closeOpen = undefined;
  };
  closeOpen = close;
  setTimeout(() => {
    document.addEventListener("mousedown", dismiss, true);
    document.addEventListener("keydown", dismiss, true);
  });
}

/** Closes the history view if it is open; returns whether it was. */
export function closeHistoryView(): boolean {
  const was = closeOpen !== undefined;
  closeOpen?.();
  return was;
}
