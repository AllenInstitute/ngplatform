/**
 * Colour maps for image layers: the Render tab's Colour map menu writes a
 * layer's shader as a contrast control (`#uicontrol invlerp`) and one small
 * GLSL function per map.  Choosing "Custom" leaves the shader alone, and a
 * shader edited by hand shows as Custom.
 *
 * Pure text, no Neuroglancer: tested in Node (tests/colormaps.test.ts).
 *
 * Where the colours come from:
 *  - viridis, magma, inferno, plasma: Nathaniel J. Smith, Stéfan van der Walt
 *    and Eric Firing, released under CC0 (github.com/BIDS/colormap); sampled
 *    at 33 points from matplotlib's tables (within 3/255 of them).
 *  - cividis: Nuñez, Anderton and Renslow (2018), PLOS ONE 13(7): e0199239;
 *    sampled from matplotlib's table (matplotlib licence, BSD style).
 *  - turbo: Anton Mikhailov, Google LLC, Apache-2.0; sampled likewise.
 *  - red-blue: ColorBrewer's RdBu (Cynthia Brewer, Mark Harrower and The
 *    Pennsylvania State University, Apache-2.0).
 *  - cubehelix: Green (2011), Bull. Astr. Soc. India 39, 289, from its formula.
 *  - jet, hot, cool: their usual piecewise-linear definitions.
 *  - heat: FreeSurfer's heat scale as Freeview shows it (min, mid, max of the
 *    magnitude; negative values in blue), written from its description.
 *  - GE colour, NIH, PET: approximations of the scales of those names in
 *    Freeview and MRIcroGL, from a few nodes each; not their exact tables.
 */

export interface ColormapOptions {
  /** The data can be negative (signed integers, float): heat shows negative values in blue. */
  signed?: boolean;
}

export interface Colormap {
  id: string;
  label: string;
  /** The shader for this map, given the contrast directive to keep. */
  shader(invlerp: string, options: ColormapOptions): string;
}

/** Nodes "r g b, r g b, …" (0..1) evenly spaced over 0..1, as a GLSL function of x. */
function piecewise(name: string, nodes: string): string {
  const list = nodes.split(",").map((n) => n.trim().split(/\s+/).map(Number));
  const n = list.length;
  const values = list.map((c) => `vec3(${c.map((v) => fmt(v)).join(", ")})`).join(",\n    ");
  return `vec3 ${name}(float x) {
  const vec3 nodes[${n}] = vec3[${n}](
    ${values});
  float s = clamp(x, 0.0, 1.0) * ${fmt(n - 1)};
  int i = int(min(floor(s), ${fmt(n - 2)}));
  return mix(nodes[i], nodes[i + 1], s - float(i));
}`;
}

function fmt(v: number): string {
  const s = String(Number(v.toFixed(3)));
  return s.includes(".") ? s : `${s}.0`;
}

const hex = (h: string) =>
  [1, 3, 5].map((k) => (parseInt(h.slice(k, k + 2), 16) / 255).toFixed(3)).join(" ");

/** A map that colours normalized() through `fn`, with its definition. */
function mapped(id: string, label: string, definition: string): Colormap {
  return {
    id,
    label,
    shader: (invlerp) => `${invlerp}
// Colour map: ${id}
${definition}
void main() {
  emitRGB(colormap(normalized()));
}
`,
  };
}

const SAMPLED = {
  viridis: "0.267 0.005 0.329, 0.277 0.050 0.376, 0.282 0.095 0.417, 0.283 0.135 0.453, 0.279 0.175 0.483, 0.271 0.213 0.507, 0.259 0.251 0.524, 0.245 0.287 0.537, 0.230 0.321 0.545, 0.215 0.354 0.551, 0.200 0.386 0.555, 0.186 0.417 0.557, 0.173 0.447 0.558, 0.161 0.477 0.558, 0.150 0.506 0.557, 0.138 0.536 0.555, 0.128 0.565 0.551, 0.121 0.594 0.544, 0.120 0.624 0.534, 0.131 0.653 0.521, 0.155 0.682 0.503, 0.193 0.710 0.481, 0.241 0.737 0.455, 0.299 0.762 0.423, 0.363 0.787 0.387, 0.433 0.809 0.345, 0.508 0.829 0.299, 0.587 0.847 0.249, 0.669 0.862 0.195, 0.753 0.875 0.143, 0.836 0.886 0.102, 0.917 0.896 0.101, 0.993 0.906 0.144",
  magma: "0.001 0.000 0.014, 0.014 0.012 0.068, 0.039 0.031 0.133, 0.074 0.052 0.202, 0.112 0.065 0.276, 0.158 0.068 0.351, 0.210 0.062 0.417, 0.264 0.060 0.461, 0.315 0.071 0.485, 0.364 0.090 0.498, 0.413 0.110 0.504, 0.461 0.129 0.508, 0.511 0.147 0.508, 0.560 0.165 0.505, 0.611 0.181 0.499, 0.662 0.197 0.490, 0.713 0.214 0.476, 0.764 0.232 0.459, 0.814 0.254 0.438, 0.860 0.281 0.414, 0.901 0.316 0.390, 0.935 0.361 0.370, 0.959 0.414 0.360, 0.976 0.471 0.363, 0.986 0.530 0.380, 0.992 0.589 0.407, 0.996 0.648 0.442, 0.997 0.706 0.483, 0.997 0.763 0.530, 0.995 0.821 0.580, 0.993 0.878 0.634, 0.990 0.935 0.690, 0.987 0.991 0.750",
  inferno: "0.001 0.000 0.014, 0.014 0.011 0.072, 0.042 0.028 0.141, 0.081 0.043 0.214, 0.128 0.047 0.290, 0.182 0.040 0.354, 0.237 0.037 0.396, 0.289 0.045 0.418, 0.340 0.062 0.429, 0.390 0.080 0.433, 0.439 0.099 0.432, 0.489 0.116 0.426, 0.539 0.134 0.416, 0.588 0.152 0.401, 0.637 0.170 0.382, 0.686 0.191 0.359, 0.733 0.214 0.332, 0.778 0.241 0.302, 0.820 0.273 0.269, 0.858 0.309 0.233, 0.892 0.350 0.197, 0.921 0.395 0.158, 0.945 0.445 0.119, 0.964 0.497 0.078, 0.977 0.553 0.038, 0.985 0.610 0.025, 0.988 0.669 0.060, 0.985 0.730 0.122, 0.976 0.791 0.197, 0.962 0.852 0.287, 0.949 0.911 0.396, 0.952 0.961 0.525, 0.988 0.998 0.645",
  plasma: "0.050 0.030 0.528, 0.132 0.022 0.563, 0.193 0.018 0.590, 0.247 0.014 0.613, 0.299 0.010 0.631, 0.349 0.004 0.646, 0.398 0.001 0.656, 0.446 0.002 0.660, 0.493 0.012 0.658, 0.539 0.034 0.649, 0.583 0.067 0.634, 0.624 0.102 0.612, 0.663 0.137 0.587, 0.700 0.172 0.559, 0.734 0.208 0.530, 0.766 0.243 0.500, 0.796 0.278 0.471, 0.825 0.313 0.443, 0.851 0.349 0.416, 0.877 0.385 0.389, 0.900 0.422 0.362, 0.922 0.460 0.335, 0.941 0.499 0.308, 0.958 0.540 0.281, 0.972 0.582 0.254, 0.983 0.625 0.227, 0.991 0.671 0.201, 0.994 0.718 0.177, 0.993 0.766 0.157, 0.988 0.817 0.144, 0.976 0.868 0.143, 0.959 0.922 0.152, 0.940 0.975 0.131",
  cividis: "0.000 0.135 0.305, 0.000 0.158 0.357, 0.000 0.179 0.414, 0.017 0.198 0.441, 0.102 0.220 0.436, 0.153 0.242 0.430, 0.194 0.264 0.426, 0.230 0.286 0.424, 0.263 0.307 0.423, 0.294 0.329 0.424, 0.323 0.350 0.426, 0.352 0.372 0.430, 0.380 0.394 0.435, 0.407 0.416 0.442, 0.434 0.439 0.451, 0.460 0.461 0.461, 0.487 0.484 0.471, 0.516 0.507 0.473, 0.546 0.530 0.472, 0.576 0.554 0.469, 0.607 0.578 0.464, 0.638 0.602 0.457, 0.669 0.627 0.449, 0.701 0.652 0.438, 0.733 0.678 0.425, 0.766 0.704 0.410, 0.799 0.731 0.392, 0.833 0.759 0.371, 0.867 0.786 0.346, 0.902 0.815 0.317, 0.937 0.844 0.281, 0.973 0.874 0.234, 0.996 0.909 0.218",
  turbo: "0.190 0.072 0.232, 0.225 0.163 0.450, 0.251 0.252 0.632, 0.268 0.337 0.779, 0.276 0.420 0.890, 0.276 0.500 0.965, 0.259 0.578 0.999, 0.215 0.657 0.981, 0.160 0.733 0.925, 0.113 0.803 0.848, 0.093 0.863 0.765, 0.118 0.910 0.690, 0.192 0.947 0.599, 0.299 0.976 0.495, 0.421 0.994 0.391, 0.540 0.999 0.300, 0.638 0.991 0.236, 0.721 0.967 0.207, 0.799 0.928 0.204, 0.870 0.877 0.215, 0.929 0.817 0.226, 0.971 0.752 0.226, 0.992 0.681 0.206, 0.996 0.595 0.172, 0.985 0.502 0.132, 0.961 0.408 0.092, 0.925 0.323 0.058, 0.880 0.252 0.035, 0.823 0.191 0.019, 0.755 0.137 0.009, 0.675 0.089 0.004, 0.583 0.049 0.005, 0.480 0.016 0.011",
};

// ColorBrewer RdBu, 11 classes, blue (low) to red (high).
const RED_BLUE = ["#053061", "#2166ac", "#4393c3", "#92c5de", "#d1e5f0", "#f7f7f7", "#fddbc7", "#f4a582", "#d6604d", "#b2182b", "#67001f"].map(hex).join(", ");

export const COLORMAPS: Colormap[] = [
  {
    id: "grayscale",
    label: "Grayscale",
    // Neuroglancer's own default shader, so a new layer shows as Grayscale.
    shader: (invlerp) => `${invlerp}
void main() {
  emitGrayscale(normalized());
}
`,
  },
  {
    id: "heat",
    label: "Heat (min, mid, max)",
    shader: (invlerp, { signed }) => {
      // The contrast's range is min to max of the magnitude; `mid` is where red turns to yellow.
      const value = signed ? "float raw = float(toRaw(getDataValue()));\n  float t = normalized(abs(toRaw(getDataValue())));" : "float raw = 1.0;\n  float t = normalized();";
      return `${heatInvlerp(invlerp)}
#uicontrol float mid slider(min=0, max=1, default=0.5, step=0.01)
#uicontrol bool opaque checkbox(default=false)
// Colour map: heat
vec3 heat(float t, bool negative) {
  float m = clamp(mid, 0.01, 0.99);
  vec3 low = negative ? vec3(0.0, 0.0, 0.5) : vec3(0.5, 0.0, 0.0);
  vec3 full = negative ? vec3(0.0, 0.0, 1.0) : vec3(1.0, 0.0, 0.0);
  vec3 high = negative ? vec3(0.0, 1.0, 1.0) : vec3(1.0, 1.0, 0.0);
  if (t < m) return mix(low, full, t / m);
  return mix(full, high, clamp((t - m) / (1.0 - m), 0.0, 1.0));
}
void main() {
  ${value}
  // Below min: nothing, so the image underneath shows (as an overlay in Freeview).
  if (t < 0.0) {
    if (opaque) emitRGB(vec3(0.0));
    else emitTransparent();
    return;
  }
  // From min to mid the colour fades in over the image, as Freeview blends it.
  float alpha = opaque ? 1.0 : clamp(t / clamp(mid, 0.01, 0.99), 0.0, 1.0);
  emitRGBA(vec4(heat(t, raw < 0.0), alpha));
}
`;
    },
  },
  mapped(
    "jet",
    "Jet",
    `vec3 colormap(float x) {
  x = clamp(x, 0.0, 1.0);
  return clamp(vec3(1.5) - abs(4.0 * x - vec3(3.0, 2.0, 1.0)), 0.0, 1.0);
}`,
  ),
  mapped("ge", "GE colour", piecewise("colormap", "0 0 0, 0 0.471 0.471, 0.490 0 0.980, 1 0.502 0, 1 1 1")),
  mapped("nih", "NIH", piecewise("colormap", "0 0 0, 0.333 0 0.550, 0 0 0.900, 0 0.750 0.250, 0.900 0.900 0, 1 0.500 0, 1 0 0")),
  mapped("pet", "PET", piecewise("colormap", "0 0 0, 0 0 0.500, 0.500 0 0.500, 1 0 0, 1 0.650 0, 1 1 1")),
  {
    id: "binary",
    label: "Binary colour",
    shader: (invlerp) => `${invlerp}
#uicontrol vec3 colour color(default="#ff3030")
#uicontrol bool shade checkbox(default=false)
// Colour map: binary
void main() {
  // Above the contrast's minimum: one colour (shaded by the value if asked); below it, nothing.
  float t = normalized();
  if (t <= 0.0) {
    emitTransparent();
    return;
  }
  emitRGB(shade ? colour * clamp(t, 0.0, 1.0) : colour);
}
`,
  },
  mapped(
    "hot",
    "Hot",
    `vec3 colormap(float x) {
  x = clamp(x, 0.0, 1.0);
  return clamp(vec3(3.0 * x, 3.0 * x - 1.0, 3.0 * x - 2.0), 0.0, 1.0);
}`,
  ),
  mapped(
    "cool",
    "Cool",
    `vec3 colormap(float x) {
  x = clamp(x, 0.0, 1.0);
  return vec3(x, 1.0 - x, 1.0);
}`,
  ),
  mapped("viridis", "Viridis", piecewise("colormap", SAMPLED.viridis)),
  mapped("magma", "Magma", piecewise("colormap", SAMPLED.magma)),
  mapped("inferno", "Inferno", piecewise("colormap", SAMPLED.inferno)),
  mapped("plasma", "Plasma", piecewise("colormap", SAMPLED.plasma)),
  mapped("cividis", "Cividis", piecewise("colormap", SAMPLED.cividis)),
  mapped("turbo", "Turbo", piecewise("colormap", SAMPLED.turbo)),
  mapped(
    "cubehelix",
    "Cubehelix",
    `vec3 colormap(float x) {
  // Green (2011): start 0.5, rotations -1.5, hue 1, gamma 1.
  x = clamp(x, 0.0, 1.0);
  float angle = 6.2831853 * (0.5 / 3.0 + 1.0 - 1.5 * x);
  float amp = x * (1.0 - x) / 2.0;
  float c = cos(angle);
  float s = sin(angle);
  return clamp(x + amp * vec3(-0.14861 * c + 1.78277 * s, -0.29227 * c - 0.90649 * s, 1.97294 * c), 0.0, 1.0);
}`,
  ),
  mapped("redblue", "Red-blue (diverging)", piecewise("colormap", RED_BLUE)),
];

/** The contrast directive Neuroglancer writes for a new image layer. */
export const DEFAULT_INVLERP = "#uicontrol invlerp normalized";

const INVLERP_LINE = /^#uicontrol\s+invlerp\s+normalized\b.*$/m;

/** The shader's contrast directive, to keep when the map changes (Neuroglancer's default if none). */
export function invlerpOf(shader: string): string {
  return INVLERP_LINE.exec(shader)?.[0].trim() ?? DEFAULT_INVLERP;
}

/** Heat lets values below min through (as -1..0), so its contrast does not clamp. */
function heatInvlerp(invlerp: string): string {
  if (/\bclamp\s*=/.test(invlerp)) return invlerp.replace(/\bclamp\s*=\s*\w+/, "clamp=false");
  if (/\(.*\)\s*$/.test(invlerp)) return invlerp.replace(/\)\s*$/, ", clamp=false)").replace("(, ", "(");
  return `${invlerp}(clamp=false)`;
}

/** The contrast directive without what heat adds, so maps compare alike. */
function plainInvlerp(invlerp: string): string {
  return invlerp.replace(/,?\s*clamp\s*=\s*false/, "").replace(/\(\s*\)$/, "").replace(/\(\s*,\s*/, "(");
}

export function colormapShader(id: string, shader: string, options: ColormapOptions = {}): string | undefined {
  const map = COLORMAPS.find((m) => m.id === id);
  return map?.shader(plainInvlerp(invlerpOf(shader)), options);
}

const normalise = (s: string) =>
  s
    .replace(INVLERP_LINE, "")
    .replace(/\s+/g, " ")
    .trim();

/** Which map wrote this shader, or undefined (Custom) if none did or it was edited since. */
export function colormapOf(shader: string, options: ColormapOptions = {}): string | undefined {
  const text = normalise(shader);
  for (const map of COLORMAPS) {
    const own = map.shader(plainInvlerp(invlerpOf(shader)), options);
    if (normalise(own) === text) return map.id;
  }
  return undefined;
}
