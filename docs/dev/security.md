# Security: what the app protects, and what it allows

ngplatform is a static web app: GitHub Pages serves its files and
everything runs in the browser. What it holds that matters is the
sign-ins to data servers, the pairing with a runner (which runs jobs and
reads files on a computer), and the workspace. This page says how each is
kept, what the Content Security Policy stops, and the risks left.

## The Content Security Policy

The built page carries a policy as `<meta http-equiv="Content-Security-Policy">`
(GitHub Pages cannot set response headers). It is written in
[`src/platform/csp.ts`](https://github.com/AllenInstitute/ngplatform/blob/main/src/platform/csp.ts),
each directive with the reason for it, and `vite.config.ts` puts it after the
page's charset at build time. The dev server (`npm run dev`) goes without
it: Vite there injects the styles inline and talks to the page over a
socket.

**What it stops.** Script that did not come from a file: an inline
`<script>`, an `onclick="…"` attribute, a `javascript:` link. Text injected
into the page (a layer name, a Markdown guide, an annotation's description)
therefore cannot run. Also `<object>` and `<embed>`, a `<base>` that would
move every relative address, fonts from anywhere but the app, and forms
posting elsewhere.

**What it allows, and why.**

| Directive | Allows | Why |
|---|---|---|
| `script-src` | `'unsafe-eval'` | Neuroglancer builds its annotation readers and its compressed-segmentation encoder with `new Function`; Pyodide and Draco evaluate code they load. |
| | `'wasm-unsafe-eval'` | WebAssembly: Neuroglancer's decoders, Pyodide, laz-perf, GDAL. |
| | `blob:` | Module workers and scripts made in the page. |
| | `https:` | Google sign-in (`accounts.google.com/gsi/client`), Pyodide and GDAL from `cdn.jsdelivr.net`, and tool plugins added from a URL, which may be on any https server. |
| | `http://localhost:*`, `http://127.0.0.1:*` | A plugin served from this computer while it is being written. |
| `style-src` | `'unsafe-inline'` | Nine of the tool plugins add their styles as `<style>` elements (a plugin from a URL may too), Neuroglancer's widgets set style attributes, and the loading screen is an inline `<style>`. A strict `style-src 'self'` gave 70 violations in the style audit. Styles cannot run code. |
| `connect-src` | `https:` | Data from any https server: `gs://` through `storage.googleapis.com`, `s3://`, Zarr, precomputed, the plugins' formats; Google's account check; Pyodide's packages. |
| | `http:` | The runner and the render service on this computer (127.0.0.1 or localhost, a tunnelled port included). From an https page the browser allows http only to this computer; from a page served over http (a local build) it opens http data too. |
| | `ws:`, `wss:`, `data:`, `blob:` | Services that stream, and data made in the page. |
| `img-src`, `media-src` | `https:`, `http:`, `data:`, `blob:` | Thumbnails, figures and guides' images from any server; captures and movies made in the page or by the render service. |
| `worker-src` | `'self'`, `blob:` | Neuroglancer's workers and the plugins' are the app's own files. |
| `frame-src` | `https:`, `blob:` | Google sign-in, a guide's or a plugin's embedded page, previews made in the page. |
| `font-src` | `'self'`, `data:` | IBM Plex is served with the app (`public/fonts`). |

A meta policy cannot set `frame-ancestors` (who may frame the app),
`report-uri` or `sandbox`; a host that can set headers should add
`frame-ancestors` itself.

**How it was tested.** The style audit (`npm run ui:audit`, every plugin on
and a runner paired) and the smoke test were run against a build with a
listener for `securitypolicyviolation` events and the console's
"Refused to …" messages, plus the Python panel (Pyodide loaded), Settings ›
About, and a reload while offline: 0 violations. With `style-src 'self'`
the same run gave 70, from the plugins' `<style>` elements, which is why
`'unsafe-inline'` stays for styles.

## Sign-ins and pairings

| What | Where | Why there |
|---|---|---|
| Google accounts (emails, the default) | localStorage | So the accounts and the sign-in rules naming them survive a reload. |
| Google access tokens | sessionStorage (this tab) | They are bearer tokens for your buckets: kept only while the tab is open, so a script that reads the browser's storage later finds none. Another tab, or this one reopened, signs in again with one click (Google remembers the consent). A token lasts an hour at most. |
| The Google OAuth client ID | localStorage | Not a secret. |
| A runner's address and pairing token | localStorage (`ngplatform.runner`, `ngplatform.hosts`) | A pairing is meant to outlast the tab, as the runner does: pairing again on every visit would mean copying the token each time. |
| middleauth and ngauth tokens | Neuroglancer's own handling | |

**The risk left with the runner's token.** Anything that runs script on the
app's origin can read localStorage, take the token and ask the runner to
run jobs or serve files under its folders. The runner listens on
127.0.0.1 only, checks the token on every request and answers only the
origins it allows (ngplatform's site, pages on this computer, and any given
with `--allow-origin`), so another site's page cannot use it; the risk is
script on this origin. The policy above keeps injected text from running; a
plugin from a URL is the way left (below). To revoke every pairing, start
the runner with `--new-token`: browsers paired before must pair again.

## Plugins from a URL

A tool plugin added from a URL (Plugins › Add › From a URL) is a JavaScript
module that runs in the page, on the app's origin, with everything the app
can reach: the workspace, the data, the sign-ins and the runners' pairings.
The browser cannot fence it off, and the policy allows it (that is what
`script-src https:` is for). So:

- nothing runs until you agree, after seeing the plugin's manifest and a
  warning that names what it can reach;
- only https addresses are taken (or http on this computer);
- the address and your consent are remembered, and it loads on later visits
  until you remove it in Plugins.

Add plugins only from people you trust, as you would install a browser
extension.

## The debugging objects

Neuroglancer's own page puts `window.viewer` on the page for the console.
The app's `window.viewer`, `window.engine` and `window.workbench` give a
script the whole app at once, so a production build puts them there only:

- from the dev server;
- with `?debug` in the address (`…/index.html?debug#…`);
- in a browser driven by automation (`navigator.webdriver`), as the smoke
  test, the style audit and the figure scripts are: they reach the app
  through them.

([`src/platform/debug.ts`](https://github.com/AllenInstitute/ngplatform/blob/main/src/platform/debug.ts).)

## Code from other servers

- **Pyodide** (the Python panel) comes from `cdn.jsdelivr.net` at a pinned
  version (0.28.3). Its two scripts are checked with Subresource Integrity
  (`PYODIDE_INTEGRITY` in `src/ui/panels/python.ts`) before they run; the
  WebAssembly and standard library they then load are not, and the
  packages are checked by Pyodide against its lock file. Python needs the
  network the first time the panel opens. Moving to another Pyodide means
  making the hashes again (the comment beside them says how).
- chunkmirage's engine (`vendor/chunkmirage`) loads the same Pyodide in a
  worker, and GDAL and Draco from jsDelivr, pinned by version but not
  checked by hash.
- **Google sign-in** loads `accounts.google.com/gsi/client`, which Google
  changes without notice, so it cannot carry a hash.
- **Fonts** are served with the app; nothing loads from Google Fonts.

## Offline

The service worker keeps the app's page, its startup code, Neuroglancer's
workers and the fonts when it is installed, and the rest of the build's
files as they are first used, so the app opens offline once it has been
opened online. The page itself comes from the network whenever it can, so a
new build is seen at once. Data, sign-ins and the runner's answers are never
kept by the worker.
