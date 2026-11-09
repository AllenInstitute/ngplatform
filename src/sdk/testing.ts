/**
 * A stand-in document for a plugin's panel tests, which run in Node
 * without a browser: enough of the DOM for `@ngplatform/sdk/dom` and a
 * panel built from it (elements and their attributes, text, listeners with
 * bubbling, focus, `querySelector` by tag, class or id).  No layout and no
 * styles: a test reads what a panel shows and does what a person would.
 *
 *     import { fakeDocument } from "@ngplatform/sdk/testing";
 *     const dom = fakeDocument();          // in beforeEach
 *     dom.restore();                       // in afterEach
 *     dom.type(input, "12");               // focus, a value, change, blur
 *     dom.text(host);                      // what the panel says
 *     dom.find(host, "button", "Add one").click();
 */

type Listener = (e: FakeEvent) => void;

/** An event: its type, its key (keyboard events), and whether it was stopped or prevented. */
export class FakeEvent {
  defaultPrevented = false;
  stopped = false;
  target: FakeNode | undefined;
  constructor(
    readonly type: string,
    readonly bubbles = true,
    readonly key?: string,
  ) {}
  preventDefault(): void {
    this.defaultPrevented = true;
  }
  stopPropagation(): void {
    this.stopped = true;
  }
}

class FakeNode {
  parentNode: FakeElement | null = null;
  readonly listeners = new Map<string, { fn: Listener; capture: boolean }[]>();
  constructor(readonly ownerDocument: FakeDocument) {}
  addEventListener(type: string, fn: Listener, capture: boolean | { capture?: boolean } = false): void {
    const list = this.listeners.get(type) ?? [];
    list.push({ fn, capture: typeof capture === "boolean" ? capture : capture.capture === true });
    this.listeners.set(type, list);
  }
  removeEventListener(type: string, fn: Listener, capture: boolean | { capture?: boolean } = false): void {
    const c = typeof capture === "boolean" ? capture : capture.capture === true;
    const list = this.listeners.get(type) ?? [];
    const i = list.findIndex((l) => l.fn === fn && l.capture === c);
    if (i >= 0) list.splice(i, 1);
  }
  /** Calls the listeners here, then (if it bubbles and was not stopped) on each parent and the document. */
  dispatchEvent(e: FakeEvent): boolean {
    e.target ??= this;
    const path: FakeNode[] = [];
    for (let n: FakeNode | null = this; n !== null; n = n.parentNode) path.push(n);
    // In the document, an event goes on to it and the window; outside it (an element not yet added), not.
    const doc = this.ownerDocument;
    const root = path[path.length - 1];
    if (root === doc.body) path.push(doc);
    if (root === doc.body || root === doc) path.push(doc.defaultView);
    for (const n of [...path].reverse()) {
      for (const l of [...(n.listeners.get(e.type) ?? [])]) if (l.capture) l.fn.call(n, e);
      if (e.stopped) return !e.defaultPrevented;
    }
    for (const n of e.bubbles ? path : [this]) {
      for (const l of [...(n.listeners.get(e.type) ?? [])]) if (!l.capture) l.fn.call(n, e);
      if (e.stopped) break;
    }
    return !e.defaultPrevented;
  }
  get textContent(): string {
    return "";
  }
}

class FakeText extends FakeNode {
  constructor(
    doc: FakeDocument,
    public data: string,
  ) {
    super(doc);
  }
  override get textContent(): string {
    return this.data;
  }
}

/** An element: attributes, children, listeners, and the properties controls have (value, checked, disabled). */
export class FakeElement extends FakeNode {
  readonly tagName: string;
  readonly childNodes: FakeNode[] = [];
  readonly attributes = new Map<string, string>();
  readonly style: Record<string, string> = {};
  value = "";
  checked = false;
  constructor(doc: FakeDocument, tag: string) {
    super(doc);
    this.tagName = tag.toUpperCase();
  }
  get children(): FakeElement[] {
    return this.childNodes.filter((n): n is FakeElement => n instanceof FakeElement);
  }
  get className(): string {
    return this.attributes.get("class") ?? "";
  }
  set className(v: string) {
    this.attributes.set("class", v);
  }
  get id(): string {
    return this.attributes.get("id") ?? "";
  }
  set id(v: string) {
    this.attributes.set("id", v);
  }
  get hidden(): boolean {
    return this.attributes.has("hidden");
  }
  set hidden(v: boolean) {
    if (v) this.attributes.set("hidden", "");
    else this.attributes.delete("hidden");
  }
  get disabled(): boolean {
    return this.attributes.has("disabled");
  }
  set disabled(v: boolean) {
    if (v) this.attributes.set("disabled", "");
    else this.attributes.delete("disabled");
  }
  get open(): boolean {
    return this.attributes.has("open");
  }
  set open(v: boolean) {
    if (v) this.attributes.set("open", "");
    else this.attributes.delete("open");
  }
  setAttribute(k: string, v: string): void {
    this.attributes.set(k, String(v));
  }
  getAttribute(k: string): string | null {
    return this.attributes.get(k) ?? null;
  }
  hasAttribute(k: string): boolean {
    return this.attributes.has(k);
  }
  removeAttribute(k: string): void {
    this.attributes.delete(k);
  }
  append(...nodes: (FakeNode | string)[]): void {
    for (const n of nodes) {
      const node = typeof n === "string" ? new FakeText(this.ownerDocument, n) : n;
      node.parentNode?.removeChild(node);
      node.parentNode = this;
      this.childNodes.push(node);
    }
  }
  replaceChildren(...nodes: (FakeNode | string)[]): void {
    for (const n of this.childNodes) n.parentNode = null;
    this.childNodes.length = 0;
    this.append(...nodes);
  }
  removeChild(node: FakeNode): void {
    const i = this.childNodes.indexOf(node);
    if (i >= 0) this.childNodes.splice(i, 1);
    node.parentNode = null;
  }
  remove(): void {
    this.parentNode?.removeChild(this);
  }
  /** In the document: under its body. */
  get isConnected(): boolean {
    return this.ownerDocument.body.contains(this);
  }
  contains(node: FakeNode | null): boolean {
    for (let n = node; n !== null; n = n.parentNode) if (n === this) return true;
    return false;
  }
  override get textContent(): string {
    return this.childNodes.map((n) => n.textContent).join("");
  }
  set textContent(v: string) {
    this.replaceChildren(...(v === "" ? [] : [v]));
  }
  /** Elements under this one matching a list of simple selectors: `tag`, `.class`, `#id`, `tag.class`, `[attr]`, `[attr=value]`. */
  querySelectorAll(selectors: string): FakeElement[] {
    const tests = selectors.split(",").map((s) => matcher(s.trim()));
    const found: FakeElement[] = [];
    const walk = (e: FakeElement) => {
      for (const c of e.children) {
        if (tests.some((t) => t(c))) found.push(c);
        walk(c);
      }
    };
    walk(this);
    return found;
  }
  querySelector(selectors: string): FakeElement | null {
    return this.querySelectorAll(selectors)[0] ?? null;
  }
  focus(): void {
    const doc = this.ownerDocument;
    if (doc.activeElement === this) return;
    doc.activeElement?.blur();
    doc.activeElement = this;
    this.dispatchEvent(new FakeEvent("focus", false));
  }
  blur(): void {
    const doc = this.ownerDocument;
    if (doc.activeElement !== this) return;
    doc.activeElement = null;
    this.dispatchEvent(new FakeEvent("blur", false));
  }
  click(): void {
    if (this.disabled) return;
    this.dispatchEvent(new FakeEvent("click"));
  }
  getBoundingClientRect(): { left: number; top: number; right: number; bottom: number; width: number; height: number } {
    return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
  }
  get offsetWidth(): number {
    return 0;
  }
}

function matcher(selector: string): (e: FakeElement) => boolean {
  const m = /^([a-zA-Z0-9-]*)((?:[.#][\w-]+)*)((?:\[[^\]]+\])*)$/.exec(selector);
  if (m === null) throw new Error(`fakeDocument: selector not supported: ${selector}`);
  const [, tag, rest, attrs] = m;
  const classes = [...rest.matchAll(/\.([\w-]+)/g)].map((x) => x[1]);
  const ids = [...rest.matchAll(/#([\w-]+)/g)].map((x) => x[1]);
  const wanted = [...attrs.matchAll(/\[([\w-]+)(?:="?([^"\]]*)"?)?\]/g)].map((x) => [x[1], x[2]] as const);
  return (e) =>
    (tag === "" || e.tagName === tag.toUpperCase()) &&
    classes.every((c) => e.className.split(/\s+/).includes(c)) &&
    ids.every((i) => e.id === i) &&
    wanted.every(([k, v]) => e.hasAttribute(k) && (v === undefined || e.getAttribute(k) === v));
}

/** The window: its size, and the first and last stop of an event. */
class FakeWindow extends FakeNode {
  readonly innerWidth = 1440;
  readonly innerHeight = 900;
}

class FakeDocument extends FakeNode {
  activeElement: FakeElement | null = null;
  readonly body: FakeElement;
  readonly defaultView: FakeWindow;
  constructor() {
    super(undefined as unknown as FakeDocument);
    (this as { ownerDocument: FakeDocument }).ownerDocument = this;
    this.body = new FakeElement(this, "body");
    this.defaultView = new FakeWindow(this);
  }
  createElement(tag: string): FakeElement {
    return new FakeElement(this, tag);
  }
  createElementNS(_ns: string, tag: string): FakeElement {
    return new FakeElement(this, tag);
  }
  createTextNode(text: string): FakeText {
    return new FakeText(this, text);
  }
}

/** What `fakeDocument()` gives a test. */
export interface FakeDom {
  readonly document: Document;
  /** A new element in `document.body`, to draw a panel into. */
  host(): HTMLElement;
  /** Fires `type` at `target` (bubbling), with `key` for keyboard events; returns whether it was not prevented. */
  fire(target: Element | Document, type: string, key?: string): boolean;
  /** Types `value` into a field as a person would: focus, the value, `input`, `change`, then blur. */
  type(input: HTMLInputElement | HTMLTextAreaElement, value: string): void;
  /** Ticks or unticks a checkbox (or a switch), firing `change` when that changes it. */
  check(input: HTMLInputElement, checked: boolean): void;
  /** The text an element shows, its runs of white space as one space; hidden elements left out. */
  text(e: Element): string;
  /** The first element under `root` matching `selector` whose text is `text` (a button by its label); throws when there is none. */
  find<E extends HTMLElement = HTMLElement>(root: Element, selector: string, text?: string): E;
  /** Puts back whatever `document` and `window` were before. */
  restore(): void;
}

/**
 * Installs a stand-in `document` (and a `window` with its size) on the
 * global object, for a test; `restore()` puts back what was there.
 */
export function fakeDocument(): FakeDom {
  const g = globalThis as { document?: unknown; window?: unknown };
  const saved = { document: g.document, window: g.window };
  const doc = new FakeDocument();
  g.document = doc;
  g.window = doc.defaultView;
  const as = <T>(x: unknown) => x as T;
  const shown = (e: FakeNode): string => (e instanceof FakeElement ? (e.hidden ? "" : e.childNodes.map(shown).join(" ")) : e.textContent);
  const text = (e: Element) => shown(as<FakeElement>(e)).replace(/\s+/g, " ").trim();
  return {
    document: as<Document>(doc),
    host() {
      const e = doc.createElement("div");
      doc.body.append(e);
      return as<HTMLElement>(e);
    },
    fire(target, type, key) {
      return as<FakeNode>(target).dispatchEvent(new FakeEvent(type, true, key));
    },
    type(input, value) {
      const e = as<FakeElement>(input);
      e.focus();
      e.value = value;
      e.dispatchEvent(new FakeEvent("input"));
      e.dispatchEvent(new FakeEvent("change"));
      e.blur();
    },
    check(input, checked) {
      const e = as<FakeElement>(input);
      if (e.checked === checked || e.disabled) return;
      e.checked = checked;
      e.dispatchEvent(new FakeEvent("input"));
      e.dispatchEvent(new FakeEvent("change"));
    },
    text,
    find<E extends HTMLElement = HTMLElement>(root: Element, selector: string, wanted?: string): E {
      const found = as<FakeElement>(root)
        .querySelectorAll(selector)
        .find((e) => wanted === undefined || text(as<Element>(e)) === wanted);
      if (found === undefined) throw new Error(`no ${selector}${wanted === undefined ? "" : ` showing "${wanted}"`}`);
      return as<E>(found);
    },
    restore() {
      g.document = saved.document;
      g.window = saved.window;
    },
  };
}
