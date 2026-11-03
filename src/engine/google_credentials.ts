/**
 * The credentials behind `gs+google://` (./google_gcs.ts): the Google
 * sign-in's token (src/platform/google_auth.ts), registered on the main
 * thread before the viewer exists, under the key the workers ask for.
 *
 * With no token, or one Google refused, data waits for a sign-in rather
 * than opening a window itself: Neuroglancer's status line says to sign in
 * with Google in the Auth tab, with a button that does it from the click.
 */
import { GOOGLE_CREDENTIALS_KEY } from "./google_gcs.js";
import { CredentialsProvider, makeCachedCredentialsGetter, type OAuth2Credentials, registerDefaultCredentialsProvider, StatusMessage } from "./neuroglancer.js";

/** What the credentials need of the Google sign-in. */
export interface GoogleTokens {
  token(): { accessToken: string; email?: string } | undefined;
  /** A good token other than `refused`, once the user has signed in. */
  waitForToken(signal: AbortSignal, refused?: string): Promise<{ accessToken: string; email?: string }>;
  clientId(): string | undefined;
  /** Signs in; called from a click. */
  signIn(): Promise<void>;
}

class GoogleCredentialsProvider extends CredentialsProvider<OAuth2Credentials> {
  private generation = 0;

  constructor(private readonly tokens: GoogleTokens) {
    super();
  }

  get = makeCachedCredentialsGetter<OAuth2Credentials>(async (invalid, options) => {
    const refused = invalid?.credentials.accessToken;
    let token = this.tokens.token();
    if (token === undefined || token.accessToken === refused) token = await waitWithStatus(this.tokens, options.signal, refused);
    return { generation: ++this.generation, credentials: { tokenType: "Bearer", accessToken: token.accessToken, email: token.email } };
  });
}

async function waitWithStatus(tokens: GoogleTokens, signal: AbortSignal, refused: string | undefined) {
  const status = new StatusMessage();
  const say = (text: string) => {
    status.setText(text);
    if (tokens.clientId() === undefined) return;
    const button = document.createElement("button");
    button.textContent = "Sign in";
    button.addEventListener("click", () => {
      tokens.signIn().catch((e) => say(`Google sign-in failed: ${(e as Error).message} `));
    });
    status.element.append(button);
  };
  say(
    refused === undefined
      ? "Data from Google Cloud Storage (gs+google://) waits for a sign-in: sign in with Google in the Auth tab. "
      : "The Google sign-in has expired or was refused: sign in with Google in the Auth tab. ",
  );
  try {
    return await tokens.waitForToken(signal, refused);
  } finally {
    status.dispose();
  }
}

export function registerGoogleCredentials(tokens: GoogleTokens): void {
  registerDefaultCredentialsProvider(GOOGLE_CREDENTIALS_KEY, () => new GoogleCredentialsProvider(tokens));
}
