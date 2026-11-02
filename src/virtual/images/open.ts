/** Opens an image file as its virtual store, by its name: TIFF, MGH/MGZ or NIfTI. */
import { MGH_FILE, openMgh } from "./mgh.js";
import { type NiftiStore, openNifti } from "./nifti.js";
import { openTiff, TIFF_FILE } from "./tiff.js";

export function openImage(file: Blob & { name: string }): Promise<NiftiStore> {
  if (TIFF_FILE.test(file.name)) return openTiff(file, file.name.replace(/(\.ome)?\.tiff?$/i, ""));
  if (MGH_FILE.test(file.name)) return openMgh(file, file.name.replace(MGH_FILE, ""));
  return openNifti(file, file.name.replace(/\.(nii(\.gz)?|hdr)$/i, ""));
}
