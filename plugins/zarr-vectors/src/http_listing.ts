/**
 * @license
 * Copyright 2026 Google Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * @file Listing a directory's subdirectories over plain HTTP, for the
 * reader's `httpAccess` when asked to (`{ listing: true }`): a Google Cloud
 * Storage bucket through its JSON API, any other server through the HTML
 * index it gives for a directory (Python's http.server, nginx's autoindex).
 * A mesh's faces that span chunks are found only by listing its link
 * arrays.  Throws when the server gives neither, so the reader probes
 * instead.
 */

/** The subdirectories an HTML directory index links to, as names without the trailing slash. */
export function parseDirectoryIndex(html: string): string[] {
  const out = new Set<string>();
  for (const match of html.matchAll(/href\s*=\s*["']([^"'?#]+)\/["']/gi)) {
    const name = decodeURIComponent(match[1]);
    // Only children: no parent, no absolute or nested paths.
    if (name === "." || name === ".." || name.includes("/") || name.includes(":")) continue;
    out.add(name);
  }
  return [...out];
}

/** A Cloud Storage listing request for the "directories" under `url`, if it is a bucket's. */
export function gcsListUrl(url: string, pageToken?: string): { url: string; prefix: string } | undefined {
  const m = url.match(/^https:\/\/storage\.googleapis\.com\/([^/]+)\/(.*)$/);
  if (m === null) return undefined;
  const prefix = m[2].endsWith("/") ? m[2] : `${m[2]}/`;
  const query = `prefix=${encodeURIComponent(prefix)}&delimiter=%2F&fields=prefixes%2CnextPageToken${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`;
  return { url: `https://storage.googleapis.com/storage/v1/b/${m[1]}/o?${query}`, prefix };
}

/** The subdirectories of the directory at `url`, names without the trailing slash. */
export async function listHttpDirectories(url: string, signal?: AbortSignal): Promise<string[]> {
  const out: string[] = [];
  let page: string | undefined;
  for (let i = 0; i < 100; ++i) {
    const gcs = gcsListUrl(url, page);
    if (gcs === undefined) break;
    const response = await fetch(gcs.url, { signal });
    if (!response.ok) throw new Error(`${url}: listing failed (${response.status})`);
    const json = (await response.json()) as { prefixes?: string[]; nextPageToken?: string };
    for (const p of json.prefixes ?? []) if (p.startsWith(gcs.prefix)) out.push(p.slice(gcs.prefix.length).replace(/\/$/, ""));
    page = json.nextPageToken;
    if (page === undefined) return out.filter((d) => d !== "");
  }
  if (out.length > 0) return out;
  const response = await fetch(url.endsWith("/") ? url : `${url}/`, { signal });
  if (!response.ok || !/html/i.test(response.headers.get("Content-Type") ?? "")) throw new Error(`${url}: no directory index`);
  return parseDirectoryIndex(await response.text());
}
