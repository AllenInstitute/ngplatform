/**
 * Serves files on this computer as virtual zarr-vectors stores (see
 * ./virtual.ts): a .trk is read once, when its store is first asked for,
 * then every key is made from what was read.
 */
import { serveVirtualStores } from "@ngplatform/sdk/virtual";
import { openTrk } from "./src/virtual/store_trk.js";

serveVirtualStores((file) => openTrk(file, file.name.replace(/\.trk$/i, "")));
