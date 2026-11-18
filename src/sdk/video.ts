/**
 * Movies made in this browser, for plugins (and the shell's capture): frames
 * encoded as H.264 by WebCodecs, in an MP4 written here (../core/mp4.ts).
 *
 *     import { canEncodeMp4, encodeMp4 } from "@ngplatform/sdk/video";
 */
import { muxMp4, type Mp4Sample } from "../core/mp4.js";

/** Whether this browser has WebCodecs' VideoEncoder (H.264 support itself is asked per size by encodeMp4). */
export function canEncodeMp4(): boolean {
  return typeof (globalThis as { VideoEncoder?: unknown }).VideoEncoder !== "undefined";
}

/**
 * `count` frames (each made by `frame`, in turn) at `fps` as an MP4, `width` × `height` (even). Stops, throwing
 * "cancelled", when `cancelled()` is true between frames.
 */
export async function encodeMp4(width: number, height: number, fps: number, count: number, frame: (i: number) => Promise<CanvasImageSource>, cancelled: () => boolean = () => false): Promise<Blob> {
  const area = width * height;
  // Profile and level by size: High 4.0 to 1080p, 5.1 to 4K, 6.0 beyond.
  const codecs = area <= 1920 * 1088 ? ["avc1.640028", "avc1.4d0028", "avc1.42e01f"] : area <= 4096 * 2304 ? ["avc1.640033", "avc1.4d0033"] : ["avc1.64003c"];
  const Encoder = (globalThis as unknown as { VideoEncoder: typeof VideoEncoder }).VideoEncoder;
  if (Encoder === undefined) throw new Error("This browser cannot encode video (no WebCodecs).");
  let config: VideoEncoderConfig | undefined;
  for (const codec of codecs) {
    const candidate: VideoEncoderConfig = { codec, width, height, framerate: fps, bitrate: Math.min(50e6, area * fps * 0.3), avc: { format: "avc" } } as VideoEncoderConfig;
    if ((await Encoder.isConfigSupported(candidate)).supported) {
      config = candidate;
      break;
    }
  }
  if (config === undefined) throw new Error(`This browser cannot encode H.264 at ${width} × ${height}.`);
  const samples: Mp4Sample[] = [];
  let avcC: Uint8Array | undefined;
  let failure: Error | undefined;
  const encoder = new Encoder({
    output: (chunk, metadata) => {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      samples.push({ data, key: chunk.type === "key" });
      const description = metadata?.decoderConfig?.description;
      if (description !== undefined && avcC === undefined) {
        const view = description instanceof ArrayBuffer ? new Uint8Array(description) : new Uint8Array((description as ArrayBufferView).buffer, (description as ArrayBufferView).byteOffset, (description as ArrayBufferView).byteLength);
        avcC = view.slice();
      }
    },
    error: (e) => (failure = e as Error),
  });
  encoder.configure(config);
  for (let i = 0; i < count; ++i) {
    if (cancelled() || failure) break;
    const source = await frame(i);
    if (cancelled()) break;
    const videoFrame = new VideoFrame(source, { timestamp: Math.round((i * 1e6) / fps), duration: Math.round(1e6 / fps) });
    encoder.encode(videoFrame, { keyFrame: i % Math.max(1, Math.round(fps * 2)) === 0 });
    videoFrame.close();
    // Keep the encoder's queue short.
    while (encoder.encodeQueueSize > 4) await new Promise((r) => setTimeout(r, 5));
  }
  await encoder.flush();
  encoder.close();
  if (failure) throw failure;
  if (cancelled()) throw new Error("cancelled");
  if (avcC === undefined) throw new Error("The H.264 encoder gave no decoder configuration.");
  return new Blob([muxMp4(samples, { width, height, fps, avcC }) as BlobPart], { type: "video/mp4" });
}
