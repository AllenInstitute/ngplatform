/**
 * Serves NIfTI images as OME-Zarr stores, off the page's thread (see
 * @ngplatform/sdk/virtual, which data type plugins use for their formats).
 */
import { serveVirtualStores } from "../../sdk/virtual.js";
import { openNifti } from "./nifti.js";

export type { VirtualRequest } from "../../sdk/virtual.js";

serveVirtualStores((file) => openNifti(file, file.name.replace(/\.nii(\.gz)?$/i, "")));
