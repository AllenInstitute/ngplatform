/**
 * Small shared helpers: the SDK's text and source helpers, 4 × 4 matrices,
 * the panels' formatting, export kinds, the zip writer, and `el` (against a
 * stand-in document).
 */
import { afterEach, describe, expect, it } from "vitest";
import { apply4, identity4, invert4, multiply4 } from "../src/core/mat4.js";
import { crc32, zipStore } from "../src/core/zip.js";
import { button, downloadBlob, el, safeFileName, select, svgEl } from "../src/sdk/dom.js";
import { bytesText, csv, csvField, mmText, ticks } from "../src/sdk/format.js";
import { layerSourceUrl, precomputedUrl } from "../src/sdk/sources.js";
import { fmt, kindLabel, length, physical, shortSource } from "../src/ui/panels/format.js";
import { exportKind } from "../src/virtual/out/kinds.js";
import { zipFiles } from "../src/virtual/out/volume.js";

describe("text", () => {
  it("quotes CSV fields only when they need it", () => {
    expect(csvField("plain")).toBe("plain");
    expect(csvField("a,b")).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField("two\nlines")).toBe('"two\nlines"');
    expect(csvField("carriage\rreturn")).toBe('"carriage\rreturn"');
    expect(csv([["id", "name"], [1, "x, y"], [Number.NaN, ""]])).toBe('id,name\n1,"x, y"\n,\n');
  });

  it("chooses round ticks, steady against rounding", () => {
    expect(ticks(0, 1, 4)).toEqual([0, 0.5, 1]);
    expect(ticks(0, 1, 5)).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
    // 0.3 / 3 is 0.09999999999999999: still a step of 0.1, and 0.3 itself included.
    expect(ticks(0, 0.3, 3)).toEqual([0, 0.1, 0.2, 0.3]);
    expect(ticks(-5, 5, 2)).toEqual([-5, 0, 5]);
    expect(ticks(2, 2)).toEqual([2]);
  });

  it("writes lengths and sizes readably", () => {
    expect(mmText(1)).toBe("1 mm");
    expect(mmText(1.256)).toBe("1.26 mm");
    expect(mmText(0.25)).toBe("250 µm");
    expect(bytesText(512)).toBe("1 KB");
    expect(bytesText(1536)).toBe("2 KB");
    expect(bytesText(350 * 2 ** 20)).toBe("350 MB");
    expect(bytesText(2 * 2 ** 30)).toBe("2.0 GB");
    expect(bytesText(1.5 * 2 ** 40)).toBe("1.5 TB");
  });

  it("makes file names of layer names", () => {
    expect(safeFileName("My layer (v2)/x")).toBe("My_layer_v2_x");
    expect(safeFileName("  ", "image")).toBe("image");
    expect(safeFileName("a.b-c")).toBe("a.b-c");
  });
});

describe("sources", () => {
  it("finds a precomputed source's http address", () => {
    expect(precomputedUrl("precomputed://gs://bucket/path")).toBe("https://storage.googleapis.com/bucket/path/");
    expect(precomputedUrl("precomputed://s3://bucket/a/|neuroglancer-precomputed:")).toBe("https://bucket.s3.amazonaws.com/a/");
    expect(precomputedUrl("precomputed://https://h/x/")).toBe("https://h/x/");
    expect(precomputedUrl("zarr://https://h/x")).toBeUndefined();
    expect(precomputedUrl(undefined)).toBeUndefined();
  });

  it("reads a layer's first source in any of the spec's forms", () => {
    expect(layerSourceUrl({ source: "zarr://a" })).toBe("zarr://a");
    expect(layerSourceUrl({ source: ["zarr://a", "zarr://b"] })).toBe("zarr://a");
    expect(layerSourceUrl({ source: { url: "zarr://c", transform: {} } })).toBe("zarr://c");
    expect(layerSourceUrl({ source: [{ url: "zarr://d" }] })).toBe("zarr://d");
    expect(layerSourceUrl({})).toBeUndefined();
    expect(layerSourceUrl(undefined)).toBeUndefined();
  });
});

describe("4 × 4 matrices", () => {
  const m = Float64Array.from([2, 0, 0, 10, 0, 0, 3, 20, 0, -1, 0, 30, 0, 0, 0, 1]);
  it("multiplies, applies and inverts", () => {
    expect([...multiply4(identity4(), m)]).toEqual([...m]);
    expect(apply4(m, [1, 2, 3])).toEqual([12, 29, 28]);
    const back = apply4(invert4(m), apply4(m, [1, 2, 3]));
    back.forEach((v, k) => expect(v).toBeCloseTo([1, 2, 3][k], 12));
    expect([...multiply4(m, invert4(m))].map((v) => Math.round(v * 1e12) / 1e12 + 0)).toEqual([...identity4()]);
  });

  it("refuses a singular matrix", () => {
    expect(() => invert4(Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]))).toThrow("singular");
  });
});

describe("the panels' formatting", () => {
  it("formats numbers, sources and kinds", () => {
    expect(fmt(1234.56, 1)).toBe((1234.6).toLocaleString(undefined, { maximumFractionDigits: 1 }));
    expect(shortSource("https://storage.googleapis.com/bucket/x")).toBe("gs://bucket/x");
    expect(shortSource("https://host/app/examples/brain.nii.gz")).toBe("bundled: examples/brain.nii.gz");
    expect(shortSource("https://b/s.zarrvectors/|zarr-vectors:")).toBe("https://b/s.zarrvectors/ (zarr-vectors)");
    expect(kindLabel("annotation")).toBe("annotations");
    expect(kindLabel("single_mesh")).toBe("mesh");
    expect(kindLabel("point_cloud")).toBe("point cloud");
    expect(kindLabel(undefined)).toBe("");
  });

  it("chooses a unit for physical coordinates and lengths", () => {
    expect(physical(2, "m", 1e-3)).toEqual([fmt(2, 2), "mm"]);
    expect(physical(5, "m", 1e-6)).toEqual([fmt(5, 2), "µm"]);
    expect(physical(40, "m", 1e-9)).toEqual([fmt(40, 1), "nm"]);
    expect(physical(3, "s", 1)).toEqual([fmt(3, 2), "s"]);
    expect(physical(Number.NaN, "", 1)).toEqual(["–", ""]);
    expect(length(2e-3)).toBe(`${fmt(2, 3)} mm`);
    expect(length(3.5e-7)).toBe(`${fmt(350, 3)} nm`);
    expect(length(Number.POSITIVE_INFINITY)).toBe("–");
  });
});

describe("export kinds", () => {
  it("tells images, streamlines, meshes, graphs and points apart by name", () => {
    expect(exportKind("brain.nii.gz")).toBe("image");
    expect(exportKind("stack.TIF")).toBe("image");
    expect(exportKind("tracts.trx")).toBe("streamlines");
    expect(exportKind("lh.white")).toBe("mesh");
    expect(exportKind("surface.gii")).toBe("mesh");
    expect(exportKind("network_edges.csv")).toBe("graph");
    expect(exportKind("cells.csv")).toBe("points");
    expect(exportKind("notes.txt")).toBeUndefined();
  });
});

describe("zip", () => {
  /** The stored entries of a zip, read back from its central directory. */
  function entries(zip: Uint8Array): { name: string; data: Uint8Array }[] {
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    const end = zip.length - 22;
    expect(view.getUint32(end, true)).toBe(0x06054b50);
    const count = view.getUint16(end + 10, true);
    let at = view.getUint32(end + 16, true);
    const out = [];
    for (let i = 0; i < count; ++i) {
      expect(view.getUint32(at, true)).toBe(0x02014b50);
      const size = view.getUint32(at + 24, true);
      const nameLength = view.getUint16(at + 28, true);
      const offset = view.getUint32(at + 42, true);
      const name = new TextDecoder().decode(zip.subarray(at + 46, at + 46 + nameLength));
      const local = offset + 30 + view.getUint16(offset + 26, true);
      const data = zip.subarray(local, local + size);
      expect(view.getUint32(at + 16, true)).toBe(crc32(data));
      out.push({ name, data });
      at += 46 + nameLength;
    }
    return out;
  }

  it("writes an export's files as the capture's frames are written", async () => {
    const files = new Map([
      ["image.zarr/zarr.json", new TextEncoder().encode("{}")],
      ["image.zarr/0/c/0/0/0", Uint8Array.from([1, 2, 3, 4])],
    ]);
    const zip = new Uint8Array(await zipFiles(files).arrayBuffer());
    expect(entries(zip).map((e) => [e.name, [...e.data]])).toEqual([...files].map(([n, d]) => [n, [...d]]));
  });

  it("says when there are too many files, or too many bytes", () => {
    const many = Array.from({ length: 0x10000 }, (_, i) => ({ name: String(i), data: new Uint8Array(0) }));
    expect(() => zipStore(many)).toThrow("too many files");
    const huge = { name: "big", data: { length: 0xffffffff } as Uint8Array };
    expect(() => zipStore([huge], undefined, "too big for one zip")).toThrow("too big for one zip");
  });
});

// --------------------------------------------------------- elements

/** Just enough of a DOM for `el`: attributes, listeners, children, a value. */
class FakeElement {
  readonly attributes = new Map<string, string>();
  readonly listeners: [string, unknown][] = [];
  readonly children: unknown[] = [];
  className = "";
  clicked = 0;
  removed = false;
  constructor(readonly tagName: string) {
    if (["input", "select", "textarea", "option", "button"].includes(tagName)) (this as { value?: string }).value = "";
  }
  setAttribute(k: string, v: string): void {
    this.attributes.set(k, v);
  }
  addEventListener(type: string, listener: unknown): void {
    this.listeners.push([type, listener]);
  }
  append(...nodes: unknown[]): void {
    this.children.push(...nodes);
  }
  replaceChildren(): void {
    this.children.length = 0;
  }
  click(): void {
    ++this.clicked;
  }
  remove(): void {
    this.removed = true;
  }
}

describe("el", () => {
  const saved = { document: globalThis.document };
  afterEach(() => {
    (globalThis as { document?: unknown }).document = saved.document;
  });
  const fake = () => {
    const made: FakeElement[] = [];
    const body = new FakeElement("body");
    (globalThis as { document?: unknown }).document = {
      body,
      createElement: (tag: string) => {
        const e = new FakeElement(tag);
        made.push(e);
        return e;
      },
      createElementNS: (_ns: string, tag: string) => new FakeElement(tag),
    };
    return { made, body };
  };

  it("sets attributes, listeners and children, leaving out what is undefined, null or false", () => {
    fake();
    const onClick = () => {};
    const e = el("div", { class: "a b", title: "t", hidden: true, disabled: false, "data-x": undefined, "aria-label": null, tabindex: 0, onClick }, "text", null, false, undefined) as unknown as FakeElement;
    expect(e.className).toBe("a b");
    expect([...e.attributes]).toEqual([
      ["title", "t"],
      ["hidden", ""],
      ["tabindex", "0"],
    ]);
    // Listeners by the event's name, whatever the case of the key.
    expect(e.listeners).toEqual([["click", onClick]]);
    expect(e.children).toEqual(["text"]);
  });

  it("sets a value last, as the property, where the element has one", () => {
    fake();
    const input = el("input", { value: 0.5, type: "range", min: 0, max: 1 }) as unknown as FakeElement & { value: string };
    expect(input.value).toBe("0.5");
    expect(input.attributes.has("value")).toBe(false);
    expect([...input.attributes.keys()]).toEqual(["type", "min", "max"]);
    // An element with no value property keeps it as an attribute.
    const div = el("div", { value: "v" }) as unknown as FakeElement;
    expect(div.attributes.get("value")).toBe("v");
  });

  it("builds controls, SVG elements and downloads", () => {
    const { body } = fake();
    const b = button("Save", () => {}, "Save it") as unknown as FakeElement;
    expect(b.className).toBe("btn outline small");
    expect(b.attributes.get("type")).toBe("button");
    expect(b.children).toEqual(["Save"]);
    const s = select([["a", "A"], ["b", "B"]], "b", () => {}) as unknown as FakeElement & { value: string };
    expect(s.children).toHaveLength(2);
    expect(s.value).toBe("b");
    const r = svgEl("rect", { x: 1, width: 2 }) as unknown as FakeElement;
    expect([...r.attributes]).toEqual([
      ["x", "1"],
      ["width", "2"],
    ]);
    const urls: string[] = [];
    const { createObjectURL } = URL;
    URL.createObjectURL = () => (urls.push("blob:x"), "blob:x");
    try {
      downloadBlob(new Blob(["x"]), "x.txt");
    } finally {
      URL.createObjectURL = createObjectURL;
    }
    const a = body.children[0] as FakeElement;
    expect(a.attributes.get("href")).toBe("blob:x");
    expect(a.attributes.get("download")).toBe("x.txt");
    expect(a.clicked).toBe(1);
    expect(a.removed).toBe(true);
  });
});
