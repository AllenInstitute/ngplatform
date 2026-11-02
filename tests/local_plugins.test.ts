/** Plugins from a URL: which URLs are taken, and the manifest read before anything runs. */
import { describe, expect, it } from "vitest";
import { pluginUrl, readManifestJson } from "../src/platform/local_plugins.js";

describe("plugins from a URL", () => {
  it("takes https URLs, and http only on this computer", () => {
    expect(pluginUrl("https://example.org/p/manifest.json").href).toBe("https://example.org/p/manifest.json");
    expect(pluginUrl("http://127.0.0.1:8000/plugin.js").host).toBe("127.0.0.1:8000");
    expect(pluginUrl("plugins/x/manifest.json", "https://a.org/app/").href).toBe("https://a.org/app/plugins/x/manifest.json");
    expect(() => pluginUrl("http://example.org/plugin.js")).toThrow(/https/);
    expect(() => pluginUrl("javascript:alert(1)")).toThrow(/https/);
    expect(() => pluginUrl("data:text/javascript,1")).toThrow(/https/);
  });

  it("checks the manifest it shows before the code runs", () => {
    const m = readManifestJson('{"id":"a.b","name":"B","version":"1.0.0","kind":"tool","main":"b.js"}');
    expect(m.main).toBe("b.js");
    expect(() => readManifestJson("<html>")).toThrow(/not JSON/);
    expect(() => readManifestJson('{"id":"a.b","name":"B","kind":"tool"}')).toThrow(/version/);
  });
});
