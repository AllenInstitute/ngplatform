/** Opens an image file as its virtual store, by its name: TIFF, NumPy, MGH/MGZ or NIfTI. */
import { MGH_FILE, openMgh } from "./mgh.js";
import { type NiftiStore, openNifti } from "./nifti.js";
import { NPY_FILE, openNpy } from "./npy.js";
import { LABEL_NAME } from "./store.js";
import { openTiff, TIFF_FILE } from "./tiff.js";

export function openImage(file: Blob & { name: string }): Promise<NiftiStore> {
  const label = LABEL_NAME.test(file.name);
  if (TIFF_FILE.test(file.name)) return openTiff(file, file.name.replace(/(\.ome)?\.tiff?$/i, ""));
  if (NPY_FILE.test(file.name)) return openNpy(file, file.name.replace(NPY_FILE, ""));
  if (MGH_FILE.test(file.name)) return openMgh(file, file.name.replace(MGH_FILE, ""), { label });
  return openNifti(file, file.name.replace(/\.(nii(\.gz)?|hdr)$/i, ""), { label });
}
