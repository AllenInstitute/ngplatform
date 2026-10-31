/** The platform's built-in contributions: examples, the Source section, zarr-vectors facts. */
import { copyText, toast } from "../ui/overlays.js";
import { h } from "../ui/dom.js";
import { kindLabel, shortSource } from "../ui/panels/format.js";
import type { Workbench } from "../ui/workbench.js";
import { EXAMPLES } from "./examples.js";
import { ZARR_VECTORS_MANIFEST, zarrVectorsPlugin } from "./zarr_vectors.js";

export function registerBuiltins(wb: Workbench): void {
  for (const example of EXAMPLES) wb.examples.add({ ...example, owner: "core" });

  wb.inspector.addSection({
    id: "core.source",
    title: "Source",
    order: 10,
    owner: "core",
    render: (host, { dataset, layer }) => {
      if (layer === undefined) return;
      const rows: [string, string][] = [
        ["Dataset", dataset?.name ?? "–"],
        ["Type", kindLabel(layer.type)],
        ["Layer", layer.name],
        ["State", layer.error !== undefined ? "failed" : layer.ready ? "ready" : "loading"],
      ];
      host.append(
        h("dl", { class: "facts" }, ...rows.flatMap(([k, v]) => [h("dt", {}, k), h("dd", {}, v)])),
        ...layer.sources.map((source) =>
          h(
            "div",
            { class: "source-line" },
            h("code", { title: source }, shortSource(source)),
            h(
              "button",
              {
                class: "btn small",
                type: "button",
                onclick: async () => {
                  if (await copyText(source, "the source")) toast("Source URL copied.");
                },
              },
              "Copy",
            ),
          ),
        ),
      );
    },
  });

  wb.plugins.register(ZARR_VECTORS_MANIFEST, async () => zarrVectorsPlugin, { builtin: true });
}
