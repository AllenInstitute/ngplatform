import { describe, expect, it } from "vitest";
import { LocalRenderer, OFFSETS } from "../local/local.js";
import params from "../../../runner/ngplatform_render/params.json";
import ref from "./pack_ref.json";

// The service's parameter block (runner/ngplatform_render/renderer.py `_pack`) for a view whose display
// dimensions are a label volume's (1.24 × 1.31 × 1.28 mm), the browser renderer's must be the same.
const view = {
  world_from_physical: [0.809319604909681, 0, 0, 0, 0, 0.7609124066360986, 0, 0, 0, 0, 0.7822819084298437, 0, 0, 0, 0, 1],
  unit_mm: 1.235605802619348,
  inv_view_projection: [123350.2421875, 0, 0, 0, 0, -95114.0390625, 0, 0, -7.465454578399658, 62.21211624145508, 1174923, -4.9769697189331055, 7.534544944763184, -62.78786849975586, -949722, 5.023029804229736],
  width: 834,
  height: 684,
  preset: "HiP-CT brain",
};

describe("the browser renderer's parameters", () => {
  it("match the service's", () => {
    const r = new LocalRenderer() as unknown as { size: number[]; voxelToRas: number[]; grid: number[]; pack: LocalRenderer["pack"] };
    r.size = [246, 291, 236];
    r.voxelToRas = [0.8, 0, 0, -97.62500610351563, 0, 0.8, 0, -133.62500610351563, 0, 0, 0.8, -71.6249984741211, 0, 0, 0, 1];
    r.grid = [31, 37, 30];
    const { P } = r.pack(view as never, 834, 684);
    for (const f of params.fields) {
      if (["FRAME", "STEP", "OPAQUE_LIMIT", "CROP_LO", "CROP_HI"].includes(f.name)) continue;
      const got = Array.from(P.slice(OFFSETS[f.name], OFFSETS[f.name] + f.size));
      const want = (ref as Record<string, number[]>)[f.name];
      got.forEach((g, i) => expect(g, `${f.name}[${i}]`).toBeCloseTo(want[i], Math.abs(want[i]) > 1000 ? -1 : 3));
    }
  });
});
