/**
 * The Scenes tab: every scene in the workspace.  A scene is a whole view (its
 * datasets, layers, position and layout); switching keeps each scene as it
 * was left, and datasets shared between scenes are not loaded again.
 */
import { layersOf } from "../../core/workspace.js";
import { clear, h, icon, iconButton } from "../dom.js";
import { promptDialog, showMenu } from "../overlays.js";
import type { Workbench } from "../workbench.js";

export function renderScenesPanel(host: HTMLElement, wb: Workbench): () => void {
  const { store } = wb;
  const list = h("div", { class: "list" });
  host.append(
    h(
      "div",
      { class: "panel-head" },
      h("div", { class: "panel-title" }, h("span", { class: "eyebrow" }, "Workspace"), h("span", { class: "scene-name" }, "Scenes")),
      h(
        "div",
        { class: "row-actions" },
        h("button", { class: "btn outline small", type: "button", onclick: () => wb.run("scene.new") }, icon("plus"), "New"),
        h("button", { class: "btn outline small", type: "button", onclick: () => wb.run("scene.duplicate") }, icon("copyplus"), "Copy"),
      ),
    ),
    list,
    h(
      "p",
      { class: "note" },
      "Each scene keeps its own datasets, layers, position and layout. Datasets live in the workspace, so any scene can add one another scene uses.",
    ),
  );

  const render = () => {
    const p = store.state();
    const live = store.ng();
    clear(
      list,
      ...p.scenes.map((scene, index) => {
        const active = scene.id === p.activeScene;
        const count = layersOf(active ? live : (scene.ng ?? {})).length;
        const rename = async () => {
          const name = await promptDialog("Rename scene", "Name", scene.name);
          if (name !== undefined) store.renameScene(scene.id, name);
        };
        const menu = (anchor: HTMLElement | { x: number; y: number }) =>
          showMenu(anchor, [
            { label: "Open", disabled: active, run: () => store.switchScene(scene.id) },
            { label: "Rename…", run: rename },
            {
              label: "Duplicate",
              run: () => {
                store.switchScene(scene.id);
                store.newScene({ copy: true });
              },
            },
            "-",
            { label: "Move up", disabled: index === 0, run: () => store.moveScene(scene.id, index - 1) },
            { label: "Move down", disabled: index === p.scenes.length - 1, run: () => store.moveScene(scene.id, index + 1) },
            "-",
            { label: "Delete scene", danger: true, disabled: p.scenes.length <= 1, run: () => wb.run("scene.delete", { id: scene.id }) },
          ]);
        return h(
          "div",
          {
            class: active ? "ds-row scene selected" : "ds-row scene",
            tabindex: 0,
            role: "button",
            "aria-current": active ? "true" : undefined,
            onclick: () => store.switchScene(scene.id),
            ondblclick: rename,
            onkeydown: (e: Event) => {
              if ((e as KeyboardEvent).key === "Enter") store.switchScene(scene.id);
            },
            oncontextmenu: (e: Event) => {
              e.preventDefault();
              const m = e as MouseEvent;
              menu({ x: m.clientX, y: m.clientY });
            },
          },
          h("span", { class: "ds-icon" }, icon("scene")),
          h("span", { class: "ds-name" }, scene.name),
          h("span", { class: "type" }, `${count} layer${count === 1 ? "" : "s"}`),
          iconButton("more", "More actions", (e) => {
            e.stopPropagation();
            menu(e.currentTarget as HTMLElement);
          }),
        );
      }),
    );
  };
  const off = store.onChange(render);
  render();
  return off;
}
