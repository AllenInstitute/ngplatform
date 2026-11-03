/**
 * Google Cloud Storage read with a Google account of the Auth tab:
 * `gs+google://bucket/path`, as Neuroglancer reads `gs://bucket/path` but
 * with an account's token in each request.  The scheme is registered here,
 * on the main thread and in Neuroglancer's chunk workers
 * (./workers/chunk_worker.ts), as Neuroglancer registers
 * `gs+ngauth+https://`; the token comes from the credentials provider
 * ./google_credentials.ts registers on the main thread, which the workers
 * ask for by its key.
 *
 * Each store asks with its bucket and folder as parameters, so the main
 * thread answers with the account the sign-in rules give that folder.  A
 * request refused with 401 or 403 asks again, saying which (401 expires
 * that account; 403 only means this account may not read it, and a rule
 * changed meanwhile may name another).  An answer is used for RECHECK_MS,
 * then asked for again, so changing a rule reaches data already open.
 */
import type { CredentialsProvider, CredentialsWithGeneration } from "neuroglancer/unstable/credentials_provider/index.js";
import type { OAuth2Credentials } from "neuroglancer/unstable/credentials_provider/oauth2.js";
import type { BaseKvStoreProvider } from "neuroglancer/unstable/kvstore/context.js";
import { GcsKvStore } from "neuroglancer/unstable/kvstore/gcs/index.js";
import { frontendBackendIsomorphicKvStoreProviderRegistry, type SharedKvStoreContextBase } from "neuroglancer/unstable/kvstore/register.js";
import { type FetchOk, fetchOk, HttpError, pickDelay } from "neuroglancer/unstable/util/http_request.js";

export const GOOGLE_SCHEME = "gs+google";
/** The key the credentials provider is registered under. */
export const GOOGLE_CREDENTIALS_KEY = "ngplatform_google";
/** How long a worker uses an answer before asking again (a rule or an account may have changed). */
export const RECHECK_MS = 15_000;

/** What a store asks the credentials for: its bucket and folder (`path/`, "" for the bucket's top). */
export interface GoogleCredentialsParameters {
  bucket: string;
  path?: string;
}

export interface GoogleCredentials extends OAuth2Credentials {
  /** After this (ms since the epoch), ask again before the next request. */
  checkAfter?: number;
  /** Set on credentials handed back as invalid: why. */
  refused?: 401 | 403 | "stale";
}

const MAX_ATTEMPTS = 3;

/** A fetch that adds the account's token, asking again when it is refused or old. */
export function fetchWithGoogle(provider: CredentialsProvider<GoogleCredentials>, now: () => number = Date.now): FetchOk {
  return async (input, init = {}) => {
    let invalid: CredentialsWithGeneration<GoogleCredentials> | undefined;
    for (let attempt = 0; ; ) {
      init.signal?.throwIfAborted();
      if (attempt > 1) await new Promise((resolve) => setTimeout(resolve, pickDelay(attempt - 2)));
      const options = { signal: init.signal ?? undefined, progressListener: init.progressListener };
      let credentials = await provider.get(invalid, options);
      if (invalid === undefined && (credentials.credentials.checkAfter ?? Infinity) < now()) {
        credentials = await provider.get({ generation: credentials.generation, credentials: { ...credentials.credentials, refused: "stale" } }, options);
      }
      const { tokenType, accessToken, email } = credentials.credentials;
      const headers = new Headers(init.headers);
      headers.set("Authorization", `${tokenType} ${accessToken}`);
      try {
        return await fetchOk(input, { ...init, headers });
      } catch (error) {
        if (!(error instanceof HttpError) || (error.status !== 401 && error.status !== 403)) throw error;
        if (error.status === 403) error.message += `  (The Google account ${JSON.stringify(email ?? "")} may not read this: choose another for its bucket in the Auth tab.)`;
        // A 403 for the same token again is final: the account may not read it.
        const again = error.status === 403 && invalid?.credentials.refused === 403 && invalid.credentials.accessToken === accessToken;
        if (again || ++attempt === MAX_ATTEMPTS) throw error;
        invalid = { generation: credentials.generation, credentials: { ...credentials.credentials, refused: error.status as 401 | 403 } };
      }
    }
  };
}

/** The folder of a key, as the credentials are asked for it (`a/b/c.json` → `a/b/`). */
export function folderOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash + 1);
}

function googleGcsProvider(context: SharedKvStoreContextBase): BaseKvStoreProvider {
  return {
    scheme: GOOGLE_SCHEME,
    description: "Google Cloud Storage (a Google account of the Auth tab)",
    getKvStore(url) {
      const m = (url.suffix ?? "").match(/^\/\/([^/]+)(\/.*)?$/);
      if (m === null) throw new Error(`Invalid URL, expected \`${GOOGLE_SCHEME}://<bucket>/<path>\``);
      const [, bucket, path] = m;
      const key = decodeURIComponent((path ?? "").substring(1));
      const parameters: GoogleCredentialsParameters = { bucket, path: folderOf(key) };
      const credentials = context.credentialsManager.getCredentialsProvider<GoogleCredentials>(GOOGLE_CREDENTIALS_KEY, parameters);
      return {
        store: new GcsKvStore(bucket, `${GOOGLE_SCHEME}://${bucket}/`, fetchWithGoogle(credentials)),
        path: key,
      };
    },
  };
}

frontendBackendIsomorphicKvStoreProviderRegistry.registerBaseKvStoreProvider(googleGcsProvider);
