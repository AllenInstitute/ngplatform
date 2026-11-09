/**
 * The credentials behind `gs+google://` (./google_gcs.ts): a Google
 * account's token (src/platform/google_auth.ts), registered on the main
 * thread before the viewer exists, under the key the workers ask for.
 *
 * A kvstore asks with its bucket and folder as the provider's parameters,
 * so each answer is for the account the sign-in rules give that folder
 * (else the default account), looked up at each request.  The workers keep
 * an answer until it is refused or `checkAfter` passes (see ./google_gcs.ts),
 * so a rule changed for open data takes effect within seconds.
 *
 * A token refused with 401 marks only its own account expired.  With no
 * token, data waits for that account's sign-in rather than opening a
 * window itself: Neuroglancer's status line says which account to sign in,
 * with a button that does it from the click.
 */
import { type GoogleCredentials, GOOGLE_CREDENTIALS_KEY, type GoogleCredentialsParameters, RECHECK_MS } from "./google_gcs.js";
import { registerDefaultCredentialsProvider } from "neuroglancer/unstable/credentials_provider/default_manager.js";
import { CredentialsProvider } from "neuroglancer/unstable/credentials_provider/index.js";
import { StatusMessage } from "neuroglancer/unstable/status.js";

/** What the credentials need of the Google sign-in and the rules. */
export interface GoogleTokens {
  /** The account that reads an address (`gs://bucket/folder/`): its rule's, else the default (undefined). */
  accountFor(url: string): string | undefined;
  token(account?: string): { accessToken: string; email?: string } | undefined;
  /** A good token of `account` other than `refused`, once it is signed in. */
  waitForToken(account: string | undefined, signal: AbortSignal | undefined, refused?: string): Promise<{ accessToken: string; email?: string }>;
  /** A token a server refused: its account is taken as expired. */
  markInvalid(accessToken: string): void;
  clientId(): string | undefined;
  /** Signs an account in (none: adds one through Google's chooser); called from a click. */
  signIn(account?: string): Promise<unknown>;
}

let generation = 0;

export class GoogleCredentialsProvider extends CredentialsProvider<GoogleCredentials> {
  private readonly url: string;

  constructor(
    private readonly tokens: GoogleTokens,
    parameters: GoogleCredentialsParameters | undefined,
    private readonly now: () => number = Date.now,
  ) {
    super();
    this.url = parameters === undefined ? "" : `gs://${parameters.bucket}/${parameters.path ?? ""}`;
  }

  get = async (
    invalid?: { generation: number; credentials: GoogleCredentials },
    options?: { signal?: AbortSignal },
  ): Promise<{ generation: number; credentials: GoogleCredentials }> => {
    const account = this.tokens.accountFor(this.url);
    const refused = invalid?.credentials.refused === 401 ? invalid.credentials.accessToken : undefined;
    // 401: the token lapsed or was revoked; its account (only) is expired.  403:
    // the account may not read this, which says nothing of its other buckets;
    // "stale": just asking again, for a rule or a sign-in changed meanwhile.
    if (refused !== undefined) this.tokens.markInvalid(refused);
    let token = this.tokens.token(account);
    if (token === undefined || token.accessToken === refused) token = await waitWithStatus(this.tokens, account, this.url, options?.signal, refused);
    return {
      generation: ++generation,
      credentials: { tokenType: "Bearer", accessToken: token.accessToken, email: token.email ?? account, checkAfter: this.now() + RECHECK_MS },
    };
  };
}

/** One status line per account waited for, however many requests wait. */
const waiting = new Map<string, { status: StatusMessage; users: number }>();

async function waitWithStatus(tokens: GoogleTokens, account: string | undefined, url: string, signal: AbortSignal | undefined, refused: string | undefined) {
  const key = account ?? "";
  let entry = waiting.get(key);
  if (entry === undefined) {
    const status = new StatusMessage();
    const who = account === undefined ? "a Google account" : account === "" ? "the Google account signed in before" : account;
    const say = (text: string) => {
      status.setText(text);
      if (tokens.clientId() === undefined) return;
      const button = document.createElement("button");
      button.textContent = account === undefined ? "Sign in with Google" : `Sign in as ${account || "that account"}`;
      button.addEventListener("click", () => {
        tokens.signIn(account || undefined).catch((e) => say(`Google sign-in failed: ${(e as Error).message} `));
      });
      status.element.append(button);
    };
    say(
      refused === undefined
        ? `Data from Google Cloud Storage (${url.replace(/^gs:/, "gs+google:")}…) waits for ${who} to sign in: sign in (Settings → Sign-in). `
        : `The sign-in of ${who} has expired or was refused: sign in again (Settings → Sign-in). `,
    );
    entry = { status, users: 0 };
    waiting.set(key, entry);
  }
  entry.users++;
  try {
    return await tokens.waitForToken(account, signal, refused);
  } finally {
    if (--entry.users === 0) {
      entry.status.dispose();
      waiting.delete(key);
    }
  }
}

export function registerGoogleCredentials(tokens: GoogleTokens): void {
  registerDefaultCredentialsProvider(GOOGLE_CREDENTIALS_KEY, (parameters: GoogleCredentialsParameters | undefined) => new GoogleCredentialsProvider(tokens, parameters));
}
