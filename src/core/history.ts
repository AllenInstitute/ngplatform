/**
 * Undo and redo over whole-state snapshots, kept as a tree.
 *
 * The shell records the serialised `{ng, app}` state after each pause in
 * editing (a drag or a slider move records once, when it settles).  Each
 * recorded state is a node; its parent is the state it was changed from.
 * A change made after going back starts a new branch beside the old one,
 * so nothing is lost.
 *
 * Undo goes to the parent.  Redo goes to the child last visited (the
 * branch you came back from, or the change made last): the rule of Vim's
 * undo tree and Emacs's undo-tree.  Any node can be jumped to; the nodes
 * on the way become the ones redo follows from there.
 *
 * Undo, redo and jumps hand back a snapshot to restore; the state that
 * restoring it produces is adopted as that node's state rather than
 * recorded as a new edit, so Neuroglancer re-serialising a restored state
 * slightly differently does not start a branch.
 *
 * Each node keeps a few words saying what the change was, when it was made,
 * and the scene and datasets it touched, for the history view.
 *
 * Storage: a snapshot is split into its JSON objects, arrays and long
 * strings; any piece of 48 characters or more is kept once in a shared pool
 * and referred to by number (`\0id\0`; JSON text never holds a raw NUL), so
 * the many states that differ in one layer or the position share the rest.
 * At most `limit` nodes are kept (400), and at most `maxBytes` of pooled
 * text: past either, the oldest node that is a leaf off the current path
 * goes first (or the root, when it has one child), never the current path.
 */

/** What a step was: a few words, and the scene and datasets it touched. */
export interface StepInfo {
  label: string;
  /** The scene the change was made in (or that was added, removed, renamed). */
  scene?: string;
  /** The datasets whose layers the change touched, by name. */
  datasets?: string[];
}

interface Node extends StepInfo {
  id: number;
  parent: number | undefined;
  /** In the order they were made. */
  children: number[];
  /** The child redo follows: the one last visited. */
  next: number | undefined;
  /** The snapshot, encoded against the pool. */
  token: string;
  time: number;
}

/** One row of the current path: oldest first. */
export interface HistoryRow {
  id: number;
  label: string;
  time: number;
  /** Done (in the past), the state shown now, or undone (redo would bring it back). */
  state: "done" | "current" | "undone";
}

/** One node of the tree, for the history view. */
export interface HistoryNode extends StepInfo {
  id: number;
  parent: number | undefined;
  children: number[];
  next: number | undefined;
  time: number;
  /**
   * Done (an ancestor of the current node), current, undone (on the path
   * redo would follow), or on another branch.
   */
  state: "done" | "current" | "undone" | "branch";
}

/** The tree as kept in the browser's storage (see `export` and `StateHistory.import`). */
export interface HistoryData {
  version: 1;
  nextId: number;
  current: number | undefined;
  nodes: { id: number; parent?: number; next?: number; label: string; scene?: string; datasets?: string[]; time: number; token: string }[];
  pool: [id: number, body: string][];
}

/** Pieces of a snapshot shorter than this stay inline. */
const CHUNK = 48;
const REF = /\0(\d+)\0/g;
/** Marks a snapshot that is not JSON as JSON.stringify writes it, kept whole. */
const RAW = "\u0001";

interface Chunk {
  body: string;
  refs: number;
}

/** Snapshot text kept once per distinct piece, with reference counts. */
class Pool {
  private byBody = new Map<string, number>();
  private chunks = new Map<number, Chunk>();
  private nextId = 1;
  /** The pooled text's length, in characters. */
  bytes = 0;

  /** Encodes a JSON text (as JSON.stringify writes it); `release` or `hold` the result. */
  encode(text: string): string {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return RAW + text;
    }
    return JSON.stringify(parsed) === text ? this.value(parsed) : RAW + text;
  }

  private value(v: unknown): string {
    let body: string;
    if (Array.isArray(v)) body = `[${v.map((x) => this.value(x)).join(",")}]`;
    else if (typeof v === "object" && v !== null) {
      body = `{${Object.entries(v as Record<string, unknown>)
        .map(([k, x]) => `${JSON.stringify(k)}:${this.value(x)}`)
        .join(",")}}`;
    } else body = JSON.stringify(v);
    return body.length < CHUNK ? body : `\0${this.intern(body)}\0`;
  }

  private intern(body: string): number {
    const found = this.byBody.get(body);
    if (found !== undefined) return found;
    const id = this.nextId++;
    this.byBody.set(body, id);
    this.chunks.set(id, { body, refs: 0 });
    this.bytes += body.length;
    this.hold(body);
    return id;
  }

  /** Counts the pieces a token (or a piece's body) refers to as used once more. */
  hold(token: string): void {
    if (token.startsWith(RAW)) return;
    for (const m of token.matchAll(REF)) this.chunks.get(Number(m[1]))!.refs++;
  }

  /** The opposite of `hold`: pieces no longer used are dropped. */
  release(token: string): void {
    if (token.startsWith(RAW)) return;
    for (const m of token.matchAll(REF)) {
      const id = Number(m[1]);
      const chunk = this.chunks.get(id)!;
      if (--chunk.refs === 0) this.drop(id, chunk);
    }
  }

  /** Drops pieces of a token that nothing holds (an encoding not kept). */
  discard(token: string): void {
    if (token.startsWith(RAW)) return;
    for (const m of token.matchAll(REF)) {
      const id = Number(m[1]);
      const chunk = this.chunks.get(id);
      if (chunk !== undefined && chunk.refs === 0) this.drop(id, chunk);
    }
  }

  private drop(id: number, chunk: Chunk): void {
    this.chunks.delete(id);
    this.byBody.delete(chunk.body);
    this.bytes -= chunk.body.length;
    this.release(chunk.body);
  }

  decode(token: string): string {
    if (token.startsWith(RAW)) return token.slice(1);
    return token.replace(REF, (_, id: string) => this.decode(this.chunks.get(Number(id))!.body));
  }

  get size(): number {
    return this.chunks.size;
  }

  export(): [number, string][] {
    return [...this.chunks].map(([id, c]) => [id, c.body]);
  }

  /** Restores exported pieces; reference counts come from `hold`ing every token after. */
  import(pieces: [number, string][]): void {
    for (const [id, body] of pieces) {
      this.chunks.set(id, { body, refs: 0 });
      this.byBody.set(body, id);
      this.bytes += body.length;
      this.nextId = Math.max(this.nextId, id + 1);
    }
    for (const [, body] of pieces) this.hold(body);
  }
}

export class StateHistory {
  private nodes = new Map<number, Node>();
  private root: number | undefined;
  private currentId: number | undefined;
  private nextId = 1;
  private adopting = false;
  private pool = new Pool();

  constructor(
    private readonly limit = 400,
    private readonly now: () => number = Date.now,
    private readonly maxBytes = 32 * 1024 * 1024,
  ) {}

  private get current(): Node | undefined {
    return this.currentId === undefined ? undefined : this.nodes.get(this.currentId);
  }

  private node(id: number | undefined): Node | undefined {
    return id === undefined ? undefined : this.nodes.get(id);
  }

  private setToken(node: Node, token: string): void {
    if (node.token === token) {
      this.pool.discard(token);
      return;
    }
    this.pool.hold(token);
    this.pool.release(node.token);
    node.token = token;
  }

  private add(parent: Node | undefined, token: string, info: StepInfo): Node {
    const node: Node = { id: this.nextId++, parent: parent?.id, children: [], next: undefined, token, time: this.now(), ...stepInfo(info) };
    this.pool.hold(token);
    this.nodes.set(node.id, node);
    if (parent === undefined) this.root = node.id;
    else {
      parent.children.push(node.id);
      parent.next = node.id;
    }
    this.currentId = node.id;
    return node;
  }

  /** Records a settled state; returns whether it became a new undo step. */
  record(snapshot: string, info: string | StepInfo = "Changed"): boolean {
    const token = this.pool.encode(snapshot);
    const current = this.current;
    if (this.adopting) {
      this.adopting = false;
      if (current !== undefined) this.setToken(current, token);
      else this.add(undefined, token, typeof info === "string" ? { label: info } : info);
      return false;
    }
    if (current !== undefined && token === current.token) {
      this.pool.discard(token);
      return false;
    }
    this.add(current, token, typeof info === "string" ? { label: info } : info);
    this.prune();
    return true;
  }

  /**
   * Replaces the current node's state without making an undo step: for
   * changes not worth undoing on their own, such as which layer is
   * selected.  The node keeps its label and time.
   */
  replaceCurrent(snapshot: string): void {
    if (this.adopting) this.adopting = false;
    const token = this.pool.encode(snapshot);
    const current = this.current;
    if (current === undefined) this.add(undefined, token, { label: "Opened" });
    else {
      this.setToken(current, token);
      this.prune();
    }
  }

  /** The snapshot to restore for undo, or undefined when there is none. */
  undo(): string | undefined {
    return this.move(-1);
  }

  redo(): string | undefined {
    return this.move(1);
  }

  /**
   * Moves `steps` nodes back (negative: towards the root) or forward
   * (positive: along the children last visited), as that many undos or
   * redos; returns the snapshot to restore.
   */
  move(steps: number): string | undefined {
    let node = this.current;
    if (node === undefined || steps === 0) return undefined;
    let moved = 0;
    for (; moved < Math.abs(steps); ++moved) {
      const to = this.node(steps < 0 ? node.parent : node.next);
      if (to === undefined) break;
      node = to;
    }
    if (moved === 0) return undefined;
    return this.arrive(node);
  }

  /** Goes to any node of the tree; returns the snapshot to restore. */
  jump(id: number): string | undefined {
    const node = this.nodes.get(id);
    if (node === undefined || node.id === this.currentId) return undefined;
    // Redo from each of its ancestors now leads here.
    for (let n: Node = node; n.parent !== undefined; ) {
      const parent = this.nodes.get(n.parent)!;
      parent.next = n.id;
      n = parent;
    }
    return this.arrive(node);
  }

  /**
   * Goes to the first change of the branch before (`-1`) or after (`1`) the
   * current one, at the nearest fork above (or at) the current node: the
   * branches of a fork in the order they were made.  Returns the snapshot
   * to restore, or undefined when there is no such branch.
   */
  switchBranch(direction: 1 | -1): string | undefined {
    for (let n = this.current; n !== undefined && n.parent !== undefined; n = this.node(n.parent)) {
      const siblings = this.nodes.get(n.parent)!.children;
      if (siblings.length < 2) continue;
      const to = siblings[siblings.indexOf(n.id) + direction];
      return to === undefined ? undefined : this.jump(to);
    }
    return undefined;
  }

  private arrive(node: Node): string {
    this.currentId = node.id;
    this.adopting = true;
    return this.pool.decode(node.token);
  }

  /** The current node's id. */
  get currentNode(): number | undefined {
    return this.currentId;
  }

  /** The ids from the root to the current node, then along the children redo follows. */
  path(): number[] {
    const back: number[] = [];
    for (let n = this.current; n !== undefined; n = this.node(n.parent)) back.push(n.id);
    back.reverse();
    for (let n = this.node(this.current?.next); n !== undefined; n = this.node(n.next)) back.push(n.id);
    return back;
  }

  /** The current path, oldest first, marked done, current or undone. */
  rows(): HistoryRow[] {
    let seen = false;
    return this.path().map((id) => {
      const n = this.nodes.get(id)!;
      const state = id === this.currentId ? "current" : seen ? "undone" : "done";
      if (id === this.currentId) seen = true;
      return { id, label: n.label, time: n.time, state };
    });
  }

  /** Every node, the root first then each in the order made, with its state. */
  tree(): HistoryNode[] {
    const path = this.path();
    const at = path.indexOf(this.currentId ?? -1);
    const done = new Set(path.slice(0, at));
    const undone = new Set(path.slice(at + 1));
    return [...this.nodes.values()]
      .sort((a, b) => a.id - b.id)
      .map((n) => ({
        id: n.id,
        parent: n.parent,
        children: [...n.children],
        next: n.next,
        time: n.time,
        label: n.label,
        scene: n.scene,
        datasets: n.datasets,
        state: n.id === this.currentId ? "current" : done.has(n.id) ? "done" : undone.has(n.id) ? "undone" : "branch",
      }));
  }

  /**
   * The change undo would take back (the current node, when it has a
   * parent) and the one redo would bring back, with when each was made.
   */
  ends(): { undo?: { label: string; time: number }; redo?: { label: string; time: number } } {
    const step = (n: Node | undefined) => n && { label: n.label, time: n.time };
    const current = this.current;
    return { undo: current?.parent !== undefined ? step(current) : undefined, redo: step(this.node(current?.next)) };
  }

  /** Ends an adoption window that produced no state change (restoring an identical state). */
  settle(): void {
    this.adopting = false;
  }

  /** The next recorded state is the current node's own (a workspace kept in this browser, opened again). */
  adoptNext(): void {
    if (this.current !== undefined) this.adopting = true;
  }

  /** True between an undo, redo or jump and the state it produces being recorded. */
  get isAdopting(): boolean {
    return this.adopting;
  }

  get canUndo(): boolean {
    return this.current?.parent !== undefined;
  }

  get canRedo(): boolean {
    return this.current?.next !== undefined;
  }

  /** Whether the current node is on a branch with siblings above it in that direction. */
  canSwitchBranch(direction: 1 | -1): boolean {
    for (let n = this.current; n !== undefined && n.parent !== undefined; n = this.node(n.parent)) {
      const siblings = this.nodes.get(n.parent)!.children;
      if (siblings.length < 2) continue;
      return siblings[siblings.indexOf(n.id) + direction] !== undefined;
    }
    return false;
  }

  /** The snapshot a node holds. */
  snapshot(id: number): string | undefined {
    const node = this.nodes.get(id);
    return node === undefined ? undefined : this.pool.decode(node.token);
  }

  /** How much is kept: nodes, pooled pieces, and characters stored (pool and tokens). */
  stats(): { nodes: number; pieces: number; stored: number } {
    let tokens = 0;
    for (const n of this.nodes.values()) tokens += n.token.length;
    return { nodes: this.nodes.size, pieces: this.pool.size, stored: this.pool.bytes + tokens };
  }

  private storedBytes(): number {
    return this.stats().stored;
  }

  /**
   * Drops nodes past the limits: the oldest of the leaves off the current
   * path, and the root when it has just one child and is not current.
   */
  private prune(): void {
    while (this.nodes.size > this.limit || (this.nodes.size > 1 && this.storedBytes() > this.maxBytes)) {
      const keep = new Set(this.path());
      let oldest: Node | undefined;
      for (const n of this.nodes.values()) {
        const leaf = n.children.length === 0 && !keep.has(n.id);
        const root = n.id === this.root && n.children.length === 1 && n.id !== this.currentId;
        if ((leaf || root) && (oldest === undefined || n.time < oldest.time || (n.time === oldest.time && n.id < oldest.id))) oldest = n;
      }
      if (oldest === undefined) return;
      this.remove(oldest);
    }
  }

  private remove(node: Node): void {
    if (node.id === this.root) {
      const child = this.nodes.get(node.children[0])!;
      child.parent = undefined;
      this.root = child.id;
    } else {
      const parent = this.nodes.get(node.parent!)!;
      parent.children = parent.children.filter((c) => c !== node.id);
      if (parent.next === node.id) parent.next = parent.children.at(-1);
    }
    this.nodes.delete(node.id);
    this.pool.release(node.token);
  }

  /** The tree as plain data, to keep in the browser. */
  export(): HistoryData {
    return {
      version: 1,
      nextId: this.nextId,
      current: this.currentId,
      nodes: [...this.nodes.values()]
        .sort((a, b) => a.id - b.id)
        .map((n) => ({ id: n.id, parent: n.parent, next: n.next, label: n.label, scene: n.scene, datasets: n.datasets, time: n.time, token: n.token })),
      pool: this.pool.export(),
    };
  }

  /** A tree kept by `export`; undefined when it cannot be read. */
  static import(data: HistoryData, limit?: number, now?: () => number, maxBytes?: number): StateHistory | undefined {
    if (data?.version !== 1 || !Array.isArray(data.nodes) || !Array.isArray(data.pool)) return undefined;
    const h = new StateHistory(limit, now, maxBytes);
    h.pool.import(data.pool);
    for (const n of data.nodes) {
      h.nodes.set(n.id, { id: n.id, parent: n.parent, children: [], next: n.next, token: n.token, time: n.time, ...stepInfo(n) });
    }
    for (const n of h.nodes.values()) {
      h.pool.hold(n.token);
      if (n.parent === undefined) h.root = n.id;
      else h.nodes.get(n.parent)?.children.push(n.id);
    }
    if (data.current === undefined || !h.nodes.has(data.current) || h.root === undefined) return undefined;
    h.currentId = data.current;
    h.nextId = Math.max(data.nextId, ...h.nodes.keys()) + 1;
    return h;
  }
}

function stepInfo(info: StepInfo): StepInfo {
  const out: StepInfo = { label: info.label };
  if (info.scene !== undefined) out.scene = info.scene;
  if (info.datasets !== undefined && info.datasets.length > 0) out.datasets = [...info.datasets];
  return out;
}
