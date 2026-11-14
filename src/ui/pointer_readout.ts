/**
 * The pointer's position over the views, after the position's copy button:
 * Neuroglancer writes it as one line of text ("x 12  y 34  z 5"), in the
 * global coordinates, without units.  Shown here as readouts, each value
 * with its dimension's unit after a 1 px line, the units read from the
 * position bar's own scale fields beside it ("mm", "4nm", as it shows them
 * in brackets).  Additive: Neuroglancer's element is left as it is (hidden
 * by the stylesheet) and this one follows it.
 */
import { el, readout } from "../sdk/dom.js";

/** "x 12  y 34  z 5" as names and values; anything else as nothing. */
export function parsePointerText(text: string): { name: string; value: string }[] {
  const out: { name: string; value: string }[] = [];
  for (const part of text.trim().split(/\s{2,}/)) {
    const m = /^(\S+)\s+(\S+)$/.exec(part);
    if (m === null) return [];
    out.push({ name: m[1], value: m[2].replace(/^-/, "−") });
  }
  return out;
}

/** Follows Neuroglancer's pointer position under `host` (the views); returns a function that stops. */
export function pointerReadout(host: HTMLElement): () => void {
  const out = el("div", { class: "pointer-readout", "aria-hidden": "true" });
  let widget: Element | null = null;
  let follow: MutationObserver | undefined;

  /** Each dimension's unit, by name, from the position bar's scale fields. */
  const units = (): Map<string, string> => {
    const map = new Map<string, string>();
    for (const d of host.querySelectorAll(".neuroglancer-position-dimension")) {
      const name = d.querySelector<HTMLInputElement>(".neuroglancer-position-dimension-name")?.value;
      const unit = d.querySelector<HTMLInputElement>(".neuroglancer-position-dimension-scale")?.value;
      if (name) map.set(name, unit ?? "");
    }
    return map;
  };

  const render = () => {
    const parts = parsePointerText(widget?.textContent ?? "");
    const unitOf = units();
    out.replaceChildren(
      ...parts.map(({ name, value }) => el("span", { class: "pointer-dim" }, el("span", { class: "pointer-name" }, name), " ", readout(value, unitOf.get(name) || undefined))),
    );
  };

  const attach = () => {
    if (widget?.isConnected) return;
    follow?.disconnect();
    widget = host.querySelector(".neuroglancer-mouse-position-widget");
    if (widget === null) return;
    widget.after(out);
    follow = new MutationObserver(render);
    follow.observe(widget, { childList: true, characterData: true, subtree: true });
    render();
  };

  // The viewer's DOM is built (and may be built again) after the shell: found when it appears.
  const watch = new MutationObserver(attach);
  watch.observe(host, { childList: true, subtree: true });
  attach();
  return () => {
    watch.disconnect();
    follow?.disconnect();
    out.remove();
  };
}
