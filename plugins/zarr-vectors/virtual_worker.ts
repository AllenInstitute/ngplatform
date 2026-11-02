/**
 * Serves files on this computer as virtual zarr-vectors stores (see
 * ./virtual.ts): a .trk or .tck is read once, when its store is first
 * asked for, then every key is made from what was read.
 */
import { serveVirtualStores } from "@ngplatform/sdk/virtual";
import { openTractogram } from "./src/virtual/store_trk.js";

serveVirtualStores((file) => openTractogram(file, file.name));
