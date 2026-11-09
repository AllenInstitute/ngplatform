# Signing in

Data behind a sign-in is read with the sign-ins in the **Auth** tab (left
dock). Sign-ins and rules are kept in this browser, never in the link: a
link someone else opens asks them to sign in themselves, and never names
your accounts.

The tab has six parts:

1. **Google accounts**: each Google account signed in here, with its state
   and buttons, and the **Sign in with Google** button that adds one.
2. **Other sign-ins**: the middleauth and ngauth servers (and plugins'
   sign-ins) this workspace uses or that you added, with whether you are
   signed in, as whom, and buttons to sign in, sign out and check.
3. **Rules**: which sign-in, and which Google account, reads the data under
   a bucket, a folder or a web address.
4. **Add a sign-in server**: a CAVE, CATMAID or ngauth server, to sign in
   before opening its data.
5. **Layers in this scene**: each layer of the active scene that reads from
   a bucket or a web server, with a drop-down of the sign-ins that apply to
   it.
6. **Google sign-in**: what the Google sign-in asks for, and its OAuth
   client ID.

## The kinds of sign-in

Neuroglancer chooses how to read a source from the scheme of its address,
so the sign-in a layer uses is part of its source:

| Source | Read with |
|---|---|
| `gs://bucket/path` | nothing: a public Google Cloud Storage bucket |
| `gs+google://bucket/path` | the **Google** sign-in of Settings → Sign-in |
| `gs+ngauth+https://server/bucket/path` | a token from an **ngauth** server |
| `https://host/path` | nothing: a public web server |
| `middleauth+https://host/path` | a **middleauth** sign-in (CAVE, and CATMAID set up for it) |

The rest of a source is kept as it is: a prefix such as `precomputed://` or
`zarr://`, and steps such as `|zarr3:` or `|zarr-vectors:`.

### Google

Signs this browser in to Google with Google's own sign-in window, for the
Google Cloud Storage buckets your accounts can read. Several accounts can
be signed in at once (a work and a personal account, say). It asks for:

| Scope | What it lets this site do |
|---|---|
| `openid` | know it is you |
| `email` | see your email address, to show who is signed in |
| `https://www.googleapis.com/auth/devstorage.read_only` | read the Google Cloud Storage buckets your account can read; never write |

**Sign in with Google** (once an account is signed in, **Add a Google
account**) opens Google's account chooser, where you pick or add the
account. Each account is then listed with its state:

- **Signed in** until the time its token expires (a token lasts about an
  hour);
- **Expired**, with **Sign in again as …**, which goes straight to that
  account (Google usually closes its window at once);
- **Signed out**, with **Sign in as …**.

**Sign out** forgets that account's token and revokes it with Google; the
account stays listed. **Remove** forgets the account. One account is the
**Default**: it reads every bucket that no rule gives another account. The
first account added is the default; **Make default** changes it.

When an account's token expires or Google refuses it, only that account
expires; data it reads waits until you sign it in again: the status line
under the views names the account, with a button that signs it in. A
sign-in window opens only when you click.

The accounts apply to every tab of this site in this browser, and to data
already open: a layer waiting for an account loads as soon as it is signed
in.

### Middleauth (CAVE, CATMAID)

Middleauth is the Google-backed sign-in that CAVE servers, and CATMAID
servers set up for it, use. Its tokens are kept where Neuroglancer keeps
them, so a sign-in made in the tab is the one the viewer uses and the
other way round.

A data server names its sign-in server at `/auth_info`. To sign in before
opening its data, type the data server's address (a CAVE or CATMAID site)
under **Add a sign-in server**, with **Middleauth** chosen: the tab looks
up its sign-in server and lists that. The sign-in server's own address
works too. A server can be removed again with **Remove**.

CATMAID's own API tokens (sent as `X-Authorization: Token …`) are a
different scheme, which neither Neuroglancer nor this tab uses.

### ngauth

An ngauth server signs in with Google and hands out tokens for the Google
Cloud Storage buckets it serves. Add it by its address with **ngauth**
chosen (pasting a whole `gs+ngauth+https://…` source chooses it for you),
or open data that names it. **Sign in** opens the server's login window,
as Neuroglancer does. The server must allow this site's address; when it
does not, the tab says so. Signing out is done on the server's own page.

### Plugins

A plugin can add its own sign-ins, which are listed with the others and
may add choices to the layers' drop-downs. See
[Sign-in](https://github.com/AllenInstitute/ngplatform/blob/main/plugins/README.md#sign-in)
in the plugin guide.

## Rules

A rule gives the data under an address a sign-in. The address is a
bucket, a folder in one, or a web address:

| Address | Covers |
|---|---|
| `gs://bucket/` | everything in the bucket |
| `gs://bucket/folder/` | that folder and everything under it |
| `https://host/` or `https://host/path/` | a web server, or part of one |

The sign-in is **None (public)**, a **Google** account (or **the default
account**), an ngauth server or **Middleauth**, or a plugin's. An address
covers itself and what is under it, folder by folder: `gs://b/data/`
covers `gs://b/data/x.zarr` but not `gs://b/data2/`. When several rules
cover a source, the one with the longest address wins. A typed address is
tidied: `my-bucket` means `gs://my-bucket/`, a trailing `/` is added, and a
whole source pasted (`zarr://gs+google://b/x.zarr|zarr3:`) is reduced to
its address (`gs://b/x.zarr/`).

Rules do two things:

- **When a layer is added, or a workspace is opened**, a source a rule
  covers is given that rule's sign-in, as the layer's drop-down would:
  `gs://b/x` becomes `gs+google://b/x`, so the link says which kind of
  sign-in the layer uses. This is not an undo step of its own: it is part
  of adding the layer or opening the workspace, so one undo takes both
  back. A layer whose sign-in you change afterwards keeps it until the
  workspace is opened again.
- **When data is read**, a `gs+google://` bucket is read with the Google
  account its rule names, else with the default account. The account is
  never in the link. A filtered view of such data is read through the
  app's service worker, which holds the tokens in memory only; when the
  browser stops the idle worker and starts it again, or Google refuses an
  expired token, it asks the open tab for them again.

A rule changed while data is open reaches it within about 15 seconds, or
at once when a request is refused. Data that already failed (a chunk the
old account could not read) loads again with **Reload** (Settings → reload
layers).

To make a rule:

- **+ Rule** in the tab: type the address (it starts from the selected
  layer's bucket), choose the sign-in, **Save rule**.
- **Use for all of …** beside a layer's drop-down: a rule for the layer's
  bucket (or its web server's host) with the sign-in the layer has, applied
  at once to the scene's other layers from there (one undo step).
- Choosing a Google account for a layer (below).

A rule whose sign-in some layers of the scene do not have yet offers
**Apply to N layers here**. **×** removes a rule.

## Choosing a layer's sign-in

Under **Layers in this scene**, each layer has a drop-down:

- for a bucket (`gs://`): **None (public)**, each **Google** account
  signed in here, and each ngauth server listed above;
- for a web server (`https://`): **None (public)** and **Middleauth**.

Choosing **None**, an ngauth server or **Middleauth** rewrites the layer's
source (`gs+google://b/p` to `gs://b/p`, say). It is one undo step, it is
in the link, and the layer stays the same dataset.

Choosing a Google account rewrites the source to `gs+google://` if it is
not already, and sets the rule for the layer's bucket (or the folder rule
that already covers it) to that account, since the account is not in the
link: other layers from the same bucket are then read with that account
too.

When a layer's sign-in differs from its rule's, a line under the drop-down
says so. The **Layer** tab shows the same drop-down and **Use for all of**
under the layer's name. The list follows the active scene.

## Setting up Google sign-in

Google sign-in needs an OAuth client ID registered for the site's address.
Until there is one, the tab shows Google as **Not set up**.

To make one, in the [Google Cloud console](https://console.cloud.google.com/):

1. Choose or create a project.
2. **APIs & Services → OAuth consent screen**: set it up. *External* lets
   any Google account sign in; *Internal* only accounts of your Google
   Workspace organisation. Add the scopes `openid`, `email` and
   `https://www.googleapis.com/auth/devstorage.read_only`. While the app is
   in *Testing*, only the test users listed there can sign in.
3. **APIs & Services → Credentials → Create credentials → OAuth client
   ID**, of type **Web application**.
4. Under **Authorised JavaScript origins**, add each address the site is
   served from:
    - `https://alleninstitute.github.io` (the live site)
    - `http://localhost:5173` (`npm run dev`)
    - `http://localhost:4173` (`npm run preview`)

    No redirect URIs are needed.
5. Create it, and copy the client ID (`…apps.googleusercontent.com`).

The client ID is not a secret. Give it to the site in either of two ways:

- **Built in**, for everyone: set `VITE_GOOGLE_CLIENT_ID` when building,
  for example in a `.env.local` file beside `package.json`:

    ```
    VITE_GOOGLE_CLIENT_ID=1234567890-abc.apps.googleusercontent.com
    ```

    or as an environment variable (a repository variable in the workflow
    that builds the site).

- **In this browser**: paste it under **Google OAuth client ID** in the
  Settings → Sign-in (**Google sign-in setup**) and press **Save**. It replaces the built-in one in this browser;
  saving it empty goes back to the built-in one.

Reading a bucket also needs the account that reads it to be allowed to:
the `storage.objects.get` permission (as the *Storage Object Viewer* role
gives), and `storage.objects.list` to list its folders. When a bucket
refuses an account (403), the error names the account; a rule can give
that bucket another. Neuroglancer reads buckets through the Cloud Storage
JSON API, so the bucket needs no CORS settings.

Nothing more is needed in the console for several accounts: each account
signs in with the same client ID. While the consent screen is in
*Testing*, each account must be one of its test users.
