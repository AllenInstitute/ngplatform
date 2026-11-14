// @vitest-environment dom
/**
 * The theme (src/ui/theme.ts) and the views' grounds (src/engine/backgrounds.ts):
 * dark by default, kept in this browser, live with the system's setting under
 * Match system; the views' light ground shown for a while and never saved.
 */
import { describe, expect, it, vi } from "vitest";
import { Theme, THEME_KEY, VIEWS_FOLLOW_KEY } from "../src/ui/theme.js";
import { type BackgroundColour, groundOf, ViewBackgrounds } from "../src/engine/backgrounds.js";
import { rgbOf, VIEW_GROUND_LIGHT, VIEW_MARGIN } from "../src/core/view_defaults.js";

function storage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v), map };
}

function system(matches: boolean) {
  const listeners = new Set<() => void>();
  return {
    matches,
    addEventListener: (_: string, l: () => void) => void listeners.add(l),
    removeEventListener: (_: string, l: () => void) => void listeners.delete(l),
    change(next: boolean) {
      this.matches = next;
      for (const l of listeners) l();
    },
  };
}

describe("the theme", () => {
  it("is dark until another is chosen, and sets data-theme on the root", () => {
    const root = document.createElement("html");
    const theme = new Theme({ storage: storage(), root, systemLight: system(true) as never });
    expect(theme.choice()).toBe("dark");
    expect(root.getAttribute("data-theme")).toBe("dark");
    theme.setChoice("light");
    expect(root.getAttribute("data-theme")).toBe("light");
  });

  it("keeps the choice in this browser, and reads it back", () => {
    const kept = storage();
    new Theme({ storage: kept, root: document.createElement("html"), systemLight: undefined }).setChoice("light");
    expect(kept.map.get(THEME_KEY)).toBe("light");
    const again = new Theme({ storage: kept, root: document.createElement("html"), systemLight: undefined });
    expect(again.resolved()).toBe("light");
  });

  it("follows the system under Match system, live", () => {
    const root = document.createElement("html");
    const media = system(false);
    const theme = new Theme({ storage: storage({ [THEME_KEY]: "system" }), root, systemLight: media as never });
    const changed = vi.fn();
    theme.onChanged(changed);
    expect(theme.resolved()).toBe("dark");
    media.change(true);
    expect(root.getAttribute("data-theme")).toBe("light");
    expect(changed).toHaveBeenCalledTimes(1);
    theme.setChoice("dark");
    media.change(false);
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it("toggles between dark and light", () => {
    const theme = new Theme({ storage: storage({ [THEME_KEY]: "system" }), root: document.createElement("html"), systemLight: system(true) as never });
    theme.toggle();
    expect(theme.choice()).toBe("dark");
    theme.toggle();
    expect(theme.choice()).toBe("light");
  });

  it("shows the views light only in the light theme with Views follow theme on", () => {
    const kept = storage();
    const theme = new Theme({ storage: kept, root: document.createElement("html"), systemLight: undefined });
    expect(theme.viewsFollow()).toBe(false);
    theme.setViewsFollow(true);
    expect(kept.map.get(VIEWS_FOLLOW_KEY)).toBe("1");
    expect(theme.lightViews()).toBe(false);
    theme.setChoice("light");
    expect(theme.lightViews()).toBe(true);
  });

  it("holds a choice for the page when storage refuses it", () => {
    const refusing = { getItem: () => null, setItem: () => { throw new Error("quota"); } };
    const theme = new Theme({ storage: refusing, root: document.createElement("html"), systemLight: undefined });
    theme.setChoice("light");
    expect(theme.resolved()).toBe("light");
  });
});

/** A TrackableRGB's parts: a value, its JSON (undefined at the default), its changes. */
function colour(initial: string | undefined, fallback = "#000000") {
  const listeners = new Set<() => void>();
  const defaultValue = Float32Array.from(rgbOf(fallback));
  let value: ArrayLike<number> = Float32Array.from(rgbOf(initial ?? fallback));
  const toHex = (v: ArrayLike<number>) => "#" + Array.from(v, (c) => Math.round(c * 255).toString(16).padStart(2, "0")).join("");
  const c: BackgroundColour & { value: ArrayLike<number> } = {
    get value() {
      return value;
    },
    set value(v: ArrayLike<number>) {
      value = v;
      for (const l of listeners) l();
    },
    toJSON: () => (toHex(value) === toHex(defaultValue) ? undefined : toHex(value)),
    changed: { add: (l) => (listeners.add(l), () => void listeners.delete(l)) },
  };
  return c;
}

const LIGHT = { sections: rgbOf(VIEW_GROUND_LIGHT.sections), view3d: rgbOf(VIEW_GROUND_LIGHT.view3d) };

describe("the views' grounds", () => {
  it("tells a dark ground from a light one", () => {
    expect(groundOf(rgbOf(VIEW_MARGIN))).toBe("dark");
    expect(groundOf(rgbOf(VIEW_GROUND_LIGHT.sections))).toBe("light");
    expect(groundOf([0.5, 0.5, 0.5])).toBe("light");
    expect(groundOf([0.4, 0.4, 0.4])).toBe("dark");
  });

  it("shows the light ground for a while and saves the state's own", () => {
    const sections = colour(VIEW_MARGIN);
    const view3d = colour(undefined);
    const shown = vi.fn();
    const bg = new ViewBackgrounds({ sections, view3d }, shown);
    bg.setGround(LIGHT);
    expect(bg.grounds()).toEqual({ sections: "light", view3d: "light" });
    expect(bg.saved()).toEqual({ sections: VIEW_MARGIN, view3d: undefined });
    expect(shown).toHaveBeenCalled();
    bg.setGround(undefined);
    expect(bg.saved()).toBeUndefined();
    expect(sections.toJSON()).toBe(VIEW_MARGIN);
    expect(view3d.toJSON()).toBeUndefined();
  });

  it("keeps the ground over a state restored, saving the state's backgrounds", () => {
    const sections = colour(VIEW_MARGIN);
    const view3d = colour(undefined);
    const bg = new ViewBackgrounds({ sections, view3d });
    bg.setGround(LIGHT);
    bg.under(() => {
      sections.value = Float32Array.from(rgbOf("#336699"));
    });
    expect(bg.saved()).toEqual({ sections: "#336699", view3d: undefined });
    expect(bg.grounds().sections).toBe("light");
    bg.setGround(undefined);
    expect(sections.toJSON()).toBe("#336699");
  });

  it("shows a plugin's background over the ground, and the ground again after", () => {
    const sections = colour(VIEW_MARGIN);
    const view3d = colour(undefined);
    const bg = new ViewBackgrounds({ sections, view3d });
    bg.setGround(LIGHT);
    bg.setPlugin([0, 0, 0]);
    expect(bg.grounds()).toEqual({ sections: "dark", view3d: "light" });
    bg.setPlugin(undefined);
    expect(bg.grounds().sections).toBe("light");
    bg.setGround(undefined);
    expect(sections.toJSON()).toBe(VIEW_MARGIN);
  });

  it("lets a background the person sets meanwhile stand, and saves it", () => {
    const sections = colour(VIEW_MARGIN);
    const view3d = colour(undefined);
    const bg = new ViewBackgrounds({ sections, view3d });
    bg.setGround(LIGHT);
    view3d.value = Float32Array.from(rgbOf("#202020"));
    expect(bg.saved()?.view3d).toBe("#202020");
    expect(bg.grounds()).toEqual({ sections: "light", view3d: "dark" });
    bg.setGround(undefined);
    expect(view3d.toJSON()).toBe("#202020");
    expect(sections.toJSON()).toBe(VIEW_MARGIN);
  });
});

describe("the ink drawn over a view", () => {
  it("is read from the stylesheet's tokens where the element is, the dark ground's where there are none", async () => {
    const { viewInk } = await import("../src/sdk/dom.js");
    const loose = document.createElement("canvas");
    expect(viewInk(loose).keyline).toBe("#000");
    const canvas = document.createElement("canvas");
    canvas.setAttribute("style", "--view-ink-keyline: #fff; --dec-x: #c0463a");
    document.body.append(canvas);
    const ink = viewInk(canvas);
    expect(ink.keyline).toBe("#fff");
    expect(ink.axes[0]).toBe("#c0463a");
    expect(ink.line).toBe("#a3a3a3");
    canvas.remove();
  });
});
