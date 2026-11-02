/**
 * Serves NIfTI images and TIFF stacks as OME-Zarr stores, off the page's thread (see
 * @ngplatform/sdk/virtual, which data type plugins use for their formats).
 */
import { serveVirtualStores } from "../../sdk/virtual.js";
import { openNifti } from "./nifti.js";
import { openTiff, TIFF_FILE } from "./tiff.js";

export type { VirtualRequest } from "../../sdk/virtual.js";

serveVirtualStores((file) =>
  TIFF_FILE.test(file.name) ? openTiff(file, file.name.replace(/(\.ome)?\.tiff?$/i, "")) : openNifti(file, file.name.replace(/\.(nii(\.gz)?|hdr)$/i, "")),
);
