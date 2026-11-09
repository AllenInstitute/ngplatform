/**
 * Capture: pictures and movies of the views, as Freeview's Save Screenshot
 * (with magnification and trimmed borders), Save Movie Frames and Save GIF.
 *
 * A picture is one frame; a movie is a sweep along a dimension (slices
 * through z, or time) or a turntable turn of the 3-D view.  Each frame is
 * drawn once its data has loaded (../engine/capture.ts) and kept as a PNG;
 * then they are written out as a GIF, a WebM (MediaRecorder), an MP4
 * (WebCodecs, where the browser has an H.264 encoder) or PNG frames, in a
 * zip or a folder.  The view is put back afterwards, without undo steps.
 */
import { captureName, evenBox, frameName, sweepFrames, trimBox, turntableFrames, unionBox, type Box, type CaptureFrame } from "../core/capture.js";
import { GifEncoder } from "../core/gif.js";
import { muxMp4, type Mp4Sample } from "../core/mp4.js";
import { zipStore } from "../core/zip.js";
import { downloadBlob } from "../sdk/dom.js";
import type { JobControl } from "../sdk/types.js";
import { formatScaleWithUnitAsString } from "../engine/neuroglancer.js";
import { h } from "./dom.js";
import { closeSheet, sheet, showSheet, toast } from "./overlays.js";
import type { Workbench } from "./workbench.js";

type Mode = "picture" | "sweep" | "turntable";
type Format = "png" | "gif" | "webm" | "mp4" | "zip" | "folder";

export interface CaptureSettings {
  mode: Mode;
  format: Format;
  /** Index of a view, or -1 for all of them. */
  panel: number;
  scale: number;
  trim: boolean;
  margin: number;
  /** Sweep: the dimension (index), from, to and step, in its coordinates. */
  dimension: number;
  from: number;
  to: number;
  step: number;
  /** Turntable: frames per turn, and degrees. */
  frames: number;
  degrees: number;
  fps: number;
  /** Seconds to wait for a frame's data. */
  timeout: number;
}

const FORMATS: Record<Format, string> = {
  png: "PNG",
  gif: "GIF (animated)",
  webm: "WebM video",
  mp4: "MP4 video (H.264)",
  zip: "PNG frames, in a zip",
  folder: "PNG frames, into a folder…",
};

/** The settings last used, in this browser. */
const KEY = "ngplatform.capture";
function remembered(): Partial<CaptureSettings> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<CaptureSettings>;
  } catch {
    return {};
  }
}

/** A coordinate's unit, as the position bar shows it: "mm", or "steps of 0.5 mm". */
function unitLabel(scale: number, unit: string): string {
  if (unit === "") return "its coordinates";
  const text = formatScaleWithUnitAsString(scale, unit, { precision: 3 });
  // "mm" (or "1mm"): that unit; "0.5mm": steps of it.
  if (!/^\d/.test(text)) return text;
  return /^1[^\d.]/.test(text) ? text.slice(1) : `steps of ${text}`;
}

const canPickFolder = () => "showDirectoryPicker" in window;
const canRecordWebm = () => typeof MediaRecorder !== "undefined" && ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].some((t) => MediaRecorder.isTypeSupported(t));
const canEncodeMp4 = () => typeof (globalThis as { VideoEncoder?: unknown }).VideoEncoder !== "undefined";


function canvasPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Could not make a PNG of the frame."))), "image/png"));
}

/** The frames of a capture, from its settings and the view now. */
export function planFrames(settings: CaptureSettings, orientation: [number, number, number, number]): CaptureFrame[] {
  switch (settings.mode) {
    case "picture":
      return [{ kind: "still" }];
    case "sweep":
      return sweepFrames(settings.dimension, settings.from, settings.to, settings.step);
    case "turntable":
      return turntableFrames(orientation, settings.frames, settings.degrees);
  }
}

// ------------------------------------------------------------- the sheet

export function showCaptureSheet(wb: Workbench, initialMode: Mode = "picture"): void {
  const { engine } = wb;
  const dims = engine.captureDimensions();
  const panels = engine.capturePanels();
  const saved = remembered();
  // Default sweep: the first dimension that is not shown (time, say), else the third shown (z).
  const hidden = dims.findIndex((d) => !d.displayed && Number.isFinite(d.lower) && d.upper - d.lower > 1);
  const third = dims.findIndex((d, i) => d.displayed && dims.slice(0, i).filter((e) => e.displayed).length === 2);
  const defaultDim = hidden >= 0 ? hidden : third >= 0 ? third : Math.max(0, dims.length - 1);

  // A hint is the field's tooltip: the label says what it is.
  const field = (label: string, control: HTMLElement, hint?: string) => h("label", { class: "field", ...(hint ? { title: hint } : {}) }, h("span", {}, label), control);
  const number = (value: number, attrs: Record<string, string | number> = {}) => h("input", { class: "text-input", type: "number", value, ...attrs }) as HTMLInputElement;
  const select = (options: [string, string][], value: string) => {
    const s = h("select", { class: "text-input" }, ...options.map(([v, l]) => h("option", { value: v }, l))) as HTMLSelectElement;
    s.value = value;
    return s;
  };

  const mode = select(
    [
      ["picture", "Picture"],
      ["sweep", "Movie: sweep slices or time"],
      ["turntable", "Movie: turn the 3-D view"],
    ],
    initialMode,
  );
  const panel = select([["-1", "All the views"], ...panels.map((p): [string, string] => [String(p.index), p.label])], String(saved.panel !== undefined && saved.panel < panels.length ? saved.panel : -1));
  const scale = number(saved.scale ?? 1, { min: 0.5, max: 8, step: 0.5 });
  const trim = h("input", { type: "checkbox" }) as HTMLInputElement;
  trim.checked = saved.trim ?? false;
  const margin = number(saved.margin ?? 4, { min: 0, max: 200, step: 1 });
  const timeout = number(saved.timeout ?? 20, { min: 1, max: 600, step: 1 });
  const fps = number(saved.fps ?? 10, { min: 1, max: 60, step: 1 });

  const dimension = select(
    dims.map((d, i): [string, string] => [String(i), `${d.name}${d.displayed ? "" : " (not shown)"}`]),
    String(defaultDim),
  );
  const from = number(0, { step: "any" });
  const to = number(0, { step: "any" });
  const step = number(1, { step: "any", min: 0 });
  const rangeUnit = h("span", { class: "field-hint" });
  const setRange = () => {
    const d = dims[Number(dimension.value)];
    if (d === undefined) return;
    rangeUnit.textContent = `From, to and step in ${unitLabel(d.scale, d.unit)}.`;
    // Voxel centres from the first to the last.
    const lo = Number.isFinite(d.lower) ? Math.floor(d.lower) + 0.5 : d.position;
    const hi = Number.isFinite(d.upper) ? Math.ceil(d.upper) - 0.5 : d.position;
    from.value = String(lo);
    to.value = String(hi);
    step.value = "1";
  };
  dimension.addEventListener("change", () => {
    setRange();
    update();
  });
  setRange();
  const frames = number(saved.frames ?? 72, { min: 2, max: 3600, step: 1 });
  const degrees = number(saved.degrees ?? 360, { min: 1, max: 3600, step: 1 });

  const format = h("select", { class: "text-input" }) as HTMLSelectElement;
  const count = h("span", { class: "detected" });

  const pictureRows = h("div", { class: "field-row" }, field("View", panel), field("Magnification (×)", scale, "2 doubles the width and height"));
  const trimRow = h("div", { class: "field-row" }, h("label", { class: "field check" }, trim, h("span", {}, "Trim empty borders")), h("span"));
  const sweepRows = h(
    "div",
    { class: "capture-sweep" },
    h("div", { class: "field-row" }, field("Dimension", dimension, "z for slices, t for time"), field("Step", step)),
    h("div", { class: "field-row" }, field("From", from), field("To", to)),
    rangeUnit,
  );
  const turnRows = h("div", { class: "field-row" }, field("Frames per turn", frames), field("Angle (°)", degrees, "360 is a whole turn"));
  const movieRows = h("div", { class: "field-row" }, field("Format", format), field("Frames per second", fps));
  // Rarely changed: folded away.
  const waitRow = h(
    "details",
    { class: "capture-more" },
    h("summary", {}, "More"),
    h("div", { class: "field-row" }, field("Margin after trimming (px)", margin), field("Max wait per frame (s)", timeout, "A frame is taken when its data has loaded, or after this.")),
  );

  const settings = (): CaptureSettings => ({
    mode: mode.value as Mode,
    format: format.value as Format,
    panel: Number(panel.value),
    scale: Math.max(0.25, Number(scale.value) || 1),
    trim: trim.checked,
    margin: Math.max(0, Number(margin.value) || 0),
    dimension: Number(dimension.value),
    from: Number(from.value),
    to: Number(to.value),
    step: Number(step.value),
    frames: Math.max(2, Math.round(Number(frames.value) || 72)),
    degrees: Number(degrees.value) || 360,
    fps: Math.max(1, Math.min(60, Number(fps.value) || 10)),
    timeout: Math.max(1, Number(timeout.value) || 20),
  });

  const update = () => {
    const m = mode.value as Mode;
    const options: Format[] = m === "picture" ? ["png"] : (["gif", ...(canRecordWebm() ? ["webm" as const] : []), ...(canEncodeMp4() ? ["mp4" as const] : []), "zip", ...(canPickFolder() ? ["folder" as const] : [])] as Format[]);
    const current = format.value || saved.format;
    format.replaceChildren(...options.map((f) => h("option", { value: f }, FORMATS[f])));
    format.value = options.includes(current as Format) ? (current as string) : options[0];
    sweepRows.hidden = m !== "sweep";
    turnRows.hidden = m !== "turntable";
    movieRows.hidden = m === "picture";
    const s = settings();
    const n = planFrames(s, [0, 0, 0, 1]).length;
    count.textContent = m === "picture" ? "" : n === 0 ? "No frames: check the range and step." : `${n} frame${n === 1 ? "" : "s"}, ${(n / s.fps).toFixed(1)} s at ${s.fps} fps.`;
    start.disabled = n === 0;
  };
  const start = h("button", { class: "btn primary", type: "button" }, "Capture") as HTMLButtonElement;
  // Its own close: the folder picker is awaited first.
  let close = () => {};
  for (const input of [mode, dimension, from, to, step, frames, degrees, fps, format]) input.addEventListener("input", update);
  mode.addEventListener("change", update);

  start.addEventListener("click", async () => {
    const s = settings();
    try {
      localStorage.setItem(KEY, JSON.stringify({ panel: s.panel, scale: s.scale, trim: s.trim, margin: s.margin, frames: s.frames, degrees: s.degrees, fps: s.fps, timeout: s.timeout, format: s.mode === "picture" ? undefined : s.format }));
    } catch {
      // A browser without storage forgets.
    }
    // The folder is asked for now, while the click still counts as the user's.
    let folder: FileSystemDirectoryHandle | undefined;
    if (s.mode !== "picture" && s.format === "folder") {
      try {
        folder = await (window as unknown as { showDirectoryPicker(o: unknown): Promise<FileSystemDirectoryHandle> }).showDirectoryPicker({ id: "ngplatform-frames", mode: "readwrite" });
      } catch {
        return;
      }
    }
    close();
    void runCapture(wb, s, folder).catch((e) => {
      if ((e as Error).message !== "cancelled") toast(`Capture failed: ${(e as Error).message}`, "error");
    });
  });

  close = showSheet(
    sheet(
      "Capture",
      [
        field("What", mode),
        pictureRows,
        trimRow,
        sweepRows,
        turnRows,
        movieRows,
        waitRow,
      ],
      [count, h("button", { class: "btn", type: "button", onclick: () => closeSheet() }, "Cancel"), start],
    ),
  );
  update();
}

// ------------------------------------------------------------- running

interface Kept {
  png: Blob;
  box: Box;
  width: number;
  height: number;
}

/** Takes the frames, then writes them out in the chosen format. */
/** A capture under way: a second would move the same view at the same time. */
let capturing = false;

export async function runCapture(wb: Workbench, s: CaptureSettings, folder?: FileSystemDirectoryHandle): Promise<void> {
  if (capturing) throw new Error("another capture is under way: wait for it, or cancel it in the Activity tab");
  capturing = true;
  try {
    await capture(wb, s, folder);
  } finally {
    capturing = false;
  }
}

async function capture(wb: Workbench, s: CaptureSettings, folder?: FileSystemDirectoryHandle): Promise<void> {
  const name = captureName();
  const title = s.mode === "picture" ? "Picture of the views" : s.mode === "sweep" ? "Movie: a sweep" : "Movie: a turntable";
  await wb.jobs.run(title, async (control: JobControl) => {
    const session = wb.engine.beginCapture({ scale: s.scale, panel: s.panel < 0 ? undefined : s.panel, timeout: s.timeout * 1000 });
    const kept: Kept[] = [];
    let incomplete = 0;
    try {
      const plan = planFrames(s, session.orientation());
      for (let i = 0; i < plan.length; ++i) {
        if (control.cancelled) throw new Error("cancelled");
        control.progress(i / plan.length / (s.mode === "picture" ? 1 : 2), `Frame ${i + 1} of ${plan.length}`);
        session.apply(plan[i]);
        const { canvas, complete } = await session.grab(control);
        if (!complete) incomplete++;
        const box = s.trim ? trimBox(canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height, s.margin) : { x: 0, y: 0, width: canvas.width, height: canvas.height };
        kept.push({ png: await canvasPng(canvas), box, width: canvas.width, height: canvas.height });
      }
    } finally {
      session.end();
    }
    if (control.cancelled) throw new Error("cancelled");
    // One box for every frame, so a trimmed movie does not jump.
    let box = unionBox(kept.map((k) => k.box))!;
    if (s.format === "mp4" || s.format === "webm") box = evenBox(box, kept[0].width, kept[0].height);
    const whole = box.x === 0 && box.y === 0 && box.width === kept[0].width && box.height === kept[0].height;
    const frame = async (k: Kept): Promise<HTMLCanvasElement> => {
      const bitmap = await createImageBitmap(k.png);
      const c = document.createElement("canvas");
      c.width = box.width;
      c.height = box.height;
      c.getContext("2d")!.drawImage(bitmap, box.x, box.y, box.width, box.height, 0, 0, box.width, box.height);
      bitmap.close();
      return c;
    };
    const pngOf = async (k: Kept) => (whole ? k.png : canvasPng(await frame(k)));
    const encoding = (i: number) => control.progress(0.5 + (i / kept.length) * 0.5, `Writing frame ${i + 1} of ${kept.length}`);
    const note = incomplete > 0 ? ` (${incomplete} frame${incomplete === 1 ? "" : "s"} taken before all their data had loaded)` : "";

    if (s.mode === "picture") {
      downloadBlob(await pngOf(kept[0]), `${name}.png`);
      wb.log.add(`Saved a picture of the views, ${box.width} × ${box.height}${note}.`, "ok");
      return;
    }
    switch (s.format) {
      case "gif": {
        const gif = new GifEncoder({ delay: 100 / s.fps });
        for (let i = 0; i < kept.length; ++i) {
          if (control.cancelled) throw new Error("cancelled");
          encoding(i);
          const c = await frame(kept[i]);
          gif.addFrame(c.getContext("2d")!.getImageData(0, 0, c.width, c.height));
          // Let the page breathe between frames.
          await new Promise((r) => setTimeout(r, 0));
        }
        downloadBlob(new Blob([gif.finish() as BlobPart], { type: "image/gif" }), `${name}.gif`);
        break;
      }
      case "webm":
        downloadBlob(await recordWebm(kept, frame, s.fps, control, encoding), `${name}.webm`);
        break;
      case "mp4":
        downloadBlob(await encodeMp4(kept, frame, s.fps, box, control, encoding), `${name}.mp4`);
        break;
      case "zip": {
        const entries = [];
        for (let i = 0; i < kept.length; ++i) {
          encoding(i);
          entries.push({ name: frameName("frame_", i, kept.length), data: new Uint8Array(await (await pngOf(kept[i])).arrayBuffer()) });
        }
        downloadBlob(new Blob(zipStore(entries, undefined, "The frames are too large for one zip file; save them to a folder instead."), { type: "application/zip" }), `${name}-frames.zip`);
        break;
      }
      case "folder": {
        if (folder === undefined) throw new Error("No folder was chosen.");
        for (let i = 0; i < kept.length; ++i) {
          encoding(i);
          const file = await folder.getFileHandle(frameName("frame_", i, kept.length), { create: true });
          const writable = await file.createWritable();
          await writable.write(await pngOf(kept[i]));
          await writable.close();
        }
        break;
      }
      default:
        throw new Error(`Unknown format ${s.format}`);
    }
    wb.log.add(`Saved a movie of ${kept.length} frames, ${box.width} × ${box.height}, as ${FORMATS[s.format]}${note}.`, "ok");
    toast(`Saved ${kept.length} frames as ${FORMATS[s.format]}${note}.`);
  });
}

/** Plays the frames into a canvas stream at the frame rate, recorded by MediaRecorder (in real time). */
async function recordWebm(kept: Kept[], frame: (k: Kept) => Promise<HTMLCanvasElement>, fps: number, control: JobControl, encoding: (i: number) => void): Promise<Blob> {
  const first = await frame(kept[0]);
  const canvas = document.createElement("canvas");
  canvas.width = first.width;
  canvas.height = first.height;
  const context = canvas.getContext("2d")!;
  context.drawImage(first, 0, 0);
  const stream = canvas.captureStream(0);
  const track = stream.getVideoTracks()[0] as MediaStreamTrack & { requestFrame?(): void };
  const type = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find((t) => MediaRecorder.isTypeSupported(t))!;
  const recorder = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: Math.min(40e6, canvas.width * canvas.height * fps * 0.4) });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => chunks.push(e.data);
  const stopped = new Promise<void>((resolve) => (recorder.onstop = () => resolve()));
  recorder.start();
  // Frames are prepared before each one is due, so the timing holds.
  let next = await frame(kept[0]);
  const t0 = performance.now();
  for (let i = 0; i < kept.length; ++i) {
    if (control.cancelled) break;
    encoding(i);
    context.drawImage(next, 0, 0);
    track.requestFrame?.();
    if (i + 1 < kept.length) next = await frame(kept[i + 1]);
    const due = t0 + ((i + 1) * 1000) / fps;
    await new Promise((r) => setTimeout(r, Math.max(0, due - performance.now())));
  }
  recorder.stop();
  await stopped;
  track.stop();
  if (control.cancelled) throw new Error("cancelled");
  return new Blob(chunks, { type: "video/webm" });
}

/** H.264 through WebCodecs, in an MP4 written here (../core/mp4.ts). */
async function encodeMp4(kept: Kept[], frame: (k: Kept) => Promise<HTMLCanvasElement>, fps: number, box: Box, control: JobControl, encoding: (i: number) => void): Promise<Blob> {
  const { width, height } = box;
  const area = width * height;
  // Profile and level by size: High 4.0 to 1080p, 5.1 to 4K, 6.0 beyond.
  const codecs = area <= 1920 * 1088 ? ["avc1.640028", "avc1.4d0028", "avc1.42e01f"] : area <= 4096 * 2304 ? ["avc1.640033", "avc1.4d0033"] : ["avc1.64003c"];
  const Encoder = (globalThis as unknown as { VideoEncoder: typeof VideoEncoder }).VideoEncoder;
  let config: VideoEncoderConfig | undefined;
  for (const codec of codecs) {
    const candidate: VideoEncoderConfig = { codec, width, height, framerate: fps, bitrate: Math.min(50e6, area * fps * 0.3), avc: { format: "avc" } } as VideoEncoderConfig;
    if ((await Encoder.isConfigSupported(candidate)).supported) {
      config = candidate;
      break;
    }
  }
  if (config === undefined) throw new Error(`This browser cannot encode H.264 at ${width} × ${height}; choose WebM or GIF.`);
  const samples: Mp4Sample[] = [];
  let avcC: Uint8Array | undefined;
  let failure: Error | undefined;
  const encoder = new Encoder({
    output: (chunk, metadata) => {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      samples.push({ data, key: chunk.type === "key" });
      const description = metadata?.decoderConfig?.description;
      if (description !== undefined && avcC === undefined) avcC = new Uint8Array(description instanceof ArrayBuffer ? description : (description as ArrayBufferView).buffer.slice((description as ArrayBufferView).byteOffset, (description as ArrayBufferView).byteOffset + (description as ArrayBufferView).byteLength));
    },
    error: (e) => (failure = e as Error),
  });
  encoder.configure(config);
  for (let i = 0; i < kept.length; ++i) {
    if (control.cancelled || failure) break;
    encoding(i);
    const c = await frame(kept[i]);
    const videoFrame = new VideoFrame(c, { timestamp: Math.round((i * 1e6) / fps), duration: Math.round(1e6 / fps) });
    encoder.encode(videoFrame, { keyFrame: i % Math.max(1, Math.round(fps * 2)) === 0 });
    videoFrame.close();
    // Keep the encoder's queue short.
    while (encoder.encodeQueueSize > 4) await new Promise((r) => setTimeout(r, 5));
  }
  await encoder.flush();
  encoder.close();
  if (failure) throw failure;
  if (control.cancelled) throw new Error("cancelled");
  if (avcC === undefined) throw new Error("The H.264 encoder gave no decoder configuration.");
  return new Blob([muxMp4(samples, { width, height, fps, avcC }) as BlobPart], { type: "video/mp4" });
}
