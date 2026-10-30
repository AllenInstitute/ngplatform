/**
 * Reading and writing workspace state.
 *
 * A workspace is `{ ng, app }`: `ng` is an ordinary Neuroglancer JSON state,
 * the source of truth for everything visual, and `app` holds the platform's
 * own state keyed by plugin id.  Our links carry both after `#!`; any
 * Neuroglancer link, state JSON or remote state URL opens too, and a bare
 * data URL is added as a layer.
 */

export interface WorkspaceState {
  ng: Record<string, unknown>;
  app: Record<string, unknown>;
}

export type ParsedInput =
  | { kind: "state"; state: WorkspaceState }
  | { kind: "remote"; url: string }
  | { kind: "source"; url: string; name: string };

/** Parses Neuroglancer's url-safe JSON variant; injected so tests need no viewer. */
export type FragmentParser = (fragment: string) => unknown;

const SCHEME = /^[a-z][a-z\d+.-]*:\/\//i;
const DATA_SOURCE = /\|[a-z][a-z\d-]*:|^(zarr-vectors|zarr|zarr2|zarr3|precomputed|nifti|n5):\/\//i;

export class InputError extends Error {}

function asWorkspace(value: unknown): WorkspaceState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InputError("The state must be a JSON object.");
  }
  const obj = value as Record<string, unknown>;
  const ng = obj.ng;
  if (typeof ng === "object" && ng !== null && !Array.isArray(ng)) {
    const app = obj.app;
    return {
      ng: ng as Record<string, unknown>,
      app:
        typeof app === "object" && app !== null && !Array.isArray(app)
          ? (app as Record<string, unknown>)
          : {},
    };
  }
  return { ng: obj, app: {} };
}

/** `gs://bucket/path` as the public HTTPS URL a browser can fetch. */
export function fetchableUrl(url: string): string {
  const gs = url.match(/^gs:\/\/([^/]+)\/(.*)$/);
  if (gs) return `https://storage.googleapis.com/${gs[1]}/${gs[2]}`;
  const s3 = url.match(/^s3:\/\/([^/]+)\/(.*)$/);
  if (s3) return `https://${s3[1]}.s3.amazonaws.com/${s3[2]}`;
  return url;
}

/** A short layer name from a data URL: its last path component. */
export function layerNameFor(url: string): string {
  const path = url.split("|")[0].replace(/^[a-z][a-z\d+.-]*:\/\//i, "");
  const last = path.replace(/\/+$/, "").split("/").pop() ?? "layer";
  return last.replace(/\.(zarrvectors|zarr|zv|nii\.gz|nii|json)$/i, "") || "layer";
}

/**
 * Works out what a pasted string is.
 *
 * Throws InputError with a message fit to show the user when it is none of
 * the accepted forms.
 */
export function parseInput(text: string, parseFragment: FragmentParser): ParsedInput {
  const input = text.trim();
  if (input === "") throw new InputError("Paste a Neuroglancer link, a state JSON or a data URL.");

  if (input.startsWith("{")) {
    let value: unknown;
    try {
      value = JSON.parse(input);
    } catch (e) {
      throw new InputError(`That looks like JSON but does not parse: ${(e as Error).message}`);
    }
    return { kind: "state", state: asWorkspace(value) };
  }

  const bang = input.indexOf("#!");
  if (bang !== -1) {
    const fragment = input.slice(bang + 2);
    let decoded = fragment;
    try {
      decoded = decodeURIComponent(fragment);
    } catch {
      // Leave it encoded; the url-safe parser copes with most of it.
    }
    if (SCHEME.test(decoded)) return { kind: "remote", url: fetchableUrl(decoded) };
    let value: unknown;
    try {
      value = JSON.parse(decoded);
    } catch {
      try {
        value = parseFragment(fragment);
      } catch (e) {
        throw new InputError(`The state in that link does not parse: ${(e as Error).message}`);
      }
    }
    return { kind: "state", state: asWorkspace(value) };
  }

  if (SCHEME.test(input) || DATA_SOURCE.test(input)) {
    const isJson = !input.includes("|") && /\.json(\?.*)?$/i.test(input);
    if (isJson) return { kind: "remote", url: fetchableUrl(input) };
    return { kind: "source", url: input, name: layerNameFor(input) };
  }

  throw new InputError(
    "Not a Neuroglancer link, a state JSON or a data URL. Links contain #!, states start with {, data URLs with a scheme such as https:// or gs://.",
  );
}

/** Percent-encodes a state fragment the way Neuroglancer writes its own links. */
export function encodeFragment(json: string): string {
  return encodeURI(json).replace(
    /[!'()*;,#]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0"),
  );
}

/** A link to this app that opens `state`. */
export function workspaceLink(base: string, state: WorkspaceState): string {
  const body = Object.keys(state.app).length === 0 ? { ng: state.ng } : state;
  return `${base.replace(/#.*$/, "")}#!${encodeFragment(JSON.stringify(body))}`;
}

/** Counts layers in a Neuroglancer state, for messages. */
export function layerCount(ng: Record<string, unknown>): number {
  const layers = ng.layers;
  if (Array.isArray(layers)) return layers.length;
  if (typeof layers === "object" && layers !== null) return Object.keys(layers).length;
  return 0;
}
