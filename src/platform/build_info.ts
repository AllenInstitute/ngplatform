/**
 * What this build is: the app's version (package.json), the commit and
 * time it was built from, and the Neuroglancer commit it was built against
 * with the one package.json pins (scripts/neuroglancer_pin.mjs).  Vite
 * writes it in at build time (vite.config.ts, `__BUILD_INFO__`); the
 * About section of Settings shows it.
 */

export interface BuildInfo {
  version: string;
  /** This repository's commit, short; "+changes" when the tree had uncommitted changes. */
  commit: string;
  /** When it was built, ISO 8601. */
  date: string;
  neuroglancer: {
    /** The commit of the checkout it was built against. */
    commit: string;
    /** The commit package.json pins. */
    pin: string;
  };
}

declare const __BUILD_INFO__: BuildInfo | undefined;

const UNKNOWN: BuildInfo = { version: "0.0.0", commit: "unknown", date: "", neuroglancer: { commit: "unknown", pin: "unknown" } };

export function buildInfo(): BuildInfo {
  return typeof __BUILD_INFO__ === "object" && __BUILD_INFO__ !== null ? __BUILD_INFO__ : UNKNOWN;
}
