/**
 * Settings → Sign-in: the Google accounts of this browser (each with its state,
 * one the default, and Google's "Sign in with Google" button to add one);
 * the other sign-ins (the middleauth and ngauth servers and plugins'
 * services this workspace's data needs or that were added by hand); the
 * sign-in rules (which sign-in, and which Google account, reads a bucket
 * or a server); the active scene's layers, each with a drop-down of the
 * sign-ins its data can be read with; then the Google sign-in's setting
 * (its OAuth client ID).
 */
import { bucketPrefix, normalisePrefix, ruleFor, ruleSignIn, type SignInRule, sourceWithRules, storageOf } from "../../core/sign_in_rules.js";
import { GOOGLE_SIGN_IN, signInOf, sourceWithSignIn } from "../../core/source_auth.js";
import { layerName, layersOf, sourceUrls } from "../../core/workspace.js";
import { statusLabel } from "../../platform/auth.js";
import { accountLabel, accountStatus, GOOGLE_SCOPES, type GoogleSignIn } from "../../platform/google_auth.js";
import type { AuthService, AuthStatus, SourceSignIn } from "../../sdk/types.js";
import { card, emptyState, field } from "../../sdk/dom.js";
import { clear, h } from "../dom.js";
import { closeSheet, toast } from "../overlays.js";
import type { Workbench } from "../workbench.js";

/** An error from a click here: shown at once (a toast) and kept in Activity. */
function authError(wb: Workbench, message: string): void {
  wb.log.add(message, "error", "Auth");
  toast(message, "error");
}

/** The user guide's page on signing in. */
export const SIGNING_IN_GUIDE = "https://ngplatform.readthedocs.io/en/latest/guide/signing-in/";

/** Google's "G" logo, in its four colours, as Google's sign-in branding guidelines give it (never recoloured). */
const GOOGLE_G =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" aria-hidden="true" focusable="false">' +
  '<path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>' +
  '<path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>' +
  '<path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>' +
  '<path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>' +
  '<path fill="none" d="M0 0h48v48H0z"/></svg>';

/**
 * Google's pill-shaped "Sign in with Google" button, as its sign-in
 * branding guidelines draw it: the G logo and the words, in the dark theme
 * (the app's), outline when the page is light, or neutral.
 */
export function googleButton(text: string, onclick: () => void, theme?: "dark" | "outline" | "neutral"): HTMLButtonElement {
  const logo = h("span", { class: "gsi-pill-logo" });
  logo.innerHTML = GOOGLE_G;
  return h(
    "button",
    { class: `gsi-pill${theme !== undefined ? ` gsi-${theme}` : ""}`, type: "button", onclick },
    logo,
    h("span", { class: "gsi-pill-text" }, text),
  ) as HTMLButtonElement;
}

export function renderAuthPanel(host: HTMLElement, wb: Workbench): () => void {
  const { auth, google, rules } = wb;
  const list = h("div", { class: "list auth-list" });
  const reload = h(
    "p",
    { class: "note auth-reload", hidden: true },
    "Datasets opened before this change still use the old sign-in. ",
    h("button", { class: "btn small", type: "button", onclick: () => location.reload() }, "Reload"),
    " to apply it (the link keeps the workspace).",
  );
  const accounts = h("div", { class: "list auth-list auth-accounts" });
  const addAccount = h("div", { class: "auth-add-account" });
  const ruleList = h("div", { class: "list auth-rules" });
  const ruleEditor = h("div", { class: "auth-rule-editor", hidden: true });
  const layers = h("div", { class: "list auth-layers" });
  const sceneName = h("span", { class: "type" });
  const adding = addServerSection(wb);
  const setup = googleSection(wb, google);
  /** Opens a card below and puts the keyboard in its field. */
  const openCard = (target: HTMLDetailsElement) => () => {
    target.open = true;
    target.querySelector("input")?.focus();
  };
  const newRule = h("div", { class: "row-actions" }, h("button", { class: "btn outline small auth-new-rule", type: "button", onclick: () => editRule() }, "+ Rule"));
  host.append(
    card(
      "sign-in.google",
      "Google accounts",
      { open: true, info: "Kept in this browser, never in the link. Each account keeps its own sign-in. The default account reads every gs+google:// bucket that no rule gives another account." },
      accounts,
      addAccount,
    ),
    card("sign-in.other", "Other sign-ins", {}, list, reload),
    card(
      "sign-in.rules",
      "Rules",
      { info: "A rule gives data under an address (gs://bucket/, https://host/path/) a sign-in. The longest address that covers a source wins; a layer gets its rule's sign-in when it is added or the workspace is opened. Without a rule, a layer keeps the sign-in its source names, and gs+google:// buckets are read with the default account." },
      newRule,
      ruleList,
      ruleEditor,
    ),
    card(
      "sign-in.layers",
      "Layers in this scene",
      { badge: sceneName, info: "The sign-in is part of a layer's source (gs+google://bucket/… for gs://bucket/…), so the link keeps it. The Google account does not go in the link: choosing one sets the rule for the layer's bucket." },
      layers,
    ),
    adding.element,
    setup,
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
      reload.hidden = false;
    } catch (e) {
      authError(wb, `${service.title}: ${(e as Error).message}`);
    }
    check(service);
  };

  const draw = () => {
    const providers = auth.list().filter((p) => p.id !== "google");
    if (services.length === 0) {
      clear(
        list,
        providers.length === 0
          ? emptyState("No other sign-in methods are installed.", {
              label: "Plugins",
              run: () => {
                closeSheet();
                wb.docks.show("plugins");
              },
            })
          : emptyState("None needed.", { label: "Add a server…", run: openCard(adding.element) }),
      );
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

  // ------------------------------------------------------ Google accounts

  /** Runs a click's action, logging the line it answers with, or its error. */
  const googleAct = async (run: () => Promise<string>) => {
    try {
      wb.log.add(await run(), "info", "Auth");
    } catch (e) {
      authError(wb, `Google: ${(e as Error).message}`);
    }
  };

  const drawAccounts = () => {
    const all = google.accounts();
    const chosen = google.defaultAccount();
    const configured = google.clientId() !== undefined;
    clear(
      accounts,
      ...(all.length === 0
        ? [configured ? h("p", { class: "empty" }, "No Google account signed in.") : emptyState("Google sign-in is not set up.", { label: "Set up…", run: openCard(setup) })]
        : []),
      ...all.map(({ email }) => {
        const status = accountStatus(google, email);
        const label = accountLabel(email);
        const isDefault = email === chosen;
        return h(
          "div",
          { class: "auth-service auth-account", "data-account": email },
          h(
            "div",
            { class: "auth-head" },
            h("span", { class: `chip auth-${status.state}` }, statusLabel(status)),
            h("span", { class: "auth-title", title: label }, label),
            isDefault ? h("span", { class: "chip auth-default", title: "Reads every bucket no rule gives another account" }, "Default") : null,
          ),
          status.detail ? h("p", { class: "note" }, status.detail) : null,
          h(
            "div",
            { class: "auth-actions" },
            status.state === "expired" || status.state === "signed-out"
              ? h(
                  "button",
                  { class: "btn primary small", type: "button", title: `Signs ${label} in again, straight to that account`, onclick: () => void googleAct(async () => `Signed in to Google as ${accountLabel(await google.signIn(email))}.`) },
                  status.state === "expired" ? `Sign in again as ${label}` : `Sign in as ${label}`,
                )
              : null,
            status.state === "signed-in" || status.state === "expired"
              ? h("button", { class: "btn outline small", type: "button", onclick: () => void googleAct(async () => (await google.signOut(email), `Signed ${label} out of Google.`)) }, "Sign out")
              : null,
            isDefault ? null : h("button", { class: "btn outline small", type: "button", onclick: () => google.setDefault(email) }, "Make default"),
            h(
              "button",
              {
                class: "btn outline small",
                type: "button",
                title: "Forgets the account here (and revokes its sign-in); rules naming it wait until it is added again",
                onclick: () => void googleAct(async () => (await google.remove(email), `Removed the Google account ${label}.`)),
              },
              "Remove",
            ),
          ),
        );
      }),
    );
    const button = googleButton(all.length === 0 ? "Sign in with Google" : "Add a Google account", () => {
      void googleAct(async () => `Signed in to Google as ${accountLabel(await google.signIn())}.`);
    });
    button.disabled = !configured;
    button.title = configured ? "Opens Google's account chooser" : "Set a Google OAuth client ID first (Google sign-in setup, below)";
    clear(addAccount, button);
  };

  // ---------------------------------------------------------------- rules

  const sources = () => workspaceSources(wb);

  /** Layers of the scene a rule covers whose source it would change. */
  const ruleChanges = (rule: SignInRule) => {
    const signIns = auth.sourceSignIns(sources());
    const changes = new Map<string, unknown>();
    const all = rules.list();
    for (const spec of layersOf(wb.store.ng())) {
      if (!sourceUrls(spec.source).some((u) => ruleFor(all, u, signIns)?.prefix === rule.prefix)) continue;
      const source = sourceWithRules(spec.source, all, signIns);
      if (source !== spec.source) changes.set(layerName(spec), source);
    }
    return changes;
  };

  const applyRule = (rule: SignInRule) => {
    const changes = ruleChanges(rule);
    if (changes.size === 0) return;
    wb.store.setLayerSources(changes, { label: `Sign-in rule for ${rule.prefix} applied to ${changes.size} layer${changes.size === 1 ? "" : "s"}` });
  };

  const setRule = (rule: SignInRule, apply = false): SignInRule | undefined => {
    try {
      const kept = rules.set(rule);
      wb.log.add(`Rule: ${kept.prefix} → ${targetLabel(kept, google, auth.sourceSignIns(sources()))}.`, "info", "Auth");
      if (apply) applyRule(kept);
      return kept;
    } catch (e) {
      authError(wb, (e as Error).message);
      return undefined;
    }
  };

  const drawRules = () => {
    const all = rules.list();
    const signIns = auth.sourceSignIns(sources());
    // With no rules, the empty line's button adds one.
    newRule.hidden = all.length === 0;
    clear(
      ruleList,
      ...(all.length === 0 ? [emptyState("No rules.", { label: "Add a rule…", run: () => editRule() })] : []),
      ...all.map((rule) => {
        const select = targetSelect(storageOf(rule.prefix) ?? "gs", google, signIns, ruleValue(rule));
        select.setAttribute("aria-label", `Sign-in for ${rule.prefix}`);
        select.addEventListener("change", () => setRule({ prefix: rule.prefix, ...fromValue(select.value) }));
        const changes = ruleChanges(rule).size;
        return h(
          "div",
          { class: "auth-rule", "data-prefix": rule.prefix },
          h("code", { class: "auth-rule-prefix", title: rule.prefix }, rule.prefix),
          select,
          h("button", { class: "btn outline small icon", type: "button", title: `Remove the rule for ${rule.prefix}`, "aria-label": `Remove the rule for ${rule.prefix}`, onclick: () => rules.remove(rule.prefix) }, "×"),
          changes > 0
            ? h(
                "button",
                { class: "btn small auth-rule-apply", type: "button", title: "Rewrites their sources now, as one undo step", onclick: () => applyRule(rule) },
                `Apply to ${changes} layer${changes === 1 ? "" : "s"} here`,
              )
            : null,
        );
      }),
    );
  };

  /** The editor "+ Rule" opens: an address and a sign-in. */
  const editRule = () => {
    const input = h("input", { class: "text-input mono", placeholder: "gs://bucket/ or https://host/path/", "aria-label": "Rule address", spellcheck: "false" }) as HTMLInputElement;
    // Start from the selected layer's bucket, if any.
    const selected = wb.engine.selectedLayer();
    const spec = layersOf(wb.store.ng()).find((l) => layerName(l) === selected);
    const url = spec === undefined ? undefined : sourceUrls(spec.source)[0];
    input.value = (url !== undefined ? bucketPrefix(url, auth.sourceSignIns(sources())) : undefined) ?? "";
    const holder = h("span", { class: "auth-rule-target" });
    const target = () => {
      const storage = storageOf(normalisePrefix(input.value) ?? "gs://") ?? "gs";
      const previous = holder.firstElementChild as HTMLSelectElement | null;
      const select = targetSelect(storage, google, auth.sourceSignIns(sources()), previous?.value ?? "google");
      select.setAttribute("aria-label", "Sign-in for the new rule");
      clear(holder, select);
    };
    target();
    input.addEventListener("input", target);
    const save = () => {
      const select = holder.firstElementChild as HTMLSelectElement;
      if (setRule({ prefix: input.value, ...fromValue(select.value) }) !== undefined) close();
    };
    const close = () => {
      ruleEditor.hidden = true;
      clear(ruleEditor);
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") save();
      if (e.key === "Escape") close();
    });
    clear(
      ruleEditor,
      h("div", { class: "auth-add auth-rule-new" }, input, holder),
      h(
        "div",
        { class: "auth-actions" },
        h("button", { class: "btn small", type: "button", onclick: save }, "Save rule"),
        h("button", { class: "btn outline small", type: "button", onclick: close }, "Cancel"),
      ),
    );
    ruleEditor.hidden = false;
    input.focus();
  };

  // --------------------------------------------------------------- layers

  const refresh = async () => {
    const mine = ++generation;
    controller.abort();
    controller = new AbortController();
    const all = sources();
    const found = await Promise.all(
      auth
        .list()
        .filter((provider) => provider.id !== "google")
        .map(async (provider) => {
          try {
            return (await provider.services({ sources: all, manual: auth.manual(provider.id) })).map((service) => ({ provider: provider.id, service }));
          } catch (e) {
            authError(wb, `${provider.title}: ${(e as Error).message}`);
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
      .map((spec) => ({ name: layerName(spec), control: signInControl(wb, layerName(spec)) }))
      .filter((row) => row.control !== null);
    if (rows.length === 0) {
      clear(layers, h("p", { class: "empty" }, "None reads from a bucket or a server."));
      return;
    }
    clear(layers, ...rows.map(({ name, control }) => h("div", { class: "auth-layer" }, h("span", { class: "auth-layer-name", title: name }, name), control)));
  };

  const drawGoogle = () => {
    drawAccounts();
    drawRules();
    drawLayers();
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
      drawGoogle();
    }),
    google.onChanged(drawGoogle),
    rules.onChanged(drawGoogle),
    wb.store.onChange(() => {
      sourcesChanged();
      drawRules();
      drawLayers();
    }),
  ];
  if (google.clientId() !== undefined) void google.prepare().catch((e) => wb.log.add(`Google: ${(e as Error).message}`, "error", "Auth"));
  lastSources = JSON.stringify(sources());
  draw();
  drawGoogle();
  void refresh();
  return () => {
    controller.abort();
    offs.forEach((off) => off());
  };
}

/** Every source in the workspace: the datasets', and the active scene's layers'. */
function workspaceSources(wb: Workbench): string[] {
  return [
    ...wb.store.datasets().map((d) => (typeof d.source === "string" ? d.source : JSON.stringify(d.source))),
    ...layersOf(wb.store.ng()).flatMap((l) => sourceUrls(l.source)),
  ];
}

// ------------------------------------------------------- rule targets

/** A rule's value in a drop-down: "public", "google" (the default account), "google:<email>", or a sign-in's id. */
function ruleValue(rule: Pick<SignInRule, "signIn" | "account">): string {
  return rule.signIn === GOOGLE_SIGN_IN.id && rule.account !== undefined ? `google:${rule.account}` : rule.signIn;
}

function fromValue(value: string): Pick<SignInRule, "signIn" | "account"> {
  return value.startsWith("google:") ? { signIn: GOOGLE_SIGN_IN.id, account: value.slice("google:".length) } : { signIn: value };
}

/** A rule's sign-in in words. */
function targetLabel(rule: SignInRule, google: GoogleSignIn, signIns: SourceSignIn[]): string {
  if (rule.signIn === GOOGLE_SIGN_IN.id) return rule.account === undefined ? `Google, the default account${google.defaultAccount() !== undefined ? ` (${accountLabel(google.defaultAccount())})` : ""}` : `Google, ${accountLabel(rule.account)}`;
  return ruleSignIn(rule, signIns)?.title ?? rule.signIn;
}

/** A drop-down of what a rule for a bucket (gs) or a web server (http) can name. */
function targetSelect(storage: "gs" | "http", google: GoogleSignIn, signIns: SourceSignIn[], value: string): HTMLSelectElement {
  const options: { value: string; label: string }[] = [{ value: "public", label: "None (public)" }];
  if (storage === "gs") {
    const chosen = google.defaultAccount();
    options.push({ value: "google", label: `Google: the default account${chosen !== undefined ? ` (${accountLabel(chosen)})` : ""}` });
    for (const { email } of google.accounts()) options.push({ value: `google:${email}`, label: `Google: ${accountLabel(email)}` });
  }
  for (const s of signIns) {
    if (s.storage === storage && s.id !== "public" && s.id !== GOOGLE_SIGN_IN.id) options.push({ value: s.id, label: s.title });
  }
  if (!options.some((o) => o.value === value)) {
    const label = value.startsWith("google:") ? `Google: ${accountLabel(value.slice(7))} (not signed in here)` : `${value} (not available)`;
    options.push({ value, label });
  }
  const select = h("select", { class: "text-input auth-select" }, ...options.map((o) => h("option", { value: o.value }, o.label))) as HTMLSelectElement;
  select.value = value;
  return select;
}

// ------------------------------------------------- a layer's sign-in

/**
 * A layer's sign-in: a drop-down of the sign-ins its data can be read with
 * (None, each Google account or an ngauth server for a bucket; None or
 * middleauth for a web server), and "Use for all of" its bucket or host,
 * which makes that a rule; null when none applies (local data).  Choosing
 * a Google account sets the rule for the layer's bucket (the account is
 * not in the link).
 */
/** `onlyIfNeeded`: none for public data whose rule (if any) agrees, which most layers are. */
export function signInControl(wb: Workbench, name: string, onlyIfNeeded = false): HTMLElement | null {
  const { auth, google, rules } = wb;
  const spec = layersOf(wb.store.ng()).find((l) => layerName(l) === name);
  const url = spec === undefined ? undefined : sourceUrls(spec.source)[0];
  if (spec === undefined || url === undefined) return null;
  const signIns = auth.sourceSignIns(workspaceSources(wb));
  const current = signInOf(url, signIns);
  if (current === undefined) return null;
  const storage = current.signIn.storage;
  const accounts = google.accounts();
  const rule = ruleFor(rules.list(), url, signIns);
  const bucket = bucketPrefix(url, signIns);
  const account = rule?.signIn === GOOGLE_SIGN_IN.id && rule.account !== undefined ? rule.account : google.defaultAccount();

  const options: { value: string; label: string; signIn: SourceSignIn; account?: string }[] = [];
  for (const s of signIns.filter((s) => s.storage === storage)) {
    if (s.id === GOOGLE_SIGN_IN.id && accounts.length > 0) {
      for (const { email } of accounts) {
        options.push({ value: `google:${email}`, label: `Google: ${accountLabel(email)}${email === google.defaultAccount() ? " (default)" : ""}`, signIn: s, account: email });
      }
      if (account !== undefined && !accounts.some((a) => a.email === account)) {
        options.push({ value: `google:${account}`, label: `Google: ${accountLabel(account)} (not signed in here)`, signIn: s, account });
      }
    } else {
      options.push({ value: s.id, label: s.title, signIn: s });
    }
  }
  const currentValue = current.signIn.id === GOOGLE_SIGN_IN.id && account !== undefined && options.some((o) => o.value === `google:${account}`) ? `google:${account}` : current.signIn.id;

  const select = h(
    "select",
    {
      class: "text-input auth-select",
      "aria-label": `Sign-in for ${name}`,
      title: storage === "gs" ? `Which sign-in this layer reads its data with; a Google account chosen here is set for all of ${rule?.prefix ?? bucket}` : "Which sign-in this layer reads its data with",
      onchange: () => {
        const target = options.find((o) => o.value === select.value);
        if (target === undefined) return;
        if (target.account !== undefined) {
          // The account is not in the link: it is the rule for the layer's bucket (or the folder rule it already has).
          const prefix = rule?.prefix ?? bucket;
          if (prefix !== undefined) {
            const kept = rules.set({ prefix, signIn: GOOGLE_SIGN_IN.id, account: target.account });
            wb.log.add(`Rule: ${kept.prefix} → Google, ${accountLabel(target.account)} (for “${name}” and all other data under it).`, "info", "Auth");
          }
        }
        if (target.signIn !== current.signIn) {
          wb.store.setLayerSource(name, sourceWithSignIn(spec.source, target.signIn, signIns), `Sign-in for “${name}”: ${target.label}`);
        }
      },
    },
    ...options.map((o) => h("option", { value: o.value }, o.label)),
  ) as HTMLSelectElement;
  select.value = currentValue;

  // Not offered when the bucket's own rule already says what the layer has.
  const covered =
    rule !== undefined &&
    rule.prefix === bucket &&
    ruleSignIn(rule, signIns)?.id === current.signIn.id &&
    (current.signIn.id !== GOOGLE_SIGN_IN.id || rule.account === undefined || rule.account === account);
  const useForAll =
    bucket === undefined || covered
      ? null
      : h(
          "button",
          {
            class: "btn outline small auth-use-for-all",
            type: "button",
            title: `Makes a rule: data under ${bucket} reads with this sign-in, in layers added or opened from now on, and in this scene's layers now`,
            onclick: () => {
              const chosen = options.find((o) => o.value === select.value);
              if (chosen === undefined) return;
              const kept = rules.set({ prefix: bucket, signIn: chosen.signIn.id, ...(chosen.account !== undefined ? { account: chosen.account } : {}) });
              wb.log.add(`Rule: ${kept.prefix} → ${chosen.label}.`, "info", "Auth");
              const all = rules.list();
              const changes = new Map<string, unknown>();
              for (const other of layersOf(wb.store.ng())) {
                if (!sourceUrls(other.source).some((u) => ruleFor(all, u, signIns)?.prefix === kept.prefix)) continue;
                const source = sourceWithRules(other.source, all, signIns);
                if (source !== other.source) changes.set(layerName(other), source);
              }
              if (changes.size > 0) wb.store.setLayerSources(changes, { label: `Sign-in for all of ${kept.prefix}: ${chosen.label}` });
            },
          },
          `Use for all of ${bucket.replace(/\/$/, "")}`,
        );

  const differs = rule !== undefined && ruleSignIn(rule, signIns)?.id !== current.signIn.id;
  if (onlyIfNeeded && current.signIn.id === "public" && !differs) return null;
  return h(
    "div",
    { class: "auth-layer-control" },
    select,
    useForAll,
    differs
      ? h("p", { class: "note auth-layer-differs" }, `The rule for ${rule!.prefix} says ${ruleSignIn(rule!, signIns)?.title ?? rule!.signIn}; it applies again when the workspace is opened.`)
      : null,
  );
}

function addServerSection(wb: Workbench): { element: HTMLDetailsElement; dispose: () => void } {
  const { auth } = wb;
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
      authError(wb, (e as Error).message);
    }
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") add();
  });
  const element = card(
    "sign-in.add-server",
    "Add a sign-in server",
    { info: "To sign in before opening the data. Middleauth: a CAVE or CATMAID site's address (it names its sign-in server) or the sign-in server's own. ngauth: the server that hands out tokens for gs+ngauth+https:// buckets." },
    h("div", { class: "auth-add auth-add-server" }, input, kind, h("button", { class: "btn outline small", type: "button", onclick: add }, "Add")),
  );
  return { element, dispose: auth.onChanged(kinds) };
}

function googleSection(wb: Workbench, google: GoogleSignIn): HTMLDetailsElement {
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
    if (google.clientId() !== undefined) void google.prepare().catch((e) => authError(wb, `Google: ${(e as Error).message}`));
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") save();
  });
  // Setting up: closed, unless the site has no client ID (then it needs doing).
  const details = card(
    "sign-in.google-setup",
    "Google sign-in setup",
    { attention: google.clientId() === undefined, info: `A layer reads a bucket with Google when its source is gs+google://. A token lasts about an hour; sign in again to renew it. It asks for: ${GOOGLE_SCOPES.map((s) => s.what).join("; ")}.` },
    field("Google OAuth client ID", h("span", { class: "auth-add" }, input, h("button", { class: "btn outline small", type: "button", onclick: save }, "Save")), {
      info: `${google.builtInClientId ? "One is built in; one set here replaces it (empty goes back)." : "None is built in."} Its authorised JavaScript origin is ${location.origin}.`,
    }),
    h("a", { class: "guide-link", href: SIGNING_IN_GUIDE, target: "_blank", rel: "noopener noreferrer" }, "Signing in guide ↗"),
  );
  return details;
}
