/**
 * The bookmark strip along the 3-D view's bottom edge: a thumbnail per
 * bookmark (a click flies there; the context menu renames, updates or
 * deletes it), then Play.  Shown only while there are bookmarks.
 */
import { el, iconButton, roving } from "@ngplatform/sdk/dom";
import type { Bookmark } from "./state.js";

export interface StripActions {
  go(id: string): void;
  rename(id: string): void;
  update(id: string): void;
  remove(id: string): void;
  play(): void;
}

export class BookmarkStrip {
  readonly element: HTMLElement;
  private readonly list: HTMLElement;
  private playButton: HTMLButtonElement;
  private drawn = "";
  private menu: HTMLElement | undefined;
  private readonly closeMenuOnOutside = (e: Event) => {
    if (this.menu && !this.menu.contains(e.target as Node)) this.closeMenu();
  };

  constructor(private readonly actions: StripActions) {
    this.list = el("div", { class: "view-aids-strip-list", role: "toolbar", "aria-label": "Bookmarks" });
    this.playButton = iconButton("play", "Play the bookmarks in order", () => actions.play());
    this.element = el("div", { class: "view-aids-strip view-aids-control" }, this.list, this.playButton);
    roving(this.list, { items: () => [...this.list.querySelectorAll<HTMLElement>("button")], orientation: "horizontal", tabStop: true });
  }

  /** Shows the bookmarks (drawn again only when they changed), and which is current. */
  update(bookmarks: readonly Bookmark[], current: string | undefined, playing: boolean): void {
    const key = JSON.stringify([bookmarks.map((b) => [b.id, b.name, b.thumbnail?.length ?? 0]), current, playing]);
    if (key === this.drawn) return;
    this.drawn = key;
    const focused = this.list.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.id : undefined;
    this.list.replaceChildren(
      ...bookmarks.map((b, i) => {
        const button = el(
          "button",
          {
            class: `view-aids-thumb${b.id === current ? " current" : ""}`,
            type: "button",
            title: `${b.name}: click to go there; right-click to rename or delete`,
            "aria-label": `Bookmark ${i + 1}: ${b.name}`,
            "aria-current": b.id === current ? "true" : undefined,
            "data-id": b.id,
            onclick: () => this.actions.go(b.id),
          },
          b.thumbnail ? el("img", { src: b.thumbnail, alt: "" }) : el("span", { class: "view-aids-thumb-empty" }),
          el("span", { class: "view-aids-thumb-name" }, b.name),
        ) as HTMLButtonElement;
        button.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          this.openMenu(b.id, button);
        });
        return button;
      }),
    );
    const again = focused ? this.list.querySelector<HTMLElement>(`[data-id="${CSS.escape(focused)}"]`) : null;
    const items = [...this.list.querySelectorAll<HTMLElement>("button")];
    const stop = again ?? items.find((b) => b.dataset.id === current) ?? items[0];
    for (const b of items) b.setAttribute("tabindex", b === stop ? "0" : "-1");
    again?.focus();
    this.playButton.replaceWith(
      (this.playButton = iconButton(playing ? "stop" : "play", playing ? "Stop playing" : "Play the bookmarks in order", () => this.actions.play(), {
        "aria-pressed": playing ? "true" : "false",
      })),
    );
    this.playButton.disabled = bookmarks.length < 2 && !playing;
  }

  private openMenu(id: string, anchor: HTMLElement): void {
    this.closeMenu();
    const item = (label: string, run: () => void, danger = false) =>
      el(
        "button",
        {
          class: `menu-item${danger ? " danger" : ""}`,
          type: "button",
          role: "menuitem",
          tabindex: -1,
          onclick: () => {
            this.closeMenu();
            anchor.focus();
            run();
          },
        },
        label,
      );
    const menu = el(
      "div",
      { class: "menu view-aids-menu view-aids-control", role: "menu", "aria-label": "Bookmark" },
      item("Go to", () => this.actions.go(id)),
      item("Rename…", () => this.actions.rename(id)),
      item("Replace with this view", () => this.actions.update(id)),
      el("div", { class: "menu-sep", role: "separator" }),
      item("Delete", () => this.actions.remove(id), true),
    );
    menu.addEventListener("keydown", (e) => {
      if (e.key === "Escape" || e.key === "Tab") {
        e.preventDefault();
        this.closeMenu();
        anchor.focus();
      }
    });
    roving(menu, { items: () => [...menu.querySelectorAll<HTMLElement>(".menu-item")], orientation: "vertical", typeahead: true });
    document.body.append(menu);
    const rect = anchor.getBoundingClientRect();
    const left = Math.min(rect.left, window.innerWidth - menu.offsetWidth - 8);
    const top = rect.top - menu.offsetHeight - 4 >= 8 ? rect.top - menu.offsetHeight - 4 : Math.min(rect.bottom + 4, window.innerHeight - menu.offsetHeight - 8);
    menu.style.left = `${Math.max(8, left)}px`;
    menu.style.top = `${Math.max(8, top)}px`;
    this.menu = menu;
    menu.querySelector<HTMLElement>(".menu-item")?.focus();
    window.addEventListener("pointerdown", this.closeMenuOnOutside, true);
  }

  private closeMenu(): void {
    this.menu?.remove();
    this.menu = undefined;
    window.removeEventListener("pointerdown", this.closeMenuOnOutside, true);
  }

  dispose(): void {
    this.closeMenu();
    this.element.remove();
  }
}
