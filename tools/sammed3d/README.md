# SAM-Med3D in the browser

[SAM-Med3D](https://github.com/uni-medical/SAM-Med3D)-turbo (Apache-2.0) is a 3-D Segment Anything: a click in a
128³ crop of a CT or MRI at 1.5 mm gives the structure's mask in 3-D at once. It is a ViT-B on 16³ patches
(100.5 M parameters), a prompt encoder for points, and a decoder that takes the previous mask back to refine it.
These scripts make it two ONNX graphs that onnxruntime-web runs, check them against PyTorch, and measure it run as
the app runs it.

## The graphs

| Graph | fp32 | fp16 weights | Runs |
|---|---|---|---|
| `encoder.onnx` | 372 MB | 187 MB | once a cube: image (1,1,128,128,128), z-normalised → embedding (1,384,8,8,8) |
| `decoder.onnx` | 31 MB | 15 MB | each click: embedding, points (1,N,3), labels (1,N), prev_mask (1,1,32,32,32) → mask logits (1,1,32,32,32), iou |

202 MB with float16 weights. The encoder takes about 2 s with ONNX Runtime on the CPU (Python, all cores), 17 s in headless Chrome (WebAssembly, one thread); the decoder 0.1 s. The decoder's
prompt embedding is written again without boolean-index assignment (the same arithmetic). Against the model:
decoder 0 difference; the ONNX encoder within 2.5e-6, the decoder within 1e-6 for 1, 2 and 5 points.

The model code is MedIM's (`prepare_model.py`): its builder takes the turbo checkpoint's 128 cube and
single-mask decoder; the SAM-Med3D repository's own builder (256, multimask) does not. The checkpoint is loaded
with `weights_only=True`.

## What it needs: the structure in the middle of the cube

SAM-Med3D was trained on crops centred on the structure's bounding box (torchio `CropOrPad(mask_name=...)`), and
it segments well only when the cube's centre is near the structure's. On AMOS amos_0013 (CT,
0.78 × 0.78 × 5 mm), the cube moved from the kidney's centre towards an innermost click 20 mm away:

| Cube centre, of the way from the box's centre to the click | 0 | 0.25 | 0.5 | 0.75 | 1 |
|---|---|---|---|---|---|
| Left kidney (Dice) | 0.921 | 0.923 | 0.647 | 0.170 | 0.082 |
| Spleen | 0.813 | 0.854 | 0.821 | 0.627 | 0.324 |
| Liver (62 mm off) | 0.943 | 0.950 | 0.916 | 0.479 | 0.288 |

The image the app makes is right: on the official crop's grid, the app's sampling (nearest, from the scan) gives
the official Dice to within 0.02. The IoU the decoder returns does not track the Dice (it is near 0 throughout),
so it cannot choose a cube. Moving the cube to the first mask's middle and running again did not help (a poor
first mask does not move it far enough) and is not done.

So in the app a **box** places the cube (its middle, on the slice it is drawn on), with a click inside the
structure as the point (else the box's middle); a click alone centres the cube on itself.

## Results

`quality.py` runs the app's path (fp16 graphs) against the ground truth, organ by organ, on amos_0013. `official.py`
runs SAM-Med3D's own pipeline (crop centred on the true 3-D bounding box, one random click inside it):

| Organ | Official | Click (innermost voxel) | Box on the middle slice + click | Box on the slice at 30 % |
|---|---|---|---|---|
| Spleen | 0.887 | 0.324 | 0.856 | 0.836 |
| Right kidney | 0.736 | 0.267 | 0.917 | 0.528 |
| Left kidney | 0.923 | 0.082 | 0.922 | 0.784 |
| Gallbladder | 0.720 | 0.690 | 0.751 | 0.510 |
| Oesophagus | 0.658 | 0.403 | 0.526 | 0.550 |
| Liver | 0.945 | 0.288 | 0.952 | 0.180 |
| Stomach | 0.711 | 0.437 | 0.598 | 0.229 |
| Aorta | 0.812 | 0.796 | 0.274 | 0.071 |
| IVC | 0.619 | 0.347 | 0.639 | 0.053 |
| Pancreas | 0.556 | 0.106 | 0.105 | 0.158 |
| Right adrenal | 0.627 | 0.560 | 0.691 | 0.555 |
| Left adrenal | 0.549 | 0.480 | 0.556 | 0.412 |
| Duodenum | 0.564 | 0.068 | 0.438 | 0.435 |
| Bladder | 0.866 | 0.868 | 0.846 | 0.808 |
| Prostate/uterus | 0.533 | 0.618 | 0.707 | 0.622 |
| **Mean** | **0.714** | **0.422** | **0.652** | **0.449** |

One scan, one click: the numbers say which prompts work, not how well the model does in general. A box on the
middle slice is near the official pipeline for compact organs; long ones (the aorta, the IVC) are better with a
click on their middle, and a box off the middle in depth loses much of the larger organs. More clicks (the app
refines with them, the last mask fed back) are not measured here.

## In the app

The segmentation tool's **AI segment** tool, method **AI 3-D (SAM-Med3D)** (plugins/segmentation/sammed3d*.ts;
its README has the details). `half_weights.py` writes the float16 files with `manifest.json` into `onnx16/`; the
app loads them from `models/sammed3d/` beside itself (`cp onnx16/* ../../models/sammed3d/` for `npm run dev`) or
from localStorage `ngplatform.sammed3d.url`.

## Running it

```bash
cd tools/sammed3d
git clone --depth 1 https://github.com/uni-medical/SAM-Med3D.git repo       # official.py and its test data
curl -L -o turbo.pth https://huggingface.co/blueyo0/SAM-Med3D/resolve/main/sam_med3d_turbo.pth
python3 -m pip download medim==0.1.2 --no-deps -d wheel && python3 prepare_model.py wheel/medim-*.whl
uv venv -p 3.11 venv
VIRTUAL_ENV=venv uv pip install --index-url https://download.pytorch.org/whl/cpu torch==2.5.1
VIRTUAL_ENV=venv uv pip install numpy onnx onnxruntime onnxscript nibabel scipy torchio==0.20.1 SimpleITK
CUDA_VISIBLE_DEVICES= venv/bin/python export_onnx.py onnx        # the graphs, each checked
venv/bin/python half_weights.py                                  # onnx16/: fp16 weights
D=repo/test_data/amos_val_toy_data
CUDA_VISIBLE_DEVICES= venv/bin/python quality.py $D/imagesVa/amos_0013.nii.gz $D/labelsVa/amos_0013.nii.gz onnx16
CUDA_VISIBLE_DEVICES= venv/bin/python official.py $D/imagesVa/amos_0013.nii.gz $D/labelsVa/amos_0013.nii.gz official.nii.gz
```

torchio 0.20.1: later versions changed what `official.py`'s pipeline calls.
