/**
 * The app's Content Security Policy, written into the built page as a
 * `<meta http-equiv="Content-Security-Policy">` (vite.config.ts): GitHub
 * Pages, like most static hosts, cannot set response headers.  The dev
 * server goes without it, since Vite there injects the styles as inline
 * `<style>` elements.
 *
 * What it stops: script in the page that did not come from a file (an
 * inline `<script>`, an `onclick="…"` attribute, a `javascript:` link), so
 * text injected into the page cannot run; plugins (`<object>`, `<embed>`);
 * a `<base>` that would move every relative address; fonts and styles from
 * anywhere but the app.
 *
 * What it allows, and why (each line below says which feature needs it):
 * the app opens data from any https server, and from the runner on this
 * computer over http; Neuroglancer compiles code at run time; Google
 * sign-in, Pyodide and plugins from a URL load scripts from other servers.
 * A meta policy cannot set `frame-ancestors`, `report-uri` or `sandbox`.
 * docs/dev/security.md has the whole account.
 */

/** Each directive with its sources, and the reason for each allowance beyond the app's own files. */
export const CSP_DIRECTIVES: Record<string, { sources: string[]; why: string }> = {
  "default-src": { sources: ["'self'"], why: "Anything not named below: the app's own files only." },
  "script-src": {
    sources: ["'self'", "'unsafe-eval'", "'wasm-unsafe-eval'", "blob:", "https:", "http://localhost:*", "http://127.0.0.1:*"],
    why:
      "'unsafe-eval': Neuroglancer builds its annotation readers and its compressed-segmentation encoder with new Function, and Pyodide and Draco evaluate code they load. " +
      "'wasm-unsafe-eval': WebAssembly (Neuroglancer's decoders, Pyodide, laz-perf, GDAL). blob: module workers and scripts made in the page. " +
      "https: Google sign-in (accounts.google.com/gsi/client), Pyodide and GDAL from cdn.jsdelivr.net, and tool plugins added from a URL, which may be on any https server; " +
      "http://localhost and 127.0.0.1: a plugin served from this computer while it is written. No inline script.",
  },
  "style-src": {
    sources: ["'self'", "'unsafe-inline'"],
    why:
      "Tool plugins add their styles as <style> elements (nine of the built-in ones do, and a plugin from a URL may), Neuroglancer's widgets set style attributes in markup they build, " +
      "and the page's loading screen is an inline <style>.  Styles cannot run code; the risk left is an injected style that changes how the page looks.",
  },
  "font-src": { sources: ["'self'", "data:"], why: "IBM Plex served with the app (public/fonts); data: for fonts some readers embed." },
  "img-src": {
    sources: ["'self'", "data:", "blob:", "https:", "http:"],
    why: "Thumbnails, figures, icons and the images in Markdown guides from any server; blob: and data: for captures; http: for the runner and render service on this computer.",
  },
  "media-src": { sources: ["'self'", "data:", "blob:", "https:", "http:"], why: "Movies the render service makes (on this computer, over http) and recordings made in the page (blob:)." },
  "connect-src": {
    sources: ["'self'", "data:", "blob:", "https:", "http:", "ws:", "wss:"],
    why:
      "Data from any https server (gs:// through storage.googleapis.com, s3://, Zarr, precomputed, the plugins' formats), Google sign-in's account check, Pyodide's packages. " +
      "http: the runner and the render service on this computer (127.0.0.1 or localhost, a tunnelled port included); from an https page the browser allows http only to this computer, and from a page served over http (a local build) it opens http data too. " +
      "ws: and wss: for services that stream.",
  },
  "worker-src": { sources: ["'self'", "blob:"], why: "Neuroglancer's chunk and computation workers and the plugins' workers are the app's own files; blob: for workers made in the page." },
  "frame-src": {
    sources: ["'self'", "https:", "blob:"],
    why: "Google sign-in (accounts.google.com), a plugin's or a guide's embedded page, and previews of files made in the page (blob:).",
  },
  "child-src": { sources: ["'self'", "https:", "blob:"], why: "As frame-src and worker-src, for browsers that read this one." },
  "object-src": { sources: ["'none'"], why: "No <object> or <embed>." },
  "base-uri": { sources: ["'self'"], why: "No <base> pointing the page's relative addresses elsewhere." },
  "form-action": { sources: ["'self'"], why: "No form posts its fields to another server." },
  "manifest-src": { sources: ["'self'"], why: "The app's own manifest only." },
};

/** The policy as one header value. */
export function contentSecurityPolicy(directives = CSP_DIRECTIVES): string {
  return Object.entries(directives)
    .map(([name, { sources }]) => `${name} ${sources.join(" ")}`)
    .join("; ");
}
