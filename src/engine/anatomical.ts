/**
 * Which way up the three cross-section panels show the data.
 *
 * Neuroglancer's panels put +y and +z towards the bottom of the screen
 * ("xy": x right, y down; "xz": x right, z down; "yz": z left, y down).  For
 * data in RAS millimetres (NIfTI, MGH, tractograms, MNI templates) that
 * shows the axial view with anterior at the bottom, the coronal view upside
 * down and the sagittal view on its side.  Neuroimaging viewers (Freeview,
 * FSLeyes, ITK-SNAP) show axial with anterior up, coronal and sagittal with
 * superior up and anterior to the left, and (radiological convention) the
 * patient's right on the screen's left; neurological convention keeps it on
 * the right.  The fork lets the platform set each panel's fixed rotation
 * relative to the shared orientation, so rotating any panel still turns all
 * three together.
 */

export type PanelConvention = "neuroglancer" | "radiological" | "neurological";
export type NamedPanel = "xy" | "xz" | "yz";
type Axis = [number, number, number];

const X: Axis = [1, 0, 0];
const Y: Axis = [0, 1, 0];
const Z: Axis = [0, 0, 1];
const neg = (a: Axis): Axis => [-a[0], -a[1], -a[2]];

/** For each panel, the world directions of the screen's right and down. */
const SCREEN: Record<PanelConvention, Record<NamedPanel, [right: Axis, down: Axis]>> = {
  neuroglancer: { xy: [X, Y], xz: [X, Z], yz: [neg(Z), Y] },
  radiological: { xy: [neg(X), neg(Y)], xz: [neg(X), neg(Z)], yz: [neg(Y), neg(Z)] },
  neurological: { xy: [X, neg(Y)], xz: [X, neg(Z)], yz: [neg(Y), neg(Z)] },
};

/** What each convention is called in menus. */
export const CONVENTION_LABELS: Record<PanelConvention, string> = {
  radiological: "Radiological (as Freeview): anterior and superior up, patient's right on the left",
  neurological: "Neurological: anterior and superior up, patient's right on the right",
  neuroglancer: "Neuroglancer's own: +y and +z down",
};

/**
 * The rotation (a quaternion, x y z w) taking the screen's axes (right,
 * down, into the screen) to the given world directions.
 */
export function screenQuaternion(right: Axis, down: Axis): [number, number, number, number] {
  const n: Axis = [right[1] * down[2] - right[2] * down[1], right[2] * down[0] - right[0] * down[2], right[0] * down[1] - right[1] * down[0]];
  // Columns of the rotation matrix: right, down, n.
  const m = [
    [right[0], down[0], n[0]],
    [right[1], down[1], n[1]],
    [right[2], down[2], n[2]],
  ];
  const trace = m[0][0] + m[1][1] + m[2][2];
  let q: [number, number, number, number];
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    q = [(m[2][1] - m[1][2]) * s, (m[0][2] - m[2][0]) * s, (m[1][0] - m[0][1]) * s, 0.25 / s];
  } else if (m[0][0] > m[1][1] && m[0][0] > m[2][2]) {
    const s = 2 * Math.sqrt(1 + m[0][0] - m[1][1] - m[2][2]);
    q = [0.25 * s, (m[0][1] + m[1][0]) / s, (m[0][2] + m[2][0]) / s, (m[2][1] - m[1][2]) / s];
  } else if (m[1][1] > m[2][2]) {
    const s = 2 * Math.sqrt(1 + m[1][1] - m[0][0] - m[2][2]);
    q = [(m[0][1] + m[1][0]) / s, 0.25 * s, (m[1][2] + m[2][1]) / s, (m[0][2] - m[2][0]) / s];
  } else {
    const s = 2 * Math.sqrt(1 + m[2][2] - m[0][0] - m[1][1]);
    q = [(m[0][2] + m[2][0]) / s, (m[1][2] + m[2][1]) / s, 0.25 * s, (m[1][0] - m[0][1]) / s];
  }
  // One sign for each rotation, so equal rotations compare equal.
  return q[3] < 0 ? (q.map((v) => -v) as typeof q) : q;
}

/** Each panel's fixed rotation in a convention (undefined: none). */
export function panelRotations(convention: PanelConvention): Record<NamedPanel, [number, number, number, number] | undefined> {
  const out = {} as Record<NamedPanel, [number, number, number, number] | undefined>;
  for (const panel of ["xy", "xz", "yz"] as NamedPanel[]) {
    const q = screenQuaternion(...SCREEN[convention][panel]);
    out[panel] = q[3] === 1 ? undefined : q;
  }
  return out;
}

/**
 * The 3-D view's standard orientation in a convention (undefined: as
 * Neuroglancer starts it): the coronal panel's view, from the front with
 * superior up, so radiological shows the patient's right on the screen's
 * left (as one sees a patient facing one), and neurological shows the
 * patient from behind, right on the right.
 */
export function standardView(convention: PanelConvention): [number, number, number, number] | undefined {
  return convention === "neuroglancer" ? undefined : panelRotations(convention).xz;
}

/**
 * Whether a coordinate space reads as anatomy in RAS: spatial axes named
 * x, y and z in units of a micrometre or more (MRI, HiP-CT, light-sheet
 * atlases), as against nanometre electron microscopy, where Neuroglancer's
 * own convention is the expected one.
 */
export function looksAnatomical(names: readonly string[], scales: readonly number[], units: readonly string[]): boolean {
  const xyz = ["x", "y", "z"].map((n) => names.indexOf(n));
  if (xyz.some((i) => i === -1)) return false;
  return xyz.every((i) => units[i] === "m" && scales[i] >= 0.5e-6);
}
