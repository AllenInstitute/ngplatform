/**
 * Volume meshes: a links family whose records are solid cells (format
 * 0.10's `element`: zarr-vectors-py's `zarr_vectors/core/elements.py`),
 * drawn as their boundary, the faces that belong to one cell only, wound
 * outward. That is the surface of the solid, which is all Neuroglancer's
 * meshes and the path tracers draw.
 */

/** The volume elements, and the vertices each has. */
export const ELEMENT_WIDTH = { tetra: 4, pyramid: 5, wedge: 6, hexahedron: 8 } as const;
export type VolumeElement = keyof typeof ELEMENT_WIDTH;

/** Each element's faces in VTK order, each with an outward right-hand normal (as elements.py's ELEMENT_FACES). */
export const ELEMENT_FACES: Record<VolumeElement, readonly (readonly number[])[]> = {
  tetra: [[0, 1, 3], [1, 2, 3], [2, 0, 3], [0, 2, 1]],
  pyramid: [[0, 3, 2, 1], [0, 1, 4], [1, 2, 4], [2, 3, 4], [3, 0, 4]],
  wedge: [[0, 1, 2], [3, 5, 4], [0, 3, 4, 1], [1, 4, 5, 2], [2, 5, 3, 0]],
  hexahedron: [[0, 4, 7, 3], [1, 2, 6, 5], [0, 1, 5, 4], [3, 7, 6, 2], [0, 3, 2, 1], [4, 5, 6, 7]],
};

/** A links family's `element` as this reader takes it: a known element whose width is the family's; else undefined. */
export function volumeElement(element: unknown, linkWidth: number): VolumeElement | undefined {
  if (typeof element !== "string" || !(element in ELEMENT_WIDTH)) return undefined;
  const e = element as VolumeElement;
  return ELEMENT_WIDTH[e] === linkWidth ? e : undefined;
}

/**
 * The boundary of the cells `cells` (`ELEMENT_WIDTH[element]` corners each, as numbers the caller knows them by) as
 * triangles, wound outward: the faces no other cell of `cells` shares (quads split in two).
 *
 * `key` names a corner the same wherever it is met (in a chunk, its own vertices and those of neighbours differ);
 * `emit`, when given, says which faces this caller draws: a chunk draws a face only if it is the one to (so a face
 * met by two chunks is drawn once), and must then hold every cell that shares it.
 */
export function boundaryTriangles(
  cells: ArrayLike<number>,
  element: VolumeElement,
  key: (corner: number) => string | number = (c) => c,
  emit?: (corners: readonly number[]) => boolean,
): number[] {
  const width = ELEMENT_WIDTH[element];
  const faces = ELEMENT_FACES[element];
  const count = new Map<string, number>();
  const nameOf = (corners: readonly number[]) => corners.map(key).map(String).sort().join("|");
  for (let c = 0; c + width <= cells.length; c += width) {
    for (const face of faces) {
      const name = nameOf(face.map((i) => cells[c + i]));
      count.set(name, (count.get(name) ?? 0) + 1);
    }
  }
  const out: number[] = [];
  for (let c = 0; c + width <= cells.length; c += width) {
    for (const face of faces) {
      const corners = face.map((i) => cells[c + i]);
      if (count.get(nameOf(corners)) !== 1 || (emit !== undefined && !emit(corners))) continue;
      for (let i = 1; i + 1 < corners.length; ++i) out.push(corners[0], corners[i], corners[i + 1]);
    }
  }
  return out;
}
