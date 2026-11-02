/**
 * A small line plot for a profile: one series, a 2 px line, recessive axes
 * with a few round ticks, and a crosshair that reads out the value under
 * the pointer.  Plain SVG, sized to its container's width.
 */
import { el, fmt } from "./ui.js";

const NS = "http://www.w3.org/2000/svg";

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

/** About `count` round tick values covering [lo, hi]. */
export function ticks(lo: number, hi: number, count = 4): number[] {
  if (!(hi > lo)) return [lo];
  const raw = (hi - lo) / count;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * power).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Number(v.toPrecision(12)));
  return out;
}

export function linePlot(xs: ArrayLike<number>, ys: ArrayLike<number>, labels: { x: string; y: string }, width = 276, height = 150): HTMLElement {
  const pad = { left: 44, right: 8, top: 8, bottom: 26 };
  const w = width - pad.left - pad.right;
  const h = height - pad.top - pad.bottom;
  const finite = Array.from(ys).filter(Number.isFinite);
  let lo = finite.length ? Math.min(...finite) : 0;
  let hi = finite.length ? Math.max(...finite) : 1;
  if (hi === lo) {
    lo -= 1;
    hi += 1;
  }
  const x0 = xs[0] ?? 0;
  const x1 = xs[xs.length - 1] ?? 1;
  const sx = (x: number) => pad.left + ((x - x0) / (x1 - x0 || 1)) * w;
  const sy = (y: number) => pad.top + (1 - (y - lo) / (hi - lo)) * h;
  const root = svg("svg", { viewBox: `0 0 ${width} ${height}`, class: "an-plot", role: "img", "aria-label": `${labels.y} against ${labels.x}` });
  for (const t of ticks(lo, hi)) {
    root.append(svg("line", { x1: pad.left, x2: pad.left + w, y1: sy(t), y2: sy(t), class: "an-grid" }));
    const label = svg("text", { x: pad.left - 4, y: sy(t) + 3, class: "an-tick", "text-anchor": "end" });
    label.textContent = fmt(t, 3);
    root.append(label);
  }
  for (const t of ticks(x0, x1)) {
    const label = svg("text", { x: sx(t), y: pad.top + h + 14, class: "an-tick", "text-anchor": "middle" });
    label.textContent = fmt(t, 3);
    root.append(label);
  }
  root.append(svg("line", { x1: pad.left, x2: pad.left + w, y1: pad.top + h, y2: pad.top + h, class: "an-axis" }));
  const xLabel = svg("text", { x: pad.left + w, y: height - 1, class: "an-tick", "text-anchor": "end" });
  xLabel.textContent = labels.x;
  root.append(xLabel);
  // Gaps (NaN, outside the image) break the line.
  let d = "";
  let pen = false;
  for (let i = 0; i < xs.length; ++i) {
    if (!Number.isFinite(ys[i])) {
      pen = false;
      continue;
    }
    d += `${pen ? "L" : "M"}${sx(xs[i]).toFixed(1)},${sy(ys[i]).toFixed(1)}`;
    pen = true;
  }
  root.append(svg("path", { d, class: "an-line" }));
  const cross = svg("line", { y1: pad.top, y2: pad.top + h, class: "an-cross", visibility: "hidden" });
  const dot = svg("circle", { r: 4, class: "an-dot", visibility: "hidden" });
  root.append(cross, dot);
  const readout = el("div", { class: "an-readout" }, " ");
  // The hover target is the whole plot area, wider than the line.
  const hit = svg("rect", { x: pad.left, y: pad.top, width: w, height: h, fill: "transparent" });
  root.append(hit);
  hit.addEventListener("pointermove", (e) => {
    const box = root.getBoundingClientRect();
    const x = ((e.clientX - box.left) / box.width) * width;
    const t = x0 + ((x - pad.left) / w) * (x1 - x0);
    let best = 0;
    for (let i = 1; i < xs.length; ++i) if (Math.abs(xs[i] - t) < Math.abs(xs[best] - t)) best = i;
    cross.setAttribute("x1", String(sx(xs[best])));
    cross.setAttribute("x2", String(sx(xs[best])));
    cross.setAttribute("visibility", "visible");
    if (Number.isFinite(ys[best])) {
      dot.setAttribute("cx", String(sx(xs[best])));
      dot.setAttribute("cy", String(sy(ys[best])));
      dot.setAttribute("visibility", "visible");
    } else dot.setAttribute("visibility", "hidden");
    readout.textContent = `${labels.x}: ${fmt(xs[best])} · ${labels.y}: ${fmt(ys[best])}`;
  });
  hit.addEventListener("pointerleave", () => {
    cross.setAttribute("visibility", "hidden");
    dot.setAttribute("visibility", "hidden");
    readout.textContent = " ";
  });
  return el("div", { class: "an-plot-wrap" }, root as unknown as Node, readout);
}
