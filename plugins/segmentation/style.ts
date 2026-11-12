/**
 * The Segmentation panel's and tool bar's styles: only what the app's
 * shared parts (cards, rows, fields, hints, the status line) do not give,
 * in the app's tokens.
 */
export const STYLE = `
.sg { display: grid; gap: var(--sp-4); }
.sg-head { display: grid; gap: var(--sp-1); }
.sg-head:empty { display: none; }
.sg-head strong { font-weight: 600; overflow-wrap: anywhere; }
.sg .grid-2 { align-items: end; }
.sg .grid-2 .field > select, .sg .grid-2 .field > .text-input { min-width: 0; }
.sg-wide { grid-column: 1 / -1; }
.sg-inline { display: flex; gap: var(--sp-2); align-items: center; }
.sg-inline .num-input { width: 0; flex: 1; min-width: 44px; }
.sg-inline select.text-input { width: auto; flex: none; }
.sg-save { align-items: end; }
.sg-active-value { gap: var(--sp-3); }
/* Room for a 32-bit id (ten digits): a copied segmentation's run past the shared field's 64 px. */
.sg-active-value .num-input { width: calc(10ch + 2 * var(--sp-2) + 2px); }
.sg-kept-row { flex-wrap: nowrap; }
.sg-kept-name { display: grid; flex: 1; min-width: 0; }
.sg-kept-name > span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sg-model { padding: var(--sp-3) var(--sp-4); border: 1px solid var(--line); font-size: var(--fs-body); }
.sg-bar-progress { width: 100%; height: 8px; }

.sg-segments { display: grid; max-height: 320px; overflow-y: auto; border: 1px solid var(--line); }
.sg-segments:empty { display: none; }
.sg-segments.sg-virtual { display: block; }
.sg-virtual-space { position: relative; }
.sg-virtual .sg-segment, .sg-virtual .sg-group-head { height: 27px; box-sizing: border-box; }
.sg-segment { display: grid; grid-template-columns: 22px 20px auto minmax(0, 1fr) auto auto; gap: var(--sp-3); align-items: center; padding: var(--sp-1) var(--sp-2) var(--sp-1) var(--sp-1); border-left: 3px solid transparent; font-size: var(--fs-body); cursor: pointer; }
.sg-segment + .sg-segment { border-top: 1px solid var(--line); }
.sg-segment:hover { background: var(--hover); }
.sg-segment.sg-active { border-left-color: var(--select); background: var(--select-soft); }
.sg-segment.sg-active .sg-id { color: var(--text); font-weight: 600; }
.sg-segment .colour-input, .sg-group-head .colour-input { width: 18px; height: 18px; padding: 0; border-color: var(--swatch-line); background: none; cursor: pointer; }
.sg-segment .colour-input::-webkit-color-swatch-wrapper, .sg-group-head .colour-input::-webkit-color-swatch-wrapper { padding: 0; }
.sg-segment .colour-input::-webkit-color-swatch, .sg-group-head .colour-input::-webkit-color-swatch { border: 0; }
.sg-id { font: var(--fs-caption) var(--mono); color: var(--muted); }
.sg-group-head { display: grid; grid-template-columns: 16px 22px 20px minmax(0, 1fr) auto auto; gap: var(--sp-3); align-items: center; padding: var(--sp-1) var(--sp-2) var(--sp-1) var(--sp-1); font-size: var(--fs-body); background: var(--ink-3); border-top: 1px solid var(--line); }
.sg-group-head:first-child { border-top: 0; }
.sg-group-head.sg-ungrouped { grid-template-columns: 16px minmax(0, 1fr) auto; }
.sg-group-head.sg-drop { outline: 1px dashed var(--select); outline-offset: -2px; }
.sg-group-head .text-input.sg-name { height: 22px; min-width: 0; width: 100%; font-weight: 600; }
.sg-group-head .sg-icon[aria-pressed="false"] { color: var(--faint); }
.sg-caret { width: 16px; padding: 0; border: 0; background: none; color: var(--muted); cursor: pointer; font-size: var(--fs-caption); }
.sg-segment.sg-in-group { padding-left: 14px; }
.sg-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sg-segment .text-input.sg-name { height: 22px; min-width: 0; width: 100%; }
.sg-count { font: var(--fs-caption) var(--mono); color: var(--muted); text-align: right; }
.sg-actions { display: flex; gap: 0; }
.sg-icon { display: inline-grid; place-items: center; width: 22px; height: 22px; padding: 0; border: 0; background: none; color: var(--muted); cursor: pointer; }
.sg-icon:hover:not(:disabled) { color: var(--text); background: var(--ink-4); }
.sg-icon:disabled { color: var(--faint); opacity: 0.5; cursor: default; }
.sg-icon svg { width: 15px; height: 15px; }
.sg-segment .sg-icon[aria-pressed="false"] { color: var(--faint); }

.sg-bar {
  position: absolute; transform: translateX(-50%); pointer-events: auto; z-index: 2;
  display: flex; align-items: center; gap: var(--sp-1); padding: 3px; width: max-content; max-width: calc(100% - 16px); flex-wrap: wrap; justify-content: center;
  background: var(--ink-1); border: 1px solid var(--line-strong); box-shadow: var(--shadow-float);
  font: var(--fs-body) var(--ui); color: var(--text);
}
.sg-bar[hidden] { display: none; }
.sg-group { display: flex; align-items: center; gap: 1px; }
.sg-group + .sg-group { border-left: 1px solid var(--line); padding-left: 3px; margin-left: var(--sp-1); }
.sg-bar .sg-icon { width: 26px; height: 26px; color: var(--muted); }
.sg-bar .sg-icon svg { width: 17px; height: 17px; }
.sg-bar .sg-icon[aria-pressed="true"] { color: var(--accent-ink); background: var(--accent); }
.sg-value { min-width: 64px; text-align: center; font: var(--fs-caption) var(--mono); color: var(--text); }
.sg-chip { width: 14px; height: 14px; border: 1px solid var(--swatch-line); margin: 0 var(--sp-1) 0 var(--sp-2); flex: none; }
.sg-bar .sg-segment-select { width: 170px; height: 24px; font-size: var(--fs-body); }
.sg-picker { position: relative; display: inline-flex; }
.sg-picker-list { position: absolute; top: calc(100% + 2px); left: 0; z-index: 3; min-width: 220px; max-height: 280px; overflow-y: auto; background: var(--ink-1); border: 1px solid var(--line-strong); box-shadow: var(--shadow-float); }
.sg-picker-list[hidden] { display: none; }
.sg-picker-option { display: flex; align-items: center; gap: var(--sp-3); padding: var(--sp-1) var(--sp-3); cursor: pointer; white-space: nowrap; }
.sg-picker-option:hover { background: var(--hover); }
.sg-picker-option.sg-active { background: var(--select-soft); }
.sg-picker-option .sg-chip { margin: 0; }
.sg-picker-more { padding: var(--sp-2) var(--sp-3); }
.sg-dims button { height: 24px; padding: 0 var(--sp-4); font-size: var(--fs-body); }
.sg-bar .sg-icon.sg-unsaved { color: var(--warn); }
.sg-bar .sg-icon.sg-accept { color: var(--text); }
.sg-bar .segmented + .segmented { margin-left: var(--sp-2); }
.sg-text { height: 24px; padding: 0 var(--sp-4); font: var(--fs-body) var(--ui); color: var(--text); background: var(--ink-2); border: 1px solid var(--line); cursor: pointer; }
.sg-text:hover { background: var(--ink-4); }
.sg-status { max-width: 300px; padding: 0 var(--sp-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--fs-body); color: var(--text); }
.sg-progress { width: 120px; height: 8px; }

.sg-ring { position: absolute; pointer-events: none; border: 1.5px solid var(--text-strong); border-radius: 50%; transform: translate(-50%, -50%); box-shadow: 0 0 0 1px var(--scrim); }
.sg-box { position: absolute; pointer-events: none; border: 1.5px dashed var(--warn); background: color-mix(in srgb, var(--warn) 8%, transparent); }
.sg-path { position: absolute; left: 0; top: 0; width: 100%; height: 100%; pointer-events: none; overflow: visible; }
.sg-path polygon { fill: color-mix(in srgb, var(--warn) 12%, transparent); stroke: var(--warn); stroke-width: 1.5; stroke-linejoin: round; }
.sg-preview { position: absolute; left: 0; top: 0; pointer-events: none; }
.sg-preview[hidden] { display: none; }
`;
