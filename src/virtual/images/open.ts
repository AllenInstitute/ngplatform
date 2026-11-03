/** Opens an image file as its virtual store, by its name: TIFF, NumPy, MGH/MGZ or NIfTI. */
import { MGH_FILE, openMgh } from "./mgh.js";
import { type NiftiStore, openNifti } from "./nifti.js";
import { NPY_FILE, openNpy } from "./npy.js";
import { FilteredStore, parseFilterName } from "./filters.js";
import { LABEL_NAME, type VirtualStore } from "./store.js";
import { openTiff, TIFF_FILE } from "./tiff.js";
import { openVzip } from "../refkv/store.js";

export const VZIP_FILE = /\.vzip$/i;

/**
 * A filtered view of an image is a file named `<image's file name>~<filter>.vfilter`
 * holding the image's own bytes: opened as the image, filtered on the fly (filters.ts).
 */
export const FILTER_FILE = /^(.*)~([^~]+)\.vfilter$/;

export async function openImage(file: Blob & { name: string }, related: Record<string, File> = {}): Promise<VirtualStore & { name: string }> {
  // A Zarr hierarchy in a refkv vzip archive, its references read from the files beside it.
  if (VZIP_FILE.test(file.name)) return openVzip(file, related);
  const filtered = FILTER_FILE.exec(file.name);
  if (filtered !== null) {
    // A Blob, not a File: no date of its own, so nothing kept between visits under it.
    const source = await openImage(Object.assign(file.slice(), { name: filtered[1] }));
    return FilteredStore.open(source, parseFilterName(filtered[2]), `${source.name} (${filtered[2].split("-")[0]})`);
  }
  return openUnfiltered(file);
}

function openUnfiltered(file: Blob & { name: string }): Promise<NiftiStore> {
  const label = LABEL_NAME.test(file.name);
  if (TIFF_FILE.test(file.name)) return openTiff(file, file.name.replace(/(\.ome)?\.tiff?$/i, ""));
  if (NPY_FILE.test(file.name)) return openNpy(file, file.name.replace(NPY_FILE, ""));
  if (MGH_FILE.test(file.name)) return openMgh(file, file.name.replace(MGH_FILE, ""), { label });
  return openNifti(file, file.name.replace(/\.(nii(\.gz)?|hdr)$/i, ""), { label });
}
