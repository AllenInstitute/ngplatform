/**
 * Serves files on this computer as virtual zarr-vectors stores (see
 * ./virtual.ts): a tractogram is read once, when its store is first
 * asked for, then every key is made from what was read.
 */
import { serveVirtualStores } from "@ngplatform/sdk/virtual";
import { openTractogram } from "./src/virtual/tractograms.js";

serveVirtualStores((file) => openTractogram(file, file.name));
