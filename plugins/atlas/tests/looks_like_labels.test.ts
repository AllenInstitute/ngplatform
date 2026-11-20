import { describe, expect, it } from "vitest";
import { looksLikeLabels } from "../plugin.js";

describe("an image layer that looks like labels", () => {
  it("is told by its name or its store's", () => {
    expect(looksLikeLabels("SRB2026a_supersynth_labels_500um.ome", [])).toBe(true);
    expect(looksLikeLabels("brain", ["zarr://https://host/sub-01_dseg.ome.zarr/"])).toBe(true);
    expect(looksLikeLabels("aparc+aseg", [])).toBe(true);
    expect(looksLikeLabels("Allen atlas", [])).toBe(true);
  });

  it("is not every image", () => {
    expect(looksLikeLabels("cohort_template_N10_100um_MNI_simclip_masked.ome", ["zarr://https://host/cohort_template_N10_100um_MNI_simclip_masked.ome.zarr"])).toBe(false);
    expect(looksLikeLabels("EM", [])).toBe(false);
    expect(looksLikeLabels("vessel", [])).toBe(false);
  });
});
