/**
 * The objects put on `window` for working from the browser's console
 * (`viewer`, `engine`, `workbench`, as Neuroglancer's own page puts
 * `viewer`).  They give a script on the page the whole app at once, so a
 * production build puts them there only when asked:
 *
 * - from the dev server (`npm run dev`), always;
 * - with `?debug` in the address (`…/index.html?debug#…`);
 * - in a browser driven by automation (`navigator.webdriver`: Playwright,
 *   as the smoke test and the style audit run it), which reach the app
 *   through them.
 */

export interface DebugEnvironment {
  /** Served by Vite's dev server. */
  dev: boolean;
  /** The address's query (`location.search`). */
  search: string;
  /** Whether automation drives the browser. */
  webdriver: boolean;
}

/** Whether to put the debugging objects on `window`. */
export function debugGlobalsAllowed(env: DebugEnvironment): boolean {
  return env.dev || env.webdriver || new URLSearchParams(env.search).has("debug");
}

function browserEnvironment(): DebugEnvironment {
  return {
    dev: import.meta.env?.DEV === true,
    search: globalThis.location?.search ?? "",
    webdriver: globalThis.navigator?.webdriver === true,
  };
}

/** Puts `value` on `window` as `name` when allowed (debugGlobalsAllowed); says whether it did. */
export function exposeForDebugging(name: string, value: unknown, env: DebugEnvironment = browserEnvironment()): boolean {
  if (!debugGlobalsAllowed(env)) return false;
  (globalThis as Record<string, unknown>)[name] = value;
  return true;
}
