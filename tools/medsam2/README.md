# MedSAM2 in the browser: the prototype

[MedSAM2](https://github.com/bowang-lab/MedSAM2) is a box on one slice of a 3-D medical image, segmented there and
tracked through the volume (SAM 2.1 Hiera-tiny, 512 x 512, fine-tuned on medical images; Apache-2.0). These
scripts make it four ONNX graphs that onnxruntime-web runs, and check each step against MedSAM2's own PyTorch.

## The graphs

| Graph | fp32 | fp16 weights | Runs | In the browser (WASM, 8 threads) |
|---|---|---|---|---|
| `encoder.onnx` | 116 MB | 61 MB | once a slice | 449 ms |
| `memory_attention.onnx` | 25 MB | 13 MB | once a tracked slice | 165 ms |
| `heads.onnx` | 18 MB | 9 MB | each prompt, each slice | 21 ms |
| `memory_encoder.onnx` | 5.6 MB | 2.8 MB | once a slice | 34 ms |

About 0.7 s a tracked slice on the CPU (WebAssembly); WebGPU not yet measured. Inputs, outputs and what each
holds are in `export_onnx.py`'s docstring; `constants.json` has the settings and `no_mem_embed`.

What changed on the way to ONNX, with the same weights (each checked against the original modules):

- **Memory attention** written again: RoPE in real numbers (ONNX has no complex type), and the spatial memory and
  the object-pointer tokens as separate inputs, so only the spatial keys are rotated without slicing by a
  data-dependent length. Any number of memory slices and pointers.
- **Prompt embedding** without boolean-index assignment.
- **The trunk's position embedding** as a constant (the image is always 512 x 512): its run-time interpolation
  exported as an `If` whose branches' shapes disagree, which onnxruntime-web refuses.
- **Mask choice left out of the graphs**: `heads` gives all four masks, IoUs and pointers; the tracker picks
  (single mask with the stability fallback on the boxed slice, best of three by IoU when tracking).

## The tracker

`medsam2_onnx.py` is the bookkeeping of SAM 2's video predictor written out over the four graphs: which slices go
into the memory bank (the boxed slice, then the up to 6 before), which object pointers (up to 16, with signed
distances), the multimask choice, no-object handling, memory stored as bfloat16 as the predictor keeps it. It is
what the TypeScript port follows, line for line.

## Results

`compare.py` runs MedSAM2's PyTorch video predictor and the ONNX tracker on the same volume and box, forward and
back (the 1 mm hemisphere MRI, 160 slices of 117 x 73):

| Box | fp32 graphs | fp16 weights |
|---|---|---|
| The whole hemisphere | 1 voxel of 22,919 differs; Dice 0.99998; logits within 1.2e-3 | 54 differ; Dice 0.9988 |
| A small box on deep grey matter | 1 voxel of 44,901 differs; Dice 0.99999 | 33 differ; Dice 0.9996 |

`web/check.mjs` runs each graph in headless Chrome with onnxruntime-web 1.30.0 (the app's), WebAssembly backend
(SwiftShader: no GPU), against Python's outputs on real inputs: all within 2e-6.

Not done: hole filling (SAM 2's `fill_hole_area=8`; skipped by the CPU reference too), WebGPU timings, a home for
the model files.

## In the app

The segmentation tool's **AI 3-D (MedSAM2)** quick select method runs these graphs
(plugins/segmentation/medsam2*.ts; its README has the details and the checks). `half_weights.py` writes the
float16 files with `manifest.json` into `onnx16/`; the app loads them from `models/medsam2/` beside itself
(`cp onnx16/* ../../models/medsam2/` for `npm run dev`) or from localStorage `ngplatform.medsam2.url`.

## Running it

```bash
cd tools/medsam2
git clone --depth 1 https://github.com/bowang-lab/MedSAM2.git repo
curl -L -o repo/checkpoints/MedSAM2_latest.pt https://huggingface.co/wanglab/MedSAM2/resolve/main/MedSAM2_latest.pt
uv venv -p 3.11 venv
VIRTUAL_ENV=venv uv pip install --index-url https://download.pytorch.org/whl/cpu torch==2.5.1 torchvision==0.20.1
VIRTUAL_ENV=venv uv pip install "hydra-core>=1.3.2" "iopath>=0.1.10" numpy pillow onnx onnxruntime onnxscript nibabel tqdm
CUDA_VISIBLE_DEVICES= venv/bin/python export_onnx.py onnx        # the graphs, each checked
venv/bin/python half_weights.py                                  # onnx16/: fp16 weights
CUDA_VISIBLE_DEVICES= venv/bin/python compare.py VOLUME.nii.gz [axis] [key] [x0 y0 x1 y1]
ONNX_DIR=onnx16 CUDA_VISIBLE_DEVICES= venv/bin/python compare.py VOLUME.nii.gz
```

The browser check: `venv/bin/python save_refs.py VOLUME.nii.gz` (each graph's inputs and outputs on a real
slice, into `web/ref/`), `ln -s ../onnx web/models`, then `node web/check.mjs $PWD/web` (Playwright's Chromium or
`/usr/bin/google-chrome`). It uses SwiftShader: no GPU.
