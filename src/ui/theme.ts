/**
 * The theme: dark (the default, as Neuroglancer is), light, or as the
 * system is (Settings › View).  Kept in this browser, not in the workspace
 * or its link.  The page's root carries the theme as `data-theme`; the
 * stylesheet (src/ui/styles.css) has a set of colours for each.  public/theme.js
 * sets it before the page is first drawn, from the same storage, so the
 * page never shows the other theme first; this keeps it after, as the
 * choice or the system's setting changes.
 *
 * The views take the theme's ground: black in the dark, white in the light
 * (shown, never saved: a scene keeps the backgrounds it carries).  Black
 * views in the light theme, off by default, keeps them black there.
 */

export type ThemeChoice = "dark" | "light" | "system";
export type ResolvedTheme = "dark" | "light";

/** Where the choices are kept (public/theme.js reads the first). */
export const THEME_KEY = "ngplatform.theme";
export const BLACK_VIEWS_KEY = "ngplatform.blackViews";

/** The choices, in Settings' order, with their names. */
export const THEME_CHOICES: readonly [ThemeChoice, string][] = [
  ["dark", "Dark"],
  ["light", "Light"],
  ["system", "Match system"],
];

/** What the theme needs of the page; tests fake it. */
export interface ThemeHost {
  storage: Pick<Storage, "getItem" | "setItem"> | undefined;
  root: HTMLElement;
  /** `(prefers-color-scheme: light)`, when the browser can say. */
  systemLight: Pick<MediaQueryList, "matches" | "addEventListener" | "removeEventListener"> | undefined;
}

export class Theme {
  private readonly listeners = new Set<() => void>();
  /** The choices made on this page, for when storage cannot keep them. */
  private readonly page = new Map<string, string>();
  private shown: ResolvedTheme | undefined;
  private readonly onSystem = () => {
    if (this.choice() === "system") this.apply();
  };

  constructor(private readonly host: ThemeHost) {
    host.systemLight?.addEventListener("change", this.onSystem);
    this.apply();
  }

  /** What was chosen (dark when nothing was, or storage is not there). */
  choice(): ThemeChoice {
    const kept = this.read(THEME_KEY);
    return kept === "light" || kept === "system" ? kept : "dark";
  }

  /** The theme shown: the choice, or under Match system the system's. */
  resolved(): ResolvedTheme {
    const choice = this.choice();
    if (choice === "system") return this.host.systemLight?.matches ? "light" : "dark";
    return choice;
  }

  setChoice(choice: ThemeChoice): void {
    this.write(THEME_KEY, choice);
    this.apply(true);
  }

  /** Dark to light and light to dark (the palette's command): a choice of the other, not Match system. */
  toggle(): void {
    this.setChoice(this.resolved() === "dark" ? "light" : "dark");
  }

  /** Whether the views stay black in the light theme (off: they are white there, as the theme). */
  blackViews(): boolean {
    return this.read(BLACK_VIEWS_KEY) === "1";
  }

  setBlackViews(on: boolean): void {
    this.write(BLACK_VIEWS_KEY, on ? "1" : "0");
    this.apply(true);
  }

  /** Whether the views show the light ground now: the light theme, unless Black views in the light theme is on. */
  lightViews(): boolean {
    return this.resolved() === "light" && !this.blackViews();
  }

  /** Calls back when the theme shown or Black views in the light theme changes; returns the undo. */
  onChanged(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.host.systemLight?.removeEventListener("change", this.onSystem);
    this.listeners.clear();
  }

  private apply(force = false): void {
    const theme = this.resolved();
    const root = this.host.root;
    if (root.getAttribute("data-theme") !== theme) root.setAttribute("data-theme", theme);
    // The browser's own parts (scrollbars before the styles load, form controls) in the same scheme.
    root.ownerDocument.querySelector('meta[name="color-scheme"]')?.setAttribute("content", theme);
    if (!force && theme === this.shown) return;
    this.shown = theme;
    for (const listener of [...this.listeners]) listener();
  }

  private read(key: string): string | null {
    if (this.page.has(key)) return this.page.get(key)!;
    try {
      return this.host.storage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  }

  private write(key: string, value: string): void {
    this.page.set(key, value);
    try {
      this.host.storage?.setItem(key, value);
    } catch {
      // No storage: the choice holds for this page only.
    }
  }
}

let shared: Theme | undefined;

/** The page's theme, made on first use. */
export function pageTheme(): Theme {
  if (shared !== undefined) return shared;
  let storage: Storage | undefined;
  try {
    storage = localStorage;
  } catch {
    // Storage blocked: dark, and choices last for this page.
  }
  const systemLight = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: light)") : undefined;
  shared = new Theme({ storage, root: document.documentElement, systemLight });
  return shared;
}
