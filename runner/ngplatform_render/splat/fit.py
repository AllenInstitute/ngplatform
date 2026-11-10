"""Fits 3-D Gaussians to a captured folder (cameras.json, RGBA images, points.ply) with gsplat.

    python -m ngplatform_render.splat.fit FOLDER [--steps 30000] [--sh 3] [--scale 1] [--device cuda:0]

It needs torch and gsplat (a Python of its own; the render service's
`--splat-python`), gsplat at GSPLAT_VERSION, whose API it is written
against (`pip install ./runner[splat]`).  It runs on `--device`, which
the render service sets to its own GPU.  The views stay on the CPU, read
from their files as they are needed (as many held in memory as fit in
`--views-gb`), and go to the GPU one at a time.  The images have no background: each step draws the
Gaussians over a random colour and compares them with the image over the
same colour, so what is empty stays empty.  Gaussians start at the points
where the views first meet tissue and are grown, split and pruned by
gsplat's default strategy; the loss is 0.8 L1 + 0.2 (1 - SSIM), as in 3-D
Gaussian splatting.  Every eighth view is kept out of the fit and its
PSNR reported.  It writes `splat.ply`, `scene.splat` and `fit.json` into
the folder, and `[progress] f message` lines as it goes.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import time
from pathlib import Path

import numpy as np

from .export import write_ply, write_splat
from .views import read_points

#: The gsplat whose API the fit is written against (rasterization, DefaultStrategy).
GSPLAT_VERSION = "1.4.0"


def say(f: float, message: str) -> None:
    print(f"[progress] {f:.4f} {message}", flush=True)


def _ssim(a, b, torch, window: int = 11, sigma: float = 1.5):
    """Mean SSIM of two (1, 3, H, W) images in 0..1, with a Gaussian window."""
    F = torch.nn.functional
    x = torch.arange(window, dtype=a.dtype, device=a.device) - window // 2
    g = torch.exp(-(x * x) / (2 * sigma * sigma))
    g = g / g.sum()
    w = (g[:, None] * g[None, :]).expand(3, 1, window, window).contiguous()
    blur = lambda t: F.conv2d(t, w, padding=window // 2, groups=3)  # noqa: E731
    mu_a, mu_b = blur(a), blur(b)
    saa, sbb, sab = blur(a * a) - mu_a ** 2, blur(b * b) - mu_b ** 2, blur(a * b) - mu_a * mu_b
    c1, c2 = 0.01 ** 2, 0.03 ** 2
    return (((2 * mu_a * mu_b + c1) * (2 * sab + c2)) / ((mu_a ** 2 + mu_b ** 2 + c1) * (saa + sbb + c2))).mean()


def _knn_spacing(points, torch, k: int = 3, chunk: int = 2048):
    """Mean distance from each point to its `k` nearest others."""
    out = torch.empty(len(points), device=points.device)
    for i in range(0, len(points), chunk):
        d = torch.cdist(points[i:i + chunk], points)
        out[i:i + chunk] = d.topk(k + 1, largest=False).values[:, 1:].mean(1)
    return out


class Views:
    """The captured views (RGBA, H x W x 4 uint8), read from their files as the fit asks for them: the most recently
    used held in host memory up to `max_bytes`, and one at a time on the GPU (256 views of 1024 px were a GB of
    GPU memory held for the whole fit; 4096 of 4096 px would not have fitted at all)."""

    def __init__(self, folder: Path, frames: list[dict], scale: int, max_bytes: int):
        from collections import OrderedDict

        self.folder, self.frames, self.scale, self.max_bytes = folder, frames, scale, max_bytes
        self._held: OrderedDict[int, np.ndarray] = OrderedDict()
        self.bytes = 0
        self.reads = 0

    def __len__(self) -> int:
        return len(self.frames)

    def host(self, i: int) -> np.ndarray:
        a = self._held.get(i)
        if a is not None:
            self._held.move_to_end(i)
            return a
        from PIL import Image

        im = Image.open(self.folder / self.frames[i]["file"]).convert("RGBA")
        if self.scale > 1:
            im = im.resize((im.width // self.scale, im.height // self.scale), Image.LANCZOS)
        a = np.ascontiguousarray(np.asarray(im))
        self.reads += 1
        if a.nbytes <= self.max_bytes:
            self._held[i] = a
            self.bytes += a.nbytes
            while self.bytes > self.max_bytes:
                _, old = self._held.popitem(last=False)
                self.bytes -= old.nbytes
        return a

    def get(self, i: int, device):
        """View i on `device` (a torch tensor)."""
        import torch

        return torch.from_numpy(self.host(i)).to(device, non_blocking=True)


def load(folder: Path, scale: int, device, views_bytes: int = 4 << 30):
    """The capture's cameras (on `device`: small) and its views (on the CPU, read as needed)."""
    import torch

    meta = json.loads((folder / "cameras.json").read_text())
    viewmats, Ks = [], []
    for fr in meta["frames"]:
        K = np.asarray(fr["K"], np.float64).copy()
        if scale > 1:
            K[:2] /= scale
        viewmats.append(np.linalg.inv(np.asarray(fr["c2w"], np.float64)))
        Ks.append(K)
    viewmats = torch.tensor(np.stack(viewmats), dtype=torch.float32, device=device)
    Ks = torch.tensor(np.stack(Ks), dtype=torch.float32, device=device)
    return meta, Views(folder, meta["frames"], scale, views_bytes), viewmats, Ks


def fit(folder: Path, steps: int = 30000, sh_degree: int = 3, scale: int = 1, max_points: int = 300_000, seed: int = 0,
        device: str = "cuda", views_gb: float = 4.0) -> dict:
    import gsplat
    import torch
    from gsplat import rasterization
    from gsplat.strategy import DefaultStrategy

    started = time.time()
    torch.manual_seed(seed)
    device = torch.device(device)
    if device.type == "cuda":
        torch.cuda.set_device(device)
    folder = Path(folder)
    version = str(getattr(gsplat, "__version__", "?"))
    if version != GSPLAT_VERSION:
        print(f"gsplat {version}: the fit is written for {GSPLAT_VERSION}", file=sys.stderr, flush=True)
    say(0.0, "reading the views")
    meta, images, viewmats, Ks = load(folder, scale, device, int(views_gb * (1 << 30)))
    n = len(images)
    held = list(range(7, n, 8)) if n >= 16 else []
    train = [i for i in range(n) if i not in set(held)]
    scene_scale = float(meta["radius"]) * 1.1

    # The starting Gaussians: the points where the views met tissue.
    xyz, rgb = read_points(folder / "points.ply")
    if len(xyz) == 0:
        raise SystemExit("points.ply has no points: no view met tissue")
    if len(xyz) > max_points:
        keep = np.random.default_rng(seed).choice(len(xyz), max_points, replace=False)
        xyz, rgb = xyz[keep], rgb[keep]
    means = torch.tensor(xyz, dtype=torch.float32, device=device)
    spacing = _knn_spacing(means, torch).clamp_min(1e-6)
    N = len(means)
    C0 = 0.28209479177387814
    K_sh = (sh_degree + 1) ** 2
    params = torch.nn.ParameterDict({
        "means": torch.nn.Parameter(means),
        "scales": torch.nn.Parameter(torch.log(spacing)[:, None].repeat(1, 3)),
        "quats": torch.nn.Parameter(torch.nn.functional.normalize(torch.randn(N, 4, device=device), dim=-1)),
        "opacities": torch.nn.Parameter(torch.logit(torch.full((N,), 0.1, device=device))),
        "sh0": torch.nn.Parameter(((torch.tensor(rgb, device=device) - 0.5) / C0)[:, None, :]),
        "shN": torch.nn.Parameter(torch.zeros(N, K_sh - 1, 3, device=device)),
    })
    lrs = {"means": 1.6e-4 * scene_scale, "scales": 5e-3, "quats": 1e-3, "opacities": 5e-2, "sh0": 2.5e-3, "shN": 2.5e-3 / 20}
    optimizers = {k: torch.optim.Adam([{"params": params[k], "lr": lr, "name": k}], eps=1e-15) for k, lr in lrs.items()}
    means_decay = torch.optim.lr_scheduler.ExponentialLR(optimizers["means"], gamma=0.01 ** (1.0 / steps))
    strategy = DefaultStrategy(refine_stop_iter=min(15000, steps // 2), reset_every=3000, refine_every=100, verbose=False)
    strategy.check_sanity(params, optimizers)
    state = strategy.initialize_state(scene_scale=scene_scale)

    def draw(i: int, sh_use: int, bg, im):
        H, W = im.shape[:2]
        colors = torch.cat([params["sh0"], params["shN"]], 1)
        out, alpha, info = rasterization(
            means=params["means"], quats=params["quats"], scales=torch.exp(params["scales"]),
            opacities=torch.sigmoid(params["opacities"]), colors=colors,
            viewmats=viewmats[i:i + 1], Ks=Ks[i:i + 1], width=W, height=H, sh_degree=sh_use,
            packed=False, backgrounds=bg[None],
        )
        return out[0], alpha[0], info

    def target(im, bg):
        im = im.float() / 255
        a = im[..., 3:4]
        return im[..., :3] * a + bg * (1 - a)  # the images' colours are not premultiplied

    loss_avg = 0.0
    for step in range(steps):
        i = train[int(torch.randint(len(train), ()).item())]
        bg = torch.rand(3, device=device)
        sh_use = min(step // 1000, sh_degree)
        im = images.get(i, device)
        out, _, info = draw(i, sh_use, bg, im)
        gt = target(im, bg)
        l1 = (out - gt).abs().mean()
        ss = _ssim(out.permute(2, 0, 1)[None], gt.permute(2, 0, 1)[None], torch)
        loss = 0.8 * l1 + 0.2 * (1 - ss)
        strategy.step_pre_backward(params, optimizers, state, step, info)
        loss.backward()
        for opt in optimizers.values():
            opt.step()
            opt.zero_grad(set_to_none=True)
        means_decay.step()
        strategy.step_post_backward(params, optimizers, state, step, info, packed=False)
        loss_avg = 0.98 * loss_avg + 0.02 * float(loss.item()) if step else float(loss.item())
        if step % 100 == 0 or step == steps - 1:
            say(0.02 + 0.93 * (step + 1) / steps, f"step {step + 1} of {steps}: loss {loss_avg:.4f}, {len(params['means'])} Gaussians")

    say(0.96, "measuring the held-out views")
    psnr = []
    with torch.no_grad():
        for i in held:
            bg = torch.zeros(3, device=device)
            im = images.get(i, device)
            out, _, _ = draw(i, sh_degree, bg, im)
            mse = float(((out.clamp(0, 1) - target(im, bg)) ** 2).mean())
            psnr.append(10 * math.log10(1 / max(mse, 1e-10)))
    say(0.98, "writing the splat")
    g = {k: v.detach().cpu().numpy() for k, v in params.items()}
    sh = np.concatenate([g["sh0"], g["shN"]], 1)
    write_ply(folder / "splat.ply", g["means"], g["scales"], g["quats"], g["opacities"], sh)
    write_splat(folder / "scene.splat", g["means"], g["scales"], g["quats"], g["opacities"], sh)
    result = {
        "gaussians": int(len(g["means"])), "steps": steps, "sh_degree": sh_degree, "scale": scale,
        "views": n, "held_out": len(held), "psnr_held_out": round(float(np.mean(psnr)), 2) if psnr else None,
        "seconds": round(time.time() - started, 1), "gsplat": version, "device": str(device),
        "files": {"ply": "splat.ply", "splat": "scene.splat"},
    }
    (folder / "fit.json").write_text(json.dumps(result, indent=1))
    say(1.0, f"{result['gaussians']} Gaussians" + (f", held-out PSNR {result['psnr_held_out']} dB" if psnr else ""))
    return result


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("folder", type=Path, help="a folder the render service captured (cameras.json, images, points.ply)")
    p.add_argument("--steps", type=int, default=30000)
    p.add_argument("--sh", type=int, default=3, help="spherical harmonics degree of the colours (0-3)")
    p.add_argument("--scale", type=int, default=1, help="fit to the images made this many times smaller")
    p.add_argument("--max-points", type=int, default=300_000, help="starting Gaussians at most")
    p.add_argument("--device", default="cuda", help="the torch device to fit on (the render service gives its own GPU, cuda:N)")
    p.add_argument("--views-gb", type=float, default=4.0, help="host memory for views held between steps (the rest are read again from their files)")
    a = p.parse_args(argv)
    if not (a.folder / "cameras.json").is_file():
        print(f"{a.folder} has no cameras.json", file=sys.stderr)
        return 2
    fit(a.folder, a.steps, max(0, min(3, a.sh)), max(1, a.scale), a.max_points, device=a.device, views_gb=a.views_gb)
    return 0


if __name__ == "__main__":
    sys.exit(main())
