/**
 * Neuroglancer as it is, without the platform around it, but able to read
 * the formats of the data type plugins (zarr-vectors). "Open in Neuroglancer"
 * opens a scene here when it uses such a format; other scenes open in
 * Google's public Neuroglancer.  It reads gs+google:// too, with the
 * Google accounts signed in in the app and its sign-in rules (the same
 * browser keeps them).
 */
import { setupDefaultViewer } from "neuroglancer/unstable/ui/default_viewer_setup.js";
import "./engine/neuroglancer.js";
import { registerGoogleCredentials } from "./engine/google_credentials.js";
import { loadDataTypePlugins } from "./engine/plugins.js";
import { browserGoogleEnvironment, GoogleSignIn, googleTokens } from "./platform/google_auth.js";
import { SignInRules } from "./platform/sign_in_rules.js";
import { CATALOGUE } from "../plugins/index.js";

// A plugin that fails to load is left out; Neuroglancer opens without its format.
const failed = await loadDataTypePlugins(
  CATALOGUE.filter((e) => e.neuroglancer !== undefined).map((e) => ({ id: e.manifest.id, neuroglancer: e.neuroglancer! })),
);
for (const [id, error] of failed) console.error(`${id} could not load:`, error);
const googleEnvironment = browserGoogleEnvironment();
registerGoogleCredentials(
  googleTokens(new GoogleSignIn(googleEnvironment, import.meta.env.VITE_GOOGLE_CLIENT_ID), new SignInRules(localStorage, googleEnvironment.onStorage)),
);
setupDefaultViewer();
