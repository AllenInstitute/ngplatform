/**
 * Saving a label volume: NIfTI-1 (.nii.gz, intent "label") or an OME-Zarr
 * folder.  The OME-Zarr is written from the chunks there are, so a mask on a
 * large grid writes only what is painted (the rest is the fill value, 0);
 * NIfTI holds every voxel, so for a large grid save only the painted box
 * (`crop`), which moves the origin to the box's corner.
 */
import { gzip, niftiFile, omeZarrMetadata } from "../registration/volume_io.js";
import { multiply4 } from "../registration/fit.js";
import { type Box, CHUNK, LabelVolume } from "./label_volume.js";

/** The volume cut to a box (a new volume, placed where the box is). */
export function cropped(volume: LabelVolume, box: Box): LabelVolume {
  const size = [0, 1, 2].map((k) => box.hi[k] - box.lo[k]) as [number, number, number];
  const shift = Float64Array.from([1, 0, 0, box.lo[0], 0, 1, 0, box.lo[1], 0, 0, 1, box.lo[2], 0, 0, 0, 1]);
  const out = new LabelVolume(size, volume.type, multiply4(volume.voxelToRas, shift), volume.name);
  out.load(volume.dense(box));
  return out;
}

/** Bytes a NIfTI of the whole volume would take, before compression. */
export function niftiBytes(volume: LabelVolume): number {
  return volume.size[0] * volume.size[1] * volume.size[2] * (volume.type === "uint8" ? 1 : volume.type === "uint16" ? 2 : 4) + 352;
}

export async function niftiGz(volume: LabelVolume, description = ""): Promise<Uint8Array> {
  const nii = niftiFile({ data: volume.dense(), size: volume.size, type: volume.type, voxelToRas: volume.voxelToRas }, { label: true, description: description.slice(0, 79) });
  return gzip(nii);
}

/** An OME-Zarr (Zarr v3, gzipped chunks) of the volume's pyramid, as files by path; chunks not painted are left out. */
export async function omeZarr(
  volume: LabelVolume,
  description?: string,
  progress?: (done: number, total: number) => void,
  labels: { value: number; name?: string; colour?: string }[] = [],
): Promise<Map<string, Uint8Array>> {
  const files = omeZarrMetadata(volume.levels, volume.type, volume.name, { label: true, chunk: CHUNK, description });
  if (labels.length) {
    // Names and colours as OME-NGFF's label images carry them ("image-label").
    const group = JSON.parse(new TextDecoder().decode(files.get("zarr.json")));
    const rgba = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).concat(255);
    group.attributes.ome["image-label"] = {
      colors: labels.filter((l) => l.colour).map((l) => ({ "label-value": l.value, rgba: rgba(l.colour!) })),
      properties: labels.map((l) => ({ "label-value": l.value, ...(l.name ? { name: l.name } : {}) })),
    };
    files.set("zarr.json", new TextEncoder().encode(JSON.stringify(group, null, 1)));
  }
  const todo: [number, number, number, number][] = [];
  for (let level = 0; level < volume.levels.length; ++level) {
    const seen = new Set<string>();
    for (const key of volume.keys()) {
      const [cx, cy, cz] = volume.coords(key).map((v) => v >> level);
      const id = `${cx}/${cy}/${cz}`;
      if (seen.has(id)) continue;
      seen.add(id);
      todo.push([level, cx, cy, cz]);
    }
  }
  let done = 0;
  for (const [level, cx, cy, cz] of todo) {
    const c = volume.levelChunk(level, cx, cy, cz);
    if (c !== undefined) files.set(`${level}/c/${cz}/${cy}/${cx}`, await gzip(new Uint8Array(c.buffer.slice(c.byteOffset, c.byteOffset + c.byteLength))));
    progress?.(++done, todo.length);
  }
  return files;
}
