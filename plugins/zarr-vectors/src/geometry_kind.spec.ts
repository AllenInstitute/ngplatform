/**
 * @license
 * Copyright 2026 Google Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { describe, expect, it } from "vitest";
import {
  curvatureShader,
  DIRECTION_SHADER,
  KIND_CAPABILITIES,
  positionAttribute,
  resolveGeometryKind,
} from "./geometry_kind.js";
import { surfaceDefaults, surfaceInfo } from "./store.js";

describe("KIND_CAPABILITIES", () => {
  it("draws point clouds as points and meshes as triangles", () => {
    expect(KIND_CAPABILITIES.point_cloud.primitive).toBe("points");
    expect(KIND_CAPABILITIES.mesh.primitive).toBe("triangles");
    for (const kind of [
      "line",
      "streamline",
      "polyline",
      "skeleton",
      "graph",
    ] as const) {
      expect(KIND_CAPABILITIES[kind].primitive).toBe("lines");
    }
  });

  it("gives every line kind a tangent, and nothing else one", () => {
    for (const [kind, c] of Object.entries(KIND_CAPABILITIES)) {
      expect(c.tangent !== undefined, kind).toBe(c.primitive === "lines");
    }
    expect(KIND_CAPABILITIES.streamline.tangent).toBe("walk");
    expect(KIND_CAPABILITIES.skeleton.tangent).toBe("edges");
    expect(KIND_CAPABILITIES.graph.tangent).toBe("edges");
  });

  it("defaults to colour-by-direction only where a tangent exists and means something", () => {
    for (const [kind, c] of Object.entries(KIND_CAPABILITIES)) {
      if (c.directionDefault) expect(c.tangent, kind).toBeDefined();
    }
    // A tree's tangent sign is arbitrary per branch; its users colour by object.
    expect(KIND_CAPABILITIES.skeleton.directionDefault).toBe(false);
    expect(KIND_CAPABILITIES.streamline.directionDefault).toBe(true);
  });

  it("colours by direction without a swizzle an attribute could shadow", () => {
    expect(DIRECTION_SHADER).toContain("prop_tangent()");
    expect(DIRECTION_SHADER).not.toMatch(/\.[xyzrgb]{1,3}\b/);
  });
});

describe("resolveGeometryKind", () => {
  it("takes the one declared kind", () => {
    expect(
      resolveGeometryKind(["streamline"], { present: false, width: undefined }),
    ).toEqual({ kind: "streamline", ignored: [] });
  });

  it("prefers the declared kind the links agree with", () => {
    // A failed add_geometry() leaves a second, empty type declared.
    expect(
      resolveGeometryKind(["mesh", "graph"], { present: true, width: 2 }),
    ).toEqual({ kind: "graph", ignored: ["mesh"] });
    expect(
      resolveGeometryKind(["graph", "point_cloud"], {
        present: false,
        width: undefined,
      }),
    ).toEqual({ kind: "point_cloud", ignored: ["graph"] });
  });

  it("falls back to the first known kind when none agrees", () => {
    expect(
      resolveGeometryKind(["unknown", "mesh"], {
        present: false,
        width: undefined,
      }).kind,
    ).toBe("mesh");
  });

  it("rejects a store with no known kind", () => {
    expect(() =>
      resolveGeometryKind(["volume"], { present: false, width: undefined }),
    ).toThrow(/no recognised geometry type/);
  });
});

describe("surfaces", () => {
  const attributes = [
    { id: "curv", components: 1 },
    { id: "coords_inflated", components: 3 },
    { id: "coords_bad", components: 1 },
  ];

  it("draws vertices at the vec3 attribute a shader names", () => {
    expect(positionAttribute("void main() {}", attributes)).toBe(-1);
    expect(positionAttribute("// x\n#define ZV_POSITION coords_inflated\nvoid main() {}", attributes)).toBe(1);
    // Only a vec3 can place vertices.
    expect(positionAttribute("#define ZV_POSITION coords_bad\n", attributes)).toBe(-1);
    expect(positionAttribute("#define ZV_POSITION missing\n", attributes)).toBe(-1);
  });

  it("starts a surface with curvature, outlines in the layer's colour", () => {
    expect(curvatureShader("curv")).toMatch(/prop_curv\(\) > 0\.0/);
    expect(curvatureShader("curv")).toMatch(/#ifdef ZV_SECTION\n  \/\/.*\n  emitDefault\(\);/);
  });

  it("shows a surface store's most wanted maps first, never the join key", () => {
    const info = surfaceInfo({
      attributes: {
        geometry: "white",
        alternates: { coords_pial: "pial", coords_inflated: "inflated", coords_sphere: "sphere" },
        scalars: { thickness: "lh.thickness", curv: "lh.curv", jacobian_white: "x", area: "a", sulc: "s" },
        label_tables: { aparc: { "-1": { name: "unassigned", rgba: [0, 0, 0, 0] }, "0": { name: "unknown", rgba: [0.1, 0, 0.1, 1] } } },
      },
    })!;
    expect(info.maps).toEqual(["thickness", "curv", "jacobian_white", "area", "sulc", "aparc"]);
    expect(info.labelTables.aparc.map((l) => l.code)).toEqual([-1, 0]);
    const names = ["aparc", "area", "coords_inflated", "coords_pial", "coords_sphere", "curv", "jacobian_white", "sulc", "thickness", "zv_join_key"];
    expect(surfaceDefaults(names, info)).toEqual(["curv", "sulc", "thickness", "area", "aparc", "coords_inflated", "coords_pial", "coords_sphere", "jacobian_white"]);
    expect(surfaceInfo(undefined)).toBeUndefined();
  });
});
