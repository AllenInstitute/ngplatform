/**
 * The Auth tab: the sign-ins available (Google for the whole browser, and
 * the middleauth and ngauth servers and plugins' services this workspace's
 * data needs or that were added by hand), each with who is signed in and
 * buttons to sign in and out; then the active scene's layers, each with a
 * drop-down of the sign-ins its data can be read with; then the Google
 * sign-in's setting (its OAuth client ID).
 */
import { signInOf, sourceWithSignIn } from "../../core/source_auth.js";
import { layerName, layersOf, sourceUrls } from "../../core/workspace.js";
import { type AuthRegistry, statusLabel } from "../../platform/auth.js";
import { GOOGLE_SCOPES, type GoogleSignIn } from "../../platform/google_auth.js";
import type { AuthService, AuthStatus } from "../../sdk/types.js";
import { clear, h } from "../dom.js";
import type { Workbench } from "../workbench.js";

/** The user guide's page on signing in. */
export const SIGNING_IN_GUIDE = "https://ngplatform.readthedocs.io/en/latest/guide/signing-in/";

export function renderAuthPanel(host: HTMLElement, wb: Workbench, auth: AuthRegistry, google: GoogleSignIn): () => void {
  const list = h("div", { class: "list auth-list" });
  const reload = h(
    "p",
    { class: "note auth-reload", hidden: true },
    "Datasets opened before this change still use the old sign-in. ",
    h("button", { class: "btn small", type: "button", onclick: () => location.reload() }, "Reload"),
    " to apply it (the link keeps the workspace).",
  );
  const layers = h("div", { class: "list auth-layers" });
  const sceneName = h("span", { class: "type" });
  const adding = addServerSection(wb, auth);
  host.append(
    h(
      "div",
      { class: "section" },
      h("p", { class: "note first" }, "Sign-ins for data that needs one, and who you are signed in as. Sign-ins stay in this browser, never in the link."),
      h("h3", { class: "section-title" }, "Sign-ins"),
      list,
      reload,
    ),
    adding.element,
    h(
      "div",
      { class: "section" },
      h("h3", { class: "section-title auth-layers-title" }, "Layers in this scene ", sceneName),
      layers,
      h("p", { class: "note" }, "The sign-in a layer reads its data with is part of its source (gs+google://bucket/… for gs://bucket/…), so the link keeps it."),
    ),
    googleSection(wb, google),
  );

  const statuses = new Map<string, AuthStatus | undefined>();
  let services: { provider: string; service: AuthService }[] = [];
  let generation = 0;
  let controller = new AbortController();

  const check = (service: AuthService) => {
    statuses.set(service.id, undefined);
    draw();
    const signal = controller.signal;
    service.status(signal).then(
      (status) => {
        if (signal.aborted) return;
        statuses.set(service.id, status);
        draw();
      },
      (e) => {
        if (signal.aborted) return;
        statuses.set(service.id, { state: "error", detail: (e as Error).message });
        draw();
      },
    );
  };

  const act = async (service: AuthService, what: "in" | "out") => {
    try {
      if (what === "in") await service.signIn!();
      else await service.signOut!();
      wb.log.add(`${what === "in" ? "Signed in to" : "Signed out of"} ${service.title}.`, "info", "Auth");
      // The Google sign-in reaches data already open; the others are read when it opens.
      if (service.id !== "google") reload.hidden = false;
    } catch (e) {
      wb.log.add(`${service.title}: ${(e as Error).message}`, "error", "Auth");
    }
    check(service);
  };

  const draw = () => {
    const providers = auth.list();
    if (services.length === 0) {
      clear(list, h("p", { class: "empty" }, providers.length === 0 ? "No sign-in methods are installed." : "Checking…"));
      return;
    }
    clear(
      list,
      ...services.map(({ provider, service }) => {
        const status = statuses.get(service.id);
        const signedIn = status?.state === "signed-in";
        return h(
          "div",
          { class: "auth-service", "data-service": service.id },
          h(
            "div",
            { class: "auth-head" },
            h("span", { class: `chip auth-${status?.state ?? "checking"}` }, statusLabel(status)),
            h("span", { class: "auth-title", title: service.id }, service.title),
            h("span", { class: "type" }, providers.find((p) => p.id === provider)?.title ?? provider),
          ),
          service.detail ? h("p", { class: "empty" }, service.detail) : null,
          status?.user || status?.detail ? h("p", { class: "note" }, [status.user ? `As ${status.user}` : undefined, status.detail].filter(Boolean).join(" · ")) : null,
          h(
            "div",
            { class: "auth-actions" },
            service.signIn && !signedIn && status?.state !== "unconfigured"
              ? h("button", { class: "btn small", type: "button", onclick: () => void act(service, "in") }, status?.state === "expired" ? "Sign in again" : "Sign in")
              : null,
            service.signOut && (signedIn || status?.state === "expired")
              ? h("button", { class: "btn outline small", type: "button", onclick: () => void act(service, "out") }, "Sign out")
              : null,
            h("button", { class: "btn outline small", type: "button", onclick: () => check(service) }, "Check"),
            service.manual?.length
              ? h("button", { class: "btn outline small", type: "button", onclick: () => service.manual!.forEach((a) => auth.removeManual(a, provider)) }, "Remove")
              : null,
          ),
        );
      }),
    );
  };

  const sources = () => workspaceSources(wb);

  const refresh = async () => {
    const mine = ++generation;
    controller.abort();
    controller = new AbortController();
    const all = sources();
    const found = await Promise.all(
      auth.list().map(async (provider) => {
        try {
          return (await provider.services({ sources: all, manual: auth.manual(provider.id) })).map((service) => ({ provider: provider.id, service }));
        } catch (e) {
          wb.log.add(`${provider.title}: ${(e as Error).message}`, "error", "Auth");
          return [];
        }
      }),
    );
    if (mine !== generation) return;
    services = found.flat();
    for (const { service } of services) check(service);
    draw();
  };

  const drawLayers = () => {
    sceneName.textContent = wb.store.state().scenes.find((s) => s.id === wb.store.state().activeScene)?.name ?? "";
    const rows = layersOf(wb.store.ng())
      .map((spec) => ({ name: layerName(spec), select: signInSelect(wb, auth, layerName(spec)) }))
      .filter((row) => row.select !== null);
    if (rows.length === 0) {
      clear(layers, h("p", { class: "empty" }, "No layer in this scene reads from a bucket or a web server."));
      return;
    }
    clear(layers, ...rows.map(({ name, select }) => h("label", { class: "auth-layer" }, h("span", { class: "auth-layer-name", title: name }, name), select)));
  };

  // Sources change as layers are added; the drop-downs follow every change (and the active scene).
  let lastSources = "";
  const sourcesChanged = () => {
    const key = JSON.stringify(sources());
    if (key === lastSources) return;
    lastSources = key;
    void refresh();
  };
  const offs = [
    adding.dispose,
    auth.onChanged(() => {
      void refresh();
      drawLayers();
    }),
    wb.store.onChange(() => {
      sourcesChanged();
      drawLayers();
    }),
  ];
  if (google.clientId() !== undefined) void google.prepare().catch((e) => wb.log.add(`Google: ${(e as Error).message}`, "error", "Auth"));
  lastSources = JSON.stringify(sources());
  draw();
  drawLayers();
  void refresh();
  return () => {
    controller.abort();
    offs.forEach((off) => off());
  };
}

/**
 * A drop-down of the sign-ins a layer's data can be read with (None,
 * Google or an ngauth server for a bucket; None or middleauth for a web
 * server), choosing which it uses; null when none applies (local data).
 */
/** Every source in the workspace: the datasets', and the active scene's layers'. */
function workspaceSources(wb: Workbench): string[] {
  return [
    ...wb.store.datasets().map((d) => (typeof d.source === "string" ? d.source : JSON.stringify(d.source))),
    ...layersOf(wb.store.ng()).flatMap((l) => sourceUrls(l.source)),
  ];
}

export function signInSelect(wb: Workbench, auth: AuthRegistry, name: string): HTMLSelectElement | null {
  const spec = layersOf(wb.store.ng()).find((l) => layerName(l) === name);
  const url = spec === undefined ? undefined : sourceUrls(spec.source)[0];
  if (spec === undefined || url === undefined) return null;
  const signIns = auth.sourceSignIns(workspaceSources(wb));
  const current = signInOf(url, signIns);
  if (current === undefined) return null;
  const options = signIns.filter((s) => s.storage === current.signIn.storage);
  const select = h(
    "select",
    {
      class: "text-input auth-select",
      "aria-label": `Sign-in for ${name}`,
      title: "Which sign-in this layer reads its data with",
      onchange: () => {
        const target = options.find((s) => s.id === select.value);
        if (target === undefined || target === current.signIn) return;
        wb.store.setLayerSource(name, sourceWithSignIn(spec.source, target, signIns), `Sign-in for “${name}”: ${target.title}`);
      },
    },
    ...options.map((s) => h("option", { value: s.id }, s.title)),
  ) as HTMLSelectElement;
  select.value = current.signIn.id;
  return select;
}

function addServerSection(wb: Workbench, auth: AuthRegistry): { element: HTMLElement; dispose: () => void } {
  const input = h("input", { class: "text-input", placeholder: "https://… (a CAVE, CATMAID or ngauth server)", "aria-label": "Server address", spellcheck: "false" });
  const kind = h("select", { class: "text-input auth-kind", "aria-label": "Kind of sign-in" }) as HTMLSelectElement;
  const kinds = () => {
    const chosen = kind.value;
    const takers = auth.list().filter((p) => p.accepts !== undefined);
    kind.replaceChildren(...takers.map((p) => h("option", { value: p.id }, p.id === "middleauth" ? "Middleauth (CAVE, CATMAID)" : p.id === "ngauth" ? "ngauth (Cloud Storage)" : p.title)));
    if (takers.some((p) => p.id === chosen)) kind.value = chosen;
  };
  kinds();
  input.addEventListener("input", () => {
    // A source pasted whole says which kind it is.
    const m = input.value.trim().match(/^(middleauth|gs\+ngauth)\+/);
    if (m !== null) kind.value = m[1] === "middleauth" ? "middleauth" : "ngauth";
  });
  const add = () => {
    try {
      auth.addManual(input.value, kind.value || undefined);
      input.value = "";
    } catch (e) {
      wb.log.add((e as Error).message, "error", "Auth");
    }
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") add();
  });
  const element = h(
    "div",
    { class: "section" },
    h("h3", { class: "section-title" }, "Add a sign-in server"),
    h("div", { class: "auth-add auth-add-server" }, input, kind, h("button", { class: "btn outline small", type: "button", onclick: add }, "Add")),
    h(
      "p",
      { class: "note" },
      "To sign in before opening the data. Middleauth: a CAVE or CATMAID site's address (it names its sign-in server) or the sign-in server's own. ngauth: the server that hands out tokens for gs+ngauth+https:// buckets.",
    ),
  );
  return { element, dispose: auth.onChanged(kinds) };
}

function googleSection(wb: Workbench, google: GoogleSignIn): HTMLElement {
  const input = h("input", {
    class: "text-input mono",
    placeholder: google.builtInClientId ? google.builtInClientId : "…apps.googleusercontent.com",
    "aria-label": "Google OAuth client ID",
    spellcheck: "false",
  }) as HTMLInputElement;
  input.value = google.clientIdSetting() ?? "";
  const save = () => {
    google.setClientId(input.value);
    wb.log.add(input.value.trim() === "" ? "Google sign-in uses the built-in client ID again." : "Google OAuth client ID saved in this browser.", "info", "Auth");
    if (google.clientId() !== undefined) void google.prepare().catch((e) => wb.log.add(`Google: ${(e as Error).message}`, "error", "Auth"));
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") save();
  });
  return h(
    "div",
    { class: "section auth-google" },
    h("h3", { class: "section-title" }, "Google sign-in"),
    h(
      "p",
      { class: "note first" },
      "Signs this browser in to Google, for Google Cloud Storage buckets your account can read: a layer reads one with Google chosen above (gs+google://). The token lasts about an hour; sign in again to renew it. It asks to:",
    ),
    h("ul", { class: "note auth-scopes" }, ...GOOGLE_SCOPES.map((s) => h("li", {}, h("code", {}, s.scope), `: ${s.what}`))),
    h("label", { class: "auth-field" }, h("span", {}, "Google OAuth client ID"), h("span", { class: "auth-add" }, input, h("button", { class: "btn outline small", type: "button", onclick: save }, "Save"))),
    h(
      "p",
      { class: "note" },
      google.builtInClientId
        ? "This site has one built in; one set here replaces it in this browser (empty goes back to it). "
        : "This site has none built in. ",
      "Make one in the Google Cloud console: an OAuth consent screen, then a client of type Web application whose authorised JavaScript origins include this site's address (",
      h("code", {}, location.origin),
      "). ",
      h("a", { href: SIGNING_IN_GUIDE, target: "_blank", rel: "noopener noreferrer" }, "Signing in"),
      " in the guide has the steps.",
    ),
  );
}
