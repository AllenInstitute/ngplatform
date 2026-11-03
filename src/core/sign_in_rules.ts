/**
 * Sign-in rules: which sign-in reads the data under an address.  A rule is
 * an address prefix (`gs://bucket/`, `gs://bucket/path/`,
 * `https://host/path/`) and a sign-in (one of ./source_auth.ts's, by id,
 * and for Google the account).  The rule with the longest prefix that
 * covers an address wins.
 *
 * Rules are kept in the browser (src/platform/sign_in_rules.ts), never in
 * a link.  They decide two things: the scheme a source gets when a layer
 * is added or a workspace opens (`gs+google://` for a bucket with a Google
 * rule), and which Google account reads a `gs+google://` bucket.  Pure
 * functions of strings.
 */
import type { SourceSignIn } from "../sdk/types.js";
import { GOOGLE_SIGN_IN, ngauthSignIn, PUBLIC_GS, PUBLIC_HTTP, signInOf, splitSource, withoutSignIn, withSignIn } from "./source_auth.js";

export interface SignInRule {
  /** An address prefix ending in `/`, as `normalisePrefix` gives it. */
  prefix: string;
  /** The sign-in's id: "public", "google", "middleauth", "ngauth:https://server", or a plugin's. */
  signIn: string;
  /** For Google: the account (its email); none means the default account. */
  account?: string;
}

/** Whether an address prefix is for buckets (`gs://`) or web servers (`https://`). */
export function storageOf(prefix: string): "gs" | "http" | undefined {
  if (prefix.startsWith("gs://")) return "gs";
  if (/^https?:\/\//.test(prefix)) return "http";
  return undefined;
}

/**
 * An address as rules compare it: the plain address (no sign-in, no data
 * source prefix, no pipeline), the scheme and host in lower case, without
 * a query.  Undefined when it is not a bucket or web address.
 */
export function plainAddress(url: string, signIns: SourceSignIn[] = []): string | undefined {
  let base = splitSource(url.trim()).base;
  const found = signIns.length > 0 ? signInOf(base, signIns) : undefined;
  base = found?.plain ?? withoutSignIn(base);
  const gs = base.match(/^gs:\/\/([^/?#]+)(\/[^?#]*)?/i);
  if (gs !== null) return `gs://${gs[1].toLowerCase()}${gs[2] ?? "/"}`;
  if (!/^https?:\/\/[^/]/i.test(base)) return undefined;
  try {
    const u = new URL(base);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return undefined;
  }
}

/**
 * A prefix typed in, as a rule keeps it: a plain address ending in `/`.
 * A bare name is a bucket (`my-bucket` → `gs://my-bucket/`); a source with
 * a sign-in or a pipeline is reduced to its plain address
 * (`gs+google://b/p|zarr3:` → `gs://b/p/`).
 */
export function normalisePrefix(text: string): string | undefined {
  let t = text.trim();
  if (t === "") return undefined;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) t = `gs://${t}`;
  const plain = plainAddress(t);
  if (plain === undefined) return undefined;
  return plain.endsWith("/") ? plain : `${plain}/`;
}

/** Whether a rule's prefix covers a plain address: the address is the prefix's folder or under it. */
export function covers(prefix: string, plain: string): boolean {
  return (plain.endsWith("/") ? plain : `${plain}/`).startsWith(prefix);
}

/** The rule for an address (any source URL): the one with the longest prefix that covers it. */
export function ruleFor(rules: readonly SignInRule[], url: string, signIns: SourceSignIn[] = []): SignInRule | undefined {
  const plain = plainAddress(url, signIns);
  if (plain === undefined) return undefined;
  let best: SignInRule | undefined;
  for (const rule of rules) {
    if (covers(rule.prefix, plain) && (best === undefined || rule.prefix.length > best.prefix.length)) best = rule;
  }
  return best;
}

/**
 * The Google account that reads an address: the account its rule names,
 * else the default account (undefined: none yet).
 */
export function googleAccountFor(rules: readonly SignInRule[], url: string, defaultAccount: string | undefined): string | undefined {
  const rule = ruleFor(rules, url);
  return rule?.signIn === GOOGLE_SIGN_IN.id && rule.account !== undefined ? rule.account : defaultAccount;
}

/** The sign-in a rule names, among those offered (an ngauth server not listed is made). */
export function ruleSignIn(rule: SignInRule, signIns: SourceSignIn[]): SourceSignIn | undefined {
  const storage = storageOf(rule.prefix);
  if (rule.signIn === "public") return storage === "gs" ? PUBLIC_GS : storage === "http" ? PUBLIC_HTTP : undefined;
  if (rule.signIn === GOOGLE_SIGN_IN.id) return storage === "gs" ? GOOGLE_SIGN_IN : undefined;
  const listed = signIns.find((s) => s.id === rule.signIn && s.storage === storage);
  if (listed !== undefined) return listed;
  if (storage === "gs" && rule.signIn.startsWith("ngauth:")) return ngauthSignIn(rule.signIn.slice("ngauth:".length));
  return undefined;
}

/** A source URL with the sign-in its rule names, or undefined when no rule changes it. */
export function urlWithRule(url: string, rules: readonly SignInRule[], signIns: SourceSignIn[]): string | undefined {
  const rule = ruleFor(rules, url, signIns);
  if (rule === undefined) return undefined;
  const target = ruleSignIn(rule, signIns);
  if (target === undefined) return undefined;
  const rewritten = withSignIn(url, target, signIns);
  return rewritten === undefined || rewritten === url ? undefined : rewritten;
}

/**
 * A layer's `source` (a URL, `{url, …}`, or a list of them) with each URL a
 * rule covers read with that rule's sign-in; the same object when no rule
 * changes it.
 */
export function sourceWithRules(source: unknown, rules: readonly SignInRule[], signIns: SourceSignIn[]): unknown {
  let changed = false;
  const one = (s: unknown): unknown => {
    if (typeof s === "string") {
      const url = urlWithRule(s, rules, signIns);
      if (url === undefined) return s;
      changed = true;
      return url;
    }
    if (typeof s === "object" && s !== null && typeof (s as { url?: unknown }).url === "string") {
      const url = urlWithRule((s as { url: string }).url, rules, signIns);
      if (url === undefined) return s;
      changed = true;
      return { ...s, url };
    }
    return s;
  };
  const result = Array.isArray(source) ? source.map(one) : one(source);
  return changed ? result : source;
}

/** The prefix "Use for all of" makes for an address: its bucket (`gs://bucket/`) or its host (`https://host/`). */
export function bucketPrefix(url: string, signIns: SourceSignIn[] = []): string | undefined {
  const plain = plainAddress(url, signIns);
  const m = plain?.match(/^([a-z]+:\/\/[^/]+\/)/);
  return m?.[1];
}

// ------------------------------------------------- the service worker's tokens

/**
 * The Google tokens the service worker reads `<app>/gcs-google/<bucket>/<object>`
 * with: the default account's, and one per Google rule naming an account
 * (`prefix`: `bucket/path/`, from the rule's `gs://bucket/path/`).
 */
export interface GoogleTokenTable {
  default: string | null;
  rules: { prefix: string; token: string | null }[];
}

/** The token for an object of a bucket: the longest rule prefix covering it, else the default. */
export function tokenFromTable(table: GoogleTokenTable, bucket: string, object: string): string | null {
  const key = `${bucket.toLowerCase()}/${object}`;
  let best: { prefix: string; token: string | null } | undefined;
  for (const rule of table.rules) {
    if (covers(rule.prefix, key) && (best === undefined || rule.prefix.length > best.prefix.length)) best = rule;
  }
  return best !== undefined ? best.token : table.default;
}

/** The table, from the rules and each account's good token. */
export function googleTokenTable(
  rules: readonly SignInRule[],
  defaultToken: string | undefined,
  tokenOf: (account: string) => string | undefined,
): GoogleTokenTable {
  return {
    default: defaultToken ?? null,
    rules: rules
      .filter((r) => r.signIn === GOOGLE_SIGN_IN.id && r.account !== undefined && r.prefix.startsWith("gs://"))
      .map((r) => ({ prefix: r.prefix.slice("gs://".length), token: tokenOf(r.account!) ?? null })),
  };
}
