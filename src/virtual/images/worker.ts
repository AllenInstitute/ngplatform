/**
 * Serves NIfTI images, FreeSurfer volumes and TIFF stacks as OME-Zarr stores, off the page's thread (see
 * @ngplatform/sdk/virtual, which data type plugins use for their formats).
 */
import { serveVirtualStores } from "../../sdk/virtual.js";
import { openImage } from "./open.js";

export type { VirtualRequest } from "../../sdk/virtual.js";

serveVirtualStores((file, related) => openImage(file, related));
