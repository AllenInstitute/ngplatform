/**
 * Neuroglancer as it is, without the platform around it, but able to read
 * the formats of the data type plugins (zarr-vectors). "Open in Neuroglancer"
 * opens a scene here when it uses such a format; other scenes open in
 * Google's public Neuroglancer.  It reads gs+google:// too, with the
 * Google sign-in made in the app (the same browser keeps it).
 */
import { setupDefaultViewer } from "neuroglancer/unstable/ui/default_viewer_setup.js";
import "./engine/neuroglancer.js";
import { registerGoogleCredentials } from "./engine/google_credentials.js";
import { loadDataTypePlugins } from "./engine/plugins.js";
import { browserGoogleEnvironment, GoogleSignIn } from "./platform/google_auth.js";
import { CATALOGUE } from "../plugins/index.js";

await loadDataTypePlugins(
  CATALOGUE.filter((e) => e.neuroglancer !== undefined).map((e) => ({ id: e.manifest.id, neuroglancer: e.neuroglancer! })),
);
registerGoogleCredentials(new GoogleSignIn(browserGoogleEnvironment(), import.meta.env.VITE_GOOGLE_CLIENT_ID));
setupDefaultViewer();
