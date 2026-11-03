# Signing in

Data behind a sign-in is read with the sign-ins in the **Auth** tab (left
dock). Sign-ins are kept in this browser, never in the link: a link someone
else opens asks them to sign in themselves.

The tab has four parts:

1. **Sign-ins**: each one available, with whether you are signed in, as
   whom, and buttons to sign in, sign out and check.
2. **Add a sign-in server**: a CAVE, CATMAID or ngauth server, to sign in
   before opening its data.
3. **Layers in this scene**: each layer of the active scene that reads from
   a bucket or a web server, with a drop-down of the sign-ins that apply to
   it.
4. **Google sign-in**: what the Google sign-in asks for, and its OAuth
   client ID.

## The kinds of sign-in

Neuroglancer chooses how to read a source from the scheme of its address,
so the sign-in a layer uses is part of its source:

| Source | Read with |
|---|---|
| `gs://bucket/path` | nothing: a public Google Cloud Storage bucket |
| `gs+google://bucket/path` | the **Google** sign-in of the Auth tab |
| `gs+ngauth+https://server/bucket/path` | a token from an **ngauth** server |
| `https://host/path` | nothing: a public web server |
| `middleauth+https://host/path` | a **middleauth** sign-in (CAVE, and CATMAID set up for it) |

The rest of a source is kept as it is: a prefix such as `precomputed://` or
`zarr://`, and steps such as `|zarr3:` or `|zarr-vectors:`.

### Google

Signs this browser in to Google with Google's own sign-in window, for the
Google Cloud Storage buckets your account can read. It asks for:

| Scope | What it lets this site do |
|---|---|
| `openid` | know it is you |
| `email` | see your email address, to show who is signed in |
| `https://www.googleapis.com/auth/devstorage.read_only` | read the Google Cloud Storage buckets your account can read; never write |

The token lasts about an hour. The tab shows the account and when the token
expires. After that, data waits until you sign in again: the status line
under the views says so, with a **Sign in** button, and the tab's button
reads **Sign in again**. A sign-in window opens only when you click; Google
usually closes it at once when you have signed in before. **Sign out**
forgets the token and revokes it with Google.

The sign-in applies to every tab of this site in this browser, and to data
already open: a layer waiting for it loads as soon as you sign in.

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

## Choosing a layer's sign-in

Under **Layers in this scene**, each layer has a drop-down:

- for a bucket (`gs://`): **None (public)**, **Google**, and each ngauth
  server listed above;
- for a web server (`https://`): **None (public)** and **Middleauth**.

Choosing one rewrites the layer's source (`gs://b/p` to
`gs+google://b/p`, say). It is one undo step, it is in the link, and the
layer stays the same dataset. The **Layer** tab shows the same drop-down
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
  Auth tab and press **Save**. It replaces the built-in one in this browser;
  saving it empty goes back to the built-in one.

Reading a bucket also needs your account to be allowed to read it: the
`storage.objects.get` permission (as the *Storage Object Viewer* role
gives), and `storage.objects.list` to list its folders. Neuroglancer reads
buckets through the Cloud Storage JSON API, so the bucket needs no CORS
settings.
