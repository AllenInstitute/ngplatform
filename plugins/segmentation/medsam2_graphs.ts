/**
 * MedSAM2's four ONNX graphs (tools/medsam2/export_onnx.py) behind the
 * tracker's `Graphs` (./medsam2.ts), on ONNX Runtime Web sessions: the
 * arrays the tracker holds as the graphs' input and output tensors. Used by
 * the worker (./medsam2_worker.ts) and by the check against the Python
 * tracker (tools/medsam2/).
 */
import type { Features, Graphs, HeadsOut } from "./medsam2.js";

/** The part of onnxruntime-web used here (the package is loaded from its URL, not installed). */
export interface OrtTensor {
  data: ArrayLike<number> | BigInt64Array;
  dims: readonly number[];
}
export interface OrtSession {
  run(feeds: Record<string, OrtTensor>): Promise<Record<string, OrtTensor>>;
}
export interface OrtModule {
  Tensor: new (type: "float32" | "int32" | "int64", data: Float32Array | Int32Array | BigInt64Array, dims: number[]) => OrtTensor;
}

/** The four sessions. */
export interface MedSam2Sessions {
  encoder: OrtSession;
  attention: OrtSession;
  heads: OrtSession;
  memoryEncoder: OrtSession;
}

const f32 = (t: OrtTensor) => t.data as Float32Array;

/** A section's features from the encoder (`image`: 3 × 512 × 512, normalised). */
export async function encode(ort: OrtModule, s: MedSam2Sessions, image: Float32Array): Promise<Features> {
  const out = await s.encoder.run({ image: new ort.Tensor("float32", image, [1, 3, 512, 512]) });
  return { high0: f32(out.high0), high1: f32(out.high1), vision: f32(out.vision), visionPos: f32(out.vision_pos) };
}

export function ortGraphs(ort: OrtModule, s: MedSam2Sessions): Graphs {
  const T = (data: Float32Array, dims: number[]) => new ort.Tensor("float32", data, dims);
  const feats = (f: Features) => ({
    high0: T(f.high0, [1, 32, 128, 128]),
    high1: T(f.high1, [1, 64, 64, 64]),
  });
  return {
    async heads(pix, f, coords, labels): Promise<HeadsOut> {
      const n = labels.length;
      const out = await s.heads.run({ pix: T(pix, [1, 256, 32, 32]), ...feats(f), point_coords: T(coords, [1, n, 2]), point_labels: new ort.Tensor("int32", labels, [1, n]) });
      return { masks: f32(out.masks), ious: f32(out.ious), ptrs: f32(out.obj_ptrs), score: f32(out.object_score)[0] };
    },
    async memoryEncoder(vision, mask, score, binarize) {
      const out = await s.memoryEncoder.run({
        vision: T(vision, [1, 256, 32, 32]),
        mask: T(mask, [1, 1, 128, 128]),
        object_score: T(Float32Array.of(score), [1, 1]),
        binarize: T(Float32Array.of(binarize ? 1 : 0), [1]),
      });
      return { mem: f32(out.maskmem), pos: f32(out.maskmem_pos) };
    },
    async memoryAttention(f, memFeats, memPos, slots, ptrs, distances, tDiffMax) {
      const nf = slots.length;
      const np = distances.length;
      const out = await s.attention.run({
        vision: T(f.vision, [1, 256, 32, 32]),
        vision_pos: T(f.visionPos, [1, 256, 32, 32]),
        mem_feats: T(memFeats, [nf, 64, 32, 32]),
        mem_pos: T(memPos, [nf, 64, 32, 32]),
        mem_tpos: new ort.Tensor("int64", BigInt64Array.from(slots, (v) => BigInt(v)), [nf]),
        obj_ptrs: T(ptrs, [np, 256]),
        obj_tpos: T(Float32Array.from(distances), [np]),
        t_diff_max: T(Float32Array.of(tDiffMax), []),
      });
      return f32(out.pix);
    },
  };
}
