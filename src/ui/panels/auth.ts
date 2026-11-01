/**
 * The Auth tab: the services this workspace's data needs a sign-in for,
 * each with who is signed in and buttons to sign in and out.  Servers can
 * be added by hand to sign in ahead of opening their data.
 */
import { type AuthRegistry, statusLabel } from "../../platform/auth.js";
import type { AuthService, AuthStatus } from "../../sdk/types.js";
import { clear, h } from "../dom.js";
import type { Workbench } from "../workbench.js";

export function renderAuthPanel(host: HTMLElement, wb: Workbench, auth: AuthRegistry): () => void {
  const list = h("div", { class: "list auth-list" });
  const input = h("input", { class: "text-input", placeholder: "https://… (a data or sign-in server)", "aria-label": "Server address", spellcheck: "false" });
  const add = () => {
    try {
      auth.addManual(input.value);
      input.value = "";
    } catch (e) {
      wb.log.add((e as Error).message, "error");
    }
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") add();
  });
  const reload = h(
    "p",
    { class: "note auth-reload", hidden: true },
    "Datasets opened before this change still use the old sign-in. ",
    h("button", { class: "btn small", type: "button", onclick: () => location.reload() }, "Reload"),
    " to apply it (the link keeps the workspace).",
  );
  host.append(
    h(
      "div",
      { class: "section" },
      h("h3", { class: "section-title" }, "Sign-in"),
      h(
        "p",
        { class: "note first" },
        "Data behind a sign-in (middleauth+https:// sources, and whatever plugins add) is listed here with who you are signed in as. The viewer also asks when a dataset needs it. Sign-ins are kept in this browser, never in the link.",
      ),
      list,
      reload,
      h("div", { class: "auth-add" }, input, h("button", { class: "btn outline small", type: "button", onclick: add }, "Add")),
    ),
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
      wb.log.add(`${service.title}: ${(e as Error).message}`, "error", "Auth");
    }
    check(service);
  };

  const draw = () => {
    const providers = auth.list();
    if (services.length === 0) {
      clear(
        list,
        h(
          "p",
          { class: "empty" },
          providers.length === 0 ? "No sign-in methods are installed." : "Nothing in this workspace needs a sign-in. Add a server below to sign in ahead.",
        ),
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
          { class: "auth-service" },
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
            service.signIn && !signedIn
              ? h("button", { class: "btn small", type: "button", onclick: () => void act(service, "in") }, status?.state === "expired" ? "Sign in again" : "Sign in")
              : null,
            service.signOut && (signedIn || status?.state === "expired")
              ? h("button", { class: "btn outline small", type: "button", onclick: () => void act(service, "out") }, "Sign out")
              : null,
            h("button", { class: "btn outline small", type: "button", onclick: () => check(service) }, "Check"),
            service.manual?.length
              ? h("button", { class: "btn outline small", type: "button", onclick: () => service.manual!.forEach((a) => auth.removeManual(a)) }, "Remove")
              : null,
          ),
        );
      }),
    );
  };

  const refresh = async () => {
    const mine = ++generation;
    controller.abort();
    controller = new AbortController();
    const sources = wb.store.datasets().map((d) => (typeof d.source === "string" ? d.source : JSON.stringify(d.source)));
    const manual = auth.manual();
    const found = await Promise.all(
      auth.list().map(async (provider) => {
        try {
          return (await provider.services({ sources, manual })).map((service) => ({ provider: provider.id, service }));
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

  let lastSources = "";
  const offs = [
    auth.onChanged(() => void refresh()),
    wb.store.onChange(() => {
      const key = JSON.stringify(wb.store.datasets().map((d) => d.source));
      if (key === lastSources) return;
      lastSources = key;
      void refresh();
    }),
  ];
  lastSources = JSON.stringify(wb.store.datasets().map((d) => d.source));
  draw();
  void refresh();
  return () => {
    controller.abort();
    offs.forEach((off) => off());
  };
}
