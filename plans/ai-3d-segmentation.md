# 3-D AI segmentation: plan

*Written 2026-11-19 after testing the in-browser models on SRB 2026a (a HiP-CT brain template, 0.1 mm, T1-like
contrast).*

## Where things stand

| Model | On SRB 2026a | Why |
|---|---|---|
| **MobileSAM** (2-D, general) | Reasonable masks from a box | General Segment Anything: it outlines the object the box encloses |
| **MedSAM2** (2-D + tracking) | Good on small structures (the lentiform nucleus); a box round a hemisphere gave ~70k of ~200k pixels, the cortical ribbon. None of its four masks is the hemisphere; its IoU 0.41–0.49 | Fine-tuned on medical images towards organs and lesions |
| **SAM-Med3D** (3-D at once) | Fails: ventricle Dice 0.00–0.01 from a box, a click or a centred cube; at best 0.13 over all 48 orientations; partial blobs on the brainstem, cerebellum and thalamus | Few normal brain structures in its training, 1.5 mm voxels, and it needs the structure centred in its cube (on AMOS CT it reaches Dice 0.92 so) |

The scripts and figures are kept outside the repository; `tools/sammed3d/quality.py` and `tools/medsam2/compare.py`
are the reusable parts.

**The simplest robust path to a 3-D model**, in order:

1. **Today**: MobileSAM on a section, **Spread** both ways, **Interpolate** gaps, then **Smooth**, **Grow** and
   **Shrink** (added 2026-11-19).
2. **Step 1 below** (days): make that a protocol: Spread prompted with more than a box, checked against the sections
   already done and in a second orientation, and cleaned in 3-D. Optionally the same with SAM 2.1's tracker.
3. **Step 3 below** (a week): nnInteractive, a real 3-D promptable model, on the render computer's GPU.

## Step 1: a MobileSAM volume protocol

**Goal**: a box on one section → a whole structure in 3-D that needs a few clicks to correct, with MobileSAM's
quality on each section.

### What changes in Spread

Spread (`editor.ts` `runSpread`) now prompts each next section with the box round the last mask, padded by 10 %, and
stops when the size jumps by 4×. The protocol prompts and checks each section more carefully:

1. **Prompt from the last mask, not just its box**: the box, plus 1–3 positive points on the last mask's medial
   axis (its distance transform's maxima: `distance2` in `morphology.ts`) and 1–2 negative points just outside
   it in the box's corners where the last section had background. A box alone lets MobileSAM jump to a
   neighbouring structure; points keep it on the object.
2. **Accept or stop**, per section: stop on an empty mask, an area change over ×2 (not ×4), IoU with the
   last section's mask under 0.5 (shifted by the centroid's drift), or MobileSAM's predicted IoU under 0.7.
   Each stop says why in the status line.
3. **Coarse steps on fine volumes**: on a 0.1 mm volume a structure spans hundreds of sections. Prompt every
   k-th section (k chosen so a step is ~0.5 mm, or the image level's voxel), then fill between with
   **Interpolate** (signed distances, which exists). 10× fewer model runs, and fewer chances to drift.
4. **Second orientation**: after the first sweep (say axial), run the same in a perpendicular view (coronal)
   through the result's centre and widest section. Fuse: a voxel is kept where both sweeps say so, or where one
   does and it is within 1 mm of the other (rejects drift in one sweep). Optional, a checkbox: twice the time.
5. **Clean**: Smooth by about one image voxel, and keep the connected component holding the prompt (a
   `keepParts` in 3-D).
6. **Correct**: a click in any section of the result re-prompts that section with the click and the result's
   mask there, and re-spreads from it until the new masks agree (IoU > 0.9) with those already there.

Everything is a proposal (the preview, Enter paints it as one stroke), as Spread is now.

### Also: SAM 2.1 as the tracker (optional)

MedSAM2 is SAM 2.1 Hiera-tiny with medical weights. The general SAM 2.1-tiny (Apache-2.0, `facebook/sam2.1-hiera-tiny`)
has the same graphs, so `tools/medsam2/export_onnx.py` exports it unchanged, and the app's tracker, worker and
model card take a second manifest. It tracks with memory, as MobileSAM cannot, and outlines whole objects as
MobileSAM does. About a day, then measured against the protocol on the same structures.

### Checks

- A Python replica of the protocol (as `tools/sammed3d/quality.py` replicates SAM-Med3D's path) on SRB 2026a
  structures with a reference: the lateral ventricles (threshold below 60 inside the brain, connected to a seed),
  the corpus callosum and the putamen drawn by hand once, and on AMOS CT organs (ground truth), against
  SAM-Med3D's and MedSAM2's numbers above.
- Unit tests of the prompt points, the stop rules and the fusion on synthetic volumes.
- The protocol in headless Chrome (WebAssembly, SwiftShader, never the display GPU) on a small crop.

**Effort**: 2–3 days for 1–6; a day more for SAM 2.1.

## Step 3: nnInteractive on the render computer

[nnInteractive](https://github.com/MIC-DKFZ/nnInteractive) (Isensee et al. 2025, DKFZ) is a 3-D promptable model
trained on over 120 3-D datasets (CT, MRI, PET, microscopy). It takes points, 2-D boxes, scribbles and lassos
drawn in any section and returns the whole 3-D object, refining as prompts are added. It is what 3D Slicer, MITK,
napari and ITK-SNAP integrate.

| | |
|---|---|
| Code | Apache-2.0 (`pip install nnInteractive`) |
| Weights | About 400 MB, `MIC-DKFZ/nnInteractive` on Hugging Face, **CC BY-NC-SA 4.0: not for commercial use** |
| GPU | NVIDIA with CUDA, 10 GB recommended, under 6 GB for small objects |
| API | `nnInteractiveInferenceSession(device="cuda:0", do_autozoom=True)`, `initialize_from_trained_model_folder`, `set_image`, `set_target_buffer`, `add_bbox_interaction`, `add_point_interaction`, `add_scribble_interaction`, `add_lasso_interaction`, `reset_interactions` |

### Design

**A runner service** (`runner/ngplatform_runner/nninteractive_service.py`, started with
`--service nninteractive=python -m ngplatform_runner.nninteractive_service`, reached at `/svc/nninteractive/`;
`services.py` already supervises such services, passes a port and a token, and restarts them):

- On first start, downloads the weights into its state folder (`NGP_STATE_DIR`) and writes the licence's first
  line where `/info` reports it. Loads them once onto the GPU.
- `GET /info`: ready, the GPU and its free memory, the licence, the version.
- `POST /session`: a region of the image (the browser sends it: values as float32 or uint8 at a chosen level,
  its size and voxel size; zstd-compressed). The browser sending the image keeps sign-ins and local files
  working (the runner needs no access to the data) and lets the region be chosen. Returns a session id.
- `POST /session/<id>/prompt`: a box (two corners and the section's axis), points (wanted or not), a scribble
  (voxels) or a lasso (a polygon in a section). Returns the 3-D mask of the region, as a bit-packed array
  compressed with zstd (a 512³ region: 16 MB packed, usually under 1 MB compressed).
- `DELETE /session/<id>`; sessions expire after 10 minutes idle, at most two at once (GPU memory).

**In the app**: an AI segment model **nnInteractive (render computer)**, a quick select method with `ai`,
`volumetric` and `refines`:

- It is listed when the runner is connected and its `/info` says ready; the model card shows the GPU, the
  licence (with a link, and a one-time "I use it for non-commercial work" confirmation stored per browser) and
  the timings.
- **The region**: round the first prompt, the image level nearest 0.5 mm (or the label volume's voxel, if
  coarser), up to 320³ voxels (a 16 cm cube at 0.5 mm, larger for a large box); reused while later prompts
  lie inside it, as SAM-Med3D's cube is. Read with `session.imageGrid` (any level, any grid).
- **Prompts** map onto the tools the editor has: a box drawn with AI segment → `add_bbox_interaction`; clicks
  (Shift or Alt: not wanted) → points; later, the **Brush** and **Lasso** while AI segment's mask is waiting →
  scribbles and lassos (nnInteractive's strength).
- **The mask back** goes on the label grid with `maskOnLabels` (sammed3d.ts, generalised from a 128 cube to any
  region), shown as a preview; Enter paints it as one stroke.

### Cautions

- **The display GPU**: on this workstation the A2000 drives the screen, and heavy CUDA work there has lagged
  and frozen the desktop (Xid 109). The service runs on a render computer with its own GPU, reached through
  the runner's tunnel, or on the A2000 only with care (one session, small regions).
- **Licence**: the weights are non-commercial. They are never bundled or redistributed by ngplatform: the
  service downloads them from their own repository, and the app shows the licence before first use.
- **Resolution**: 0.5 mm regions suit organs and large brain structures; small structures need the finer
  level and a smaller region. The level is a setting in the model card.

### Checks

- The service against nnInteractive's own Python session on the same image and prompts (the same mask).
- On SRB 2026a and AMOS as for step 1, against the numbers above.
- Unit tests of the app's side with a stand-in service (region choice, prompt mapping, mask placement,
  refusal when not ready).
- The real GPU run only on a machine whose GPU does not drive a display, or by the user.

**Effort**: service 1–2 days; app method, model card and prompt mapping 2 days; scribble and lasso prompts a
day more.

## Order

1. Step 1 (protocol), measured on SRB and AMOS.
2. Step 3 (nnInteractive), when a render computer with a free GPU is available.
3. SAM 2.1's tracker if step 1's per-section drift is the main error.
