/**
 * The Segmentation tab's and tool bar's styles.  The tab's forms use the
 * Annotations tab's shared ones (rows, grids, fields), added with these.
 */
import { STYLE as ANNOTATIONS_STYLE } from "../annotations/style.js";

export const STYLE =
  ANNOTATIONS_STYLE +
  `
.sg { display: grid; gap: 10px; }
.sg-head { display: grid; gap: 2px; padding-bottom: 6px; border-bottom: 1px solid var(--line); }
.sg-head strong { font-weight: 600; overflow-wrap: anywhere; }
.sg-size { font-size: 11px; }
.sg-session { display: grid; gap: 8px; }
.sg-save { display: grid; gap: 4px; }
.sg-list { display: grid; gap: 6px; }
.sg-segments { display: grid; max-height: 320px; overflow-y: auto; border: 1px solid var(--line); }
.sg-segments:empty { display: none; }
.sg-segment { display: grid; grid-template-columns: 22px 20px auto minmax(0, 1fr) auto auto; gap: 6px; align-items: center; padding: 2px 4px 2px 2px; border-left: 3px solid transparent; font-size: 12px; cursor: pointer; }
.sg-segment + .sg-segment { border-top: 1px solid var(--line); }
.sg-segment:hover { background: var(--ink-3); }
.sg-segment.sg-active { border-left-color: var(--select); background: var(--select-soft); }
.sg-segment.sg-active .sg-id { color: var(--text); font-weight: 600; }
.sg-segment input[type="color"] { width: 18px; height: 18px; padding: 0; border: 1px solid rgba(255, 255, 255, 0.3); background: none; cursor: pointer; }
.sg-segment input[type="color"]::-webkit-color-swatch-wrapper { padding: 0; }
.sg-segment input[type="color"]::-webkit-color-swatch { border: 0; }
.sg-id { font: 11px var(--mono); color: var(--muted); }
.sg-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sg-segment .text-input.sg-name { height: 22px; min-width: 0; width: 100%; }
.sg-count { font: 11px var(--mono); color: var(--muted); text-align: right; }
.sg-actions { display: flex; gap: 0; }
.sg-icon { display: inline-grid; place-items: center; width: 22px; height: 22px; padding: 0; border: 0; background: none; color: var(--muted); cursor: pointer; }
.sg-icon:hover:not(:disabled) { color: var(--text); background: var(--ink-4); }
.sg-icon:disabled { color: var(--faint); opacity: 0.5; cursor: default; }
.sg-icon svg { width: 15px; height: 15px; }
.sg-segment .sg-icon[aria-pressed="false"] { color: var(--faint); }
.an-limit { display: grid; gap: 6px; }
.an-kept { display: grid; gap: 4px; font-size: 12px; }
.an-form { display: grid; gap: 8px; padding-bottom: 8px; border-bottom: 1px dashed var(--line); }

.sg-bar {
  position: absolute; transform: translateX(-50%); pointer-events: auto; z-index: 2;
  display: flex; align-items: center; gap: 2px; padding: 3px; width: max-content; max-width: calc(100% - 16px); flex-wrap: wrap; justify-content: center;
  background: rgba(12, 12, 12, 0.9); border: 1px solid var(--line-strong); box-shadow: 0 2px 8px rgba(0, 0, 0, 0.5);
  font: 12px var(--ui); color: var(--text);
}
.sg-bar[hidden] { display: none; }
.sg-group { display: flex; align-items: center; gap: 1px; }
.sg-group + .sg-group { border-left: 1px solid var(--line); padding-left: 3px; margin-left: 2px; }
.sg-bar .sg-icon { width: 26px; height: 26px; color: var(--muted); }
.sg-bar .sg-icon svg { width: 17px; height: 17px; }
.sg-bar .sg-icon[aria-pressed="true"] { color: var(--accent-ink); background: var(--accent); }
.sg-value { min-width: 64px; text-align: center; font: 11px var(--mono); color: var(--text); }
.sg-chip { width: 14px; height: 14px; border: 1px solid rgba(255, 255, 255, 0.4); margin: 0 2px 0 4px; flex: none; }
.sg-segment-select { max-width: 150px; height: 24px; background: var(--ink-0); color: var(--text); border: 1px solid var(--line); font: 12px var(--ui); }
.sg-dims button { height: 24px; padding: 0 8px; font-size: 12px; }
.sg-bar .sg-icon.sg-unsaved { color: var(--warn); }
.sg-bar .sg-icon.sg-accept { color: var(--ok, #7bd88f); }

.sg-ring { position: absolute; pointer-events: none; border: 1.5px solid rgba(255, 255, 255, 0.85); border-radius: 50%; transform: translate(-50%, -50%); box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.5); }
.sg-box { position: absolute; pointer-events: none; border: 1.5px dashed #ffd166; background: rgba(255, 209, 102, 0.08); }
.sg-path { position: absolute; left: 0; top: 0; width: 100%; height: 100%; pointer-events: none; overflow: visible; }
.sg-path polygon { fill: rgba(255, 209, 102, 0.12); stroke: #ffd166; stroke-width: 1.5; stroke-linejoin: round; }
.sg-preview { position: absolute; left: 0; top: 0; pointer-events: none; }
.sg-preview[hidden] { display: none; }
`;
