/**
 * Spherical harmonics against DIPY: the four bases at five directions up to
 * order 8 (tests/fixtures/sh_dipy.json, from dipy.reconst.shm 1.12's
 * real_sh_descoteaux and real_sh_tournier, legacy and not), and the
 * properties the glyphs and the direction colour lean on.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalTerms, coefficientCount, evaluate, evaluateCanonical, evaluateMonomials, fitSh, gfa, legendre, lmaxOf, quadraticForms, SH_BASES, type ShBasis, monomials, shIndices, shMatrix, toCanonical, toMonomials } from "../sh.js";

const dipy = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "sh_dipy.json"), "utf8")) as Record<string, number[][]>;
const KEYS: Record<ShBasis, string> = {
  "descoteaux07-legacy": "descoteaux07_legacy",
  descoteaux07: "descoteaux07",
  tournier07: "tournier07",
  "tournier07-legacy": "tournier07_legacy",
};

describe("spherical harmonic bases", () => {
  it("counts coefficients by order, and back", () => {
    expect([0, 2, 4, 6, 8, 10, 12].map(coefficientCount)).toEqual([1, 6, 15, 28, 45, 66, 91]);
    expect([6, 15, 28, 45].map(lmaxOf)).toEqual([2, 4, 6, 8]);
    expect(lmaxOf(7)).toBeUndefined();
    const idx = shIndices(4);
    expect(idx).toHaveLength(15);
    expect(idx.slice(0, 7)).toEqual([
      { l: 0, m: 0 },
      { l: 2, m: -2 },
      { l: 2, m: -1 },
      { l: 2, m: 0 },
      { l: 2, m: 1 },
      { l: 2, m: 2 },
      { l: 4, m: -4 },
    ]);
  });

  it("has the Condon-Shortley phase in its Legendre functions, as scipy's lpmv", () => {
    const x = 0.3;
    const p = legendre(2, x);
    // P_1^1 = -sqrt(1 - x²), P_2^1 = -3x sqrt(1 - x²), P_2^2 = 3(1 - x²).
    expect(p[1 * 3 + 1]).toBeCloseTo(-Math.sqrt(1 - x * x), 12);
    expect(p[2 * 3 + 1]).toBeCloseTo(-3 * x * Math.sqrt(1 - x * x), 12);
    expect(p[2 * 3 + 2]).toBeCloseTo(3 * (1 - x * x), 12);
    expect(p[2 * 3 + 0]).toBeCloseTo((3 * x * x - 1) / 2, 12);
  });

  for (const [basis] of SH_BASES) {
    it(`matches DIPY's ${basis} to order 8`, () => {
      const dirs = dipy.dirs.flat();
      const ours = shMatrix(basis, 8, dirs);
      const theirs = dipy[KEYS[basis]];
      expect(theirs).toHaveLength(5);
      theirs.forEach((row, r) => row.forEach((v, j) => expect(ours[r * 45 + j], `direction ${r}, coefficient ${j}`).toBeCloseTo(v, 6)));
    });
  }

  it("gives Y_0^0 = 1 / (2 √π) everywhere", () => {
    const m = shMatrix("descoteaux07-legacy", 2, [1, 0, 0, 0, 1, 0, 0.6, 0, 0.8]);
    for (let r = 0; r < 3; ++r) expect(m[r * 6]).toBeCloseTo(0.5 / Math.sqrt(Math.PI), 6);
  });

  it("fits a function back to its coefficients", () => {
    const dirs: number[] = [];
    for (let i = 0; i < 400; ++i) {
      // A spiral of points over the sphere.
      const z = 1 - (2 * (i + 0.5)) / 400;
      const r = Math.sqrt(1 - z * z);
      const phi = i * Math.PI * (3 - Math.sqrt(5));
      dirs.push(r * Math.cos(phi), r * Math.sin(phi), z);
    }
    const truth = Float64Array.from({ length: 15 }, (_, j) => Math.sin(j + 1) / (j + 1));
    const b = shMatrix("tournier07", 4, dirs);
    const values = evaluate(b, 15, truth, 0, new Float32Array(400));
    const fitted = fitSh("tournier07", 4, dirs, values);
    truth.forEach((v, j) => expect(fitted[j]).toBeCloseTo(v, 4));
  });

  it("writes each order-2 term as a quadratic form", () => {
    for (const [basis] of SH_BASES) {
      const forms = quadraticForms(basis);
      const dirs = [0.3, -0.5, 0.81, -0.2, 0.7, 0.4, 0.9, 0.1, -0.2];
      const unit: number[] = [];
      for (let r = 0; r < 3; ++r) {
        const v = dirs.slice(3 * r, 3 * r + 3);
        const n = Math.hypot(v[0], v[1], v[2]);
        unit.push(...v.map((x) => x / n));
      }
      const m = shMatrix(basis, 2, unit);
      for (let r = 0; r < 3; ++r) {
        const d = unit.slice(3 * r, 3 * r + 3);
        forms.forEach((q, j) => {
          let s = 0;
          for (let a = 0; a < 3; ++a) for (let b = 0; b < 3; ++b) s += d[a] * q[3 * a + b] * d[b];
          expect(s, `${basis} term ${j + 1}`).toBeCloseTo(m[r * 6 + j + 1], 6);
        });
        // Traceless: no isotropic part.
        forms.forEach((q) => expect(q[0] + q[4] + q[8]).toBeCloseTo(0, 9));
      }
    }
  });

  it("measures anisotropy: 0 for a sphere, high for a single fibre", () => {
    expect(gfa([1, 0, 0, 0, 0, 0], 0, 6, "descoteaux07")).toBe(0);
    const dirs: number[] = [];
    const values: number[] = [];
    for (let i = 0; i < 600; ++i) {
      const z = 1 - (2 * (i + 0.5)) / 600;
      const r = Math.sqrt(1 - z * z);
      const phi = i * Math.PI * (3 - Math.sqrt(5));
      dirs.push(r * Math.cos(phi), r * Math.sin(phi), z);
      values.push(Math.exp(-20 * (1 - z * z)));
    }
    const c = fitSh("descoteaux07", 8, dirs, values);
    expect(gfa(c, 0, 45, "descoteaux07")).toBeGreaterThan(0.6);
  });
});

describe("the canonical form the ray-cast ODFs evaluate", () => {
  // Directions over the sphere, the poles and the equator among them.
  const dirs: number[] = [0, 0, 1, 0, 0, -1, 1, 0, 0, 0, -1, 0, Math.SQRT1_2, -Math.SQRT1_2, 0, ...dipy.dirs.flat()];
  for (let i = 0; i < 40; ++i) {
    const z = 1 - (2 * (i + 0.5)) / 40;
    const r = Math.sqrt(1 - z * z);
    const phi = i * Math.PI * (3 - Math.sqrt(5));
    dirs.push(r * Math.cos(phi), r * Math.sin(phi), z);
  }
  const rows = dirs.length / 3;

  for (const [basis] of SH_BASES) {
    it(`gives each basis's values (${basis}, orders 0 to 12)`, () => {
      for (let lmax = 0; lmax <= 12; lmax += 2) {
        const n = coefficientCount(lmax);
        const c = Float64Array.from({ length: n }, (_, j) => Math.sin(3.1 * j + 0.7) / (1 + 0.2 * j));
        const truth = evaluate(shMatrix(basis, lmax, dirs), n, c, 0, new Float32Array(rows));
        const canon = new Float32Array(n);
        toCanonical(canonicalTerms(basis, lmax), c, 0, 1, canon, 0);
        for (let r = 0; r < rows; ++r) {
          const v = evaluateCanonical(canon, 0, lmax, dirs[3 * r], dirs[3 * r + 1], dirs[3 * r + 2]);
          expect(Math.abs(v - truth[r]), `lmax ${lmax}, direction ${r}`).toBeLessThan(2e-5 * (1 + Math.abs(truth[r])));
        }
      }
    });
  }

  it("puts every coefficient in its own slot", () => {
    for (const [basis] of SH_BASES) {
      const { index } = canonicalTerms(basis, 8);
      expect(new Set(index).size).toBe(45);
      expect(Math.max(...index)).toBe(44);
    }
  });

  it("is one homogeneous polynomial: the same values from its monomials, in float32 too", () => {
    for (let lmax = 0; lmax <= 12; lmax += 2) {
      const n = coefficientCount(lmax);
      expect(monomials(lmax)).toHaveLength(n);
      for (const [basis] of SH_BASES) {
        // A fibre ODF's sort of coefficients: falling with order.
        const c = Float64Array.from({ length: n }, (_, j) => Math.cos(2.3 * j + 0.4) / (1 + 0.3 * j));
        const truth = evaluate(shMatrix(basis, lmax, dirs), n, c, 0, new Float32Array(rows));
        const canon = new Float64Array(n);
        const { index, factor } = canonicalTerms(basis, lmax);
        index.forEach((k, j) => (canon[k] = c[j] * factor[j]));
        // As the worker sends them: float32.
        const mono = new Float32Array(n);
        toMonomials(lmax, canon, 0, mono, 0);
        let scale = 0;
        for (let r = 0; r < rows; ++r) scale = Math.max(scale, Math.abs(truth[r]));
        for (let r = 0; r < rows; ++r) {
          const v = evaluateMonomials(mono, 0, lmax, dirs[3 * r], dirs[3 * r + 1], dirs[3 * r + 2]);
          expect(Math.abs(v - truth[r]), `${basis} lmax ${lmax}, direction ${r}`).toBeLessThan(1e-4 * scale);
        }
      }
    }
  });
});
