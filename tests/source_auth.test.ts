/**
 * Choosing a layer's sign-in by rewriting its source's scheme, keeping the
 * rest of the source, and dataset keys that ignore the sign-in.
 */
import { describe, expect, it } from "vitest";
import {
  GOOGLE_SIGN_IN,
  MIDDLEAUTH_SIGN_IN,
  ngauthServerOf,
  ngauthSignIn,
  PUBLIC_GS,
  PUBLIC_HTTP,
  signInOf,
  sourceWithSignIn,
  splitSource,
  withoutSignIn,
  withSignIn,
} from "../src/core/source_auth.js";
import { datasetKey, readPlatform } from "../src/core/workspace.js";

const NGAUTH = ngauthSignIn("https://ngauth.example.org");
const ALL = [PUBLIC_GS, PUBLIC_HTTP, GOOGLE_SIGN_IN, MIDDLEAUTH_SIGN_IN, NGAUTH];

describe("source sign-ins", () => {
  it("splits a source around its base address", () => {
    expect(splitSource("precomputed://gs://b/p")).toEqual({ prefix: "precomputed://", base: "gs://b/p", rest: "" });
    expect(splitSource("gs://b/p.zarr/|zarr3:")).toEqual({ prefix: "", base: "gs://b/p.zarr/", rest: "|zarr3:" });
    expect(splitSource("https://host:8080/a|zarr-vectors:")).toEqual({ prefix: "", base: "https://host:8080/a", rest: "|zarr-vectors:" });
    expect(splitSource("graphene://middleauth+https://cave.example.org/seg")).toEqual({ prefix: "graphene://", base: "middleauth+https://cave.example.org/seg", rest: "" });
  });

  it("rewrites gs:// to gs+google:// and gs+ngauth+https:// and back, keeping pipes and prefixes", () => {
    const plain = "gs://b/p.zarr|zarr3:";
    const google = withSignIn(plain, GOOGLE_SIGN_IN, ALL)!;
    expect(google).toBe("gs+google://b/p.zarr|zarr3:");
    const ngauth = withSignIn(google, NGAUTH, ALL)!;
    expect(ngauth).toBe("gs+ngauth+https://ngauth.example.org/b/p.zarr|zarr3:");
    expect(withSignIn(ngauth, GOOGLE_SIGN_IN, ALL)).toBe(google);
    expect(withSignIn(ngauth, PUBLIC_GS, ALL)).toBe(plain);
    expect(withSignIn("precomputed://gs://b/seg", GOOGLE_SIGN_IN)).toBe("precomputed://gs+google://b/seg");
    expect(withSignIn("gs://b/tracts.zarrvectors/|zarr-vectors:", NGAUTH)).toBe("gs+ngauth+https://ngauth.example.org/b/tracts.zarrvectors/|zarr-vectors:");
  });

  it("rewrites https:// to middleauth+https:// and back, and not across kinds of storage", () => {
    expect(withSignIn("zarr://https://cave.example.org/x", MIDDLEAUTH_SIGN_IN)).toBe("zarr://middleauth+https://cave.example.org/x");
    expect(withSignIn("middleauth+https://cave.example.org/x|zarr2:", PUBLIC_HTTP)).toBe("https://cave.example.org/x|zarr2:");
    expect(withSignIn("https://host/x", GOOGLE_SIGN_IN)).toBeUndefined();
    expect(withSignIn("gs://b/x", MIDDLEAUTH_SIGN_IN)).toBeUndefined();
    expect(withSignIn("local://annotations", PUBLIC_HTTP)).toBeUndefined();
  });

  it("finds which sign-in a source uses", () => {
    expect(signInOf("precomputed://gs+google://b/p", ALL)).toMatchObject({ signIn: { id: "google" }, plain: "gs://b/p" });
    expect(signInOf("gs+ngauth+https://ngauth.example.org/b/p", ALL)).toMatchObject({ signIn: { id: "ngauth:https://ngauth.example.org" }, plain: "gs://b/p" });
    expect(signInOf("gs://b/p", ALL)?.signIn).toBe(PUBLIC_GS);
    expect(signInOf("https://h/p", ALL)?.signIn).toBe(PUBLIC_HTTP);
    expect(signInOf("middleauth+https://h/p", ALL)?.signIn).toBe(MIDDLEAUTH_SIGN_IN);
    // An ngauth server not offered: no sign-in of the list.
    expect(signInOf("gs+ngauth+https://other.example.org/b/p", ALL)).toBeUndefined();
    expect(ngauthServerOf("zarr://gs+ngauth+http://localhost:8080/b/p")).toBe("http://localhost:8080");
    expect(signInOf("local://annotations", ALL)).toBeUndefined();
  });

  it("rewrites every URL of a layer's source, in any of its forms", () => {
    expect(sourceWithSignIn("gs://b/p", GOOGLE_SIGN_IN)).toBe("gs+google://b/p");
    expect(sourceWithSignIn({ url: "gs://b/p", transform: { outputDimensions: {} } }, GOOGLE_SIGN_IN)).toEqual({ url: "gs+google://b/p", transform: { outputDimensions: {} } });
    expect(sourceWithSignIn(["gs://b/p", "https://h/q", "local://annotations"], GOOGLE_SIGN_IN)).toEqual(["gs+google://b/p", "https://h/q", "local://annotations"]);
  });

  it("leaves the sign-in out of a dataset's key, in old links too", () => {
    expect(withoutSignIn("precomputed://gs+ngauth+https://ngauth.example.org/b/p")).toBe("precomputed://gs://b/p");
    expect(datasetKey({ source: "gs+google://b/p|zarr3:" })).toBe(datasetKey({ source: "gs://b/p/|zarr3:" }));
    expect(datasetKey({ source: "middleauth+https://h/p" })).toBe("https://h/p");
    const p = readPlatform({ platform: { scenes: [{ id: "s", name: "A" }], activeScene: "s", datasets: [{ id: "d", key: "middleauth+https://h/p", source: "middleauth+https://h/p" }] } });
    expect(p.datasets[0].key).toBe("https://h/p");
  });
});
