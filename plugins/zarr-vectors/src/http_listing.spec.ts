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

import { describe, expect, it } from "vitest";
import { gcsListUrl, parseDirectoryIndex } from "./http_listing.js";

describe("listing over HTTP", () => {
  it("reads the subdirectories of an HTML directory index", () => {
    // As Python's http.server writes one.
    const html = `<ul>
<li><a href="0_0_1/">0_0_1/</a></li>
<li><a href="-1_0_0/">-1_0_0/</a></li>
<li><a href="zarr.json">zarr.json</a></li>
<li><a href="../">../</a></li>
<li><a href="/elsewhere/">x</a></li>
<li><a href="http://host/a/">x</a></li>
<li><a href="sp%20ace/">sp ace/</a></li>
</ul>`;
    expect(parseDirectoryIndex(html)).toEqual(["0_0_1", "-1_0_0", "sp ace"]);
  });

  it("asks a Cloud Storage bucket for the prefixes under a path", () => {
    const l = gcsListUrl("https://storage.googleapis.com/bucket/a/b.zarrvectors/0/links/0/")!;
    expect(l.prefix).toBe("a/b.zarrvectors/0/links/0/");
    expect(l.url).toBe("https://storage.googleapis.com/storage/v1/b/bucket/o?prefix=a%2Fb.zarrvectors%2F0%2Flinks%2F0%2F&delimiter=%2F&fields=prefixes%2CnextPageToken");
    expect(gcsListUrl("https://storage.googleapis.com/bucket/x", "t")!.url).toContain("&pageToken=t");
    expect(gcsListUrl("http://localhost/x/")).toBeUndefined();
  });
});
