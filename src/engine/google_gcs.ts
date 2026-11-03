/**
 * Google Cloud Storage read with the Google sign-in of the Auth tab:
 * `gs+google://bucket/path`, as Neuroglancer reads `gs://bucket/path` but
 * with the token in each request.  The scheme is registered here, on the
 * main thread and in Neuroglancer's chunk workers (./workers/chunk_worker.ts),
 * as Neuroglancer registers `gs+ngauth+https://`; the token comes from the
 * credentials provider ./google_credentials.ts registers on the main thread,
 * which the workers ask for by its key.
 */
import type { OAuth2Credentials } from "neuroglancer/unstable/credentials_provider/oauth2.js";
import { fetchOkWithOAuth2CredentialsAdapter } from "neuroglancer/unstable/credentials_provider/oauth2.js";
import type { BaseKvStoreProvider } from "neuroglancer/unstable/kvstore/context.js";
import { GcsKvStore } from "neuroglancer/unstable/kvstore/gcs/index.js";
import { frontendBackendIsomorphicKvStoreProviderRegistry, type SharedKvStoreContextBase } from "neuroglancer/unstable/kvstore/register.js";

export const GOOGLE_SCHEME = "gs+google";
/** The key the credentials provider is registered under. */
export const GOOGLE_CREDENTIALS_KEY = "ngplatform_google";

function googleGcsProvider(context: SharedKvStoreContextBase): BaseKvStoreProvider {
  return {
    scheme: GOOGLE_SCHEME,
    description: "Google Cloud Storage (Google sign-in in the Auth tab)",
    getKvStore(url) {
      const m = (url.suffix ?? "").match(/^\/\/([^/]+)(\/.*)?$/);
      if (m === null) throw new Error(`Invalid URL, expected \`${GOOGLE_SCHEME}://<bucket>/<path>\``);
      const [, bucket, path] = m;
      const credentials = context.credentialsManager.getCredentialsProvider<OAuth2Credentials>(GOOGLE_CREDENTIALS_KEY);
      return {
        store: new GcsKvStore(bucket, `${GOOGLE_SCHEME}://${bucket}/`, fetchOkWithOAuth2CredentialsAdapter(credentials)),
        path: decodeURIComponent((path ?? "").substring(1)),
      };
    },
  };
}

frontendBackendIsomorphicKvStoreProviderRegistry.registerBaseKvStoreProvider(googleGcsProvider);
