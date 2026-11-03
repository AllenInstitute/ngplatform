/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DEFAULT_EXAMPLE?: string;
  /** The Google OAuth client ID for Google sign-in (see docs/guide/signing-in.md). */
  readonly VITE_GOOGLE_CLIENT_ID?: string;
}
