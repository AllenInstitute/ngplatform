/** The Annotations tab's styles (the Labels section has its own, in ./labels.ts). */
export const STYLE = `
.an { display: grid; gap: 4px; }
.an-section { border-bottom: 1px solid var(--line); padding: 6px 0 10px; }
.an-section:last-child { border-bottom: 0; }
.an-section > summary { cursor: pointer; list-style: none; display: flex; align-items: center; gap: 6px; margin: 0; padding: 4px 0; user-select: none; }
.an-section > summary::-webkit-details-marker { display: none; }
.an-section > summary::before { content: "▸"; color: var(--faint); font-size: 10px; width: 10px; }
.an-section[open] > summary::before { content: "▾"; }
.an-body { display: grid; gap: 8px; padding-top: 6px; }
.an-row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.an-spacer { flex: 1; }
.an-sub { margin: 6px 0 0; font: 600 11px/1 var(--ui); color: var(--muted); }
.an-hint { color: var(--faint); font-size: 12px; margin: 0; line-height: 1.4; }
.an-caption { color: var(--muted); font-size: 12px; margin: 0; }
.an-faint { color: var(--faint); }
.an-grid2 { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 8px; align-items: end; }
.an-grid2 select, .an-grid2 .text-input { min-width: 0; width: 100%; }
.an-end { display: flex; justify-content: flex-end; }
.an-inline { display: flex; gap: 4px; align-items: center; }
.an-inline .an-num { width: 0; flex: 1; min-width: 44px; }
.an-grid2 .an-inline select { width: auto; flex: none; }
.an-num { height: 24px; padding: 0 4px; font: 12px/1 var(--mono); min-width: 0; width: 64px; }
.an-tools { align-self: start; }
.an-table-wrap { overflow-x: auto; }
.an-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.an-table th { text-align: left; color: var(--faint); font-weight: 500; padding: 2px 4px; white-space: nowrap; }
.an-table td { padding: 3px 4px; border-top: 1px solid var(--line); overflow-wrap: anywhere; }
.an-table .num { text-align: right; font-family: var(--mono); font-size: 11px; white-space: nowrap; overflow-wrap: normal; }
.an-click { cursor: pointer; }
.an-click:hover td { background: var(--ink-3); }
.an-current td { background: var(--select-soft); }
.an-results { display: grid; gap: 6px; }
.an-result { border: 1px solid var(--line); padding: 6px 8px; display: grid; gap: 4px; }
.an-result-head { display: grid; gap: 2px; font-size: 12px; }
.an-result-head .an-faint { font-size: 11px; }
.an-facts { display: grid; grid-template-columns: auto 1fr auto 1fr; gap: 2px 8px; margin: 0; font-size: 12px; }
.an-facts dt { color: var(--faint); }
.an-facts dd { margin: 0; font: 11px/1.5 var(--mono); text-align: right; white-space: nowrap; }
.an-plot-wrap { display: grid; gap: 2px; }
.an-plot { width: 100%; height: auto; display: block; }
.an-plot .an-grid { stroke: var(--line); stroke-width: 1; }
.an-plot .an-axis { stroke: var(--line-strong); stroke-width: 1; }
.an-plot .an-tick { fill: var(--faint); font: 10px var(--mono); }
.an-plot .an-line { fill: none; stroke: var(--select); stroke-width: 2; stroke-linejoin: round; }
.an-plot .an-cross { stroke: var(--muted); stroke-width: 1; stroke-dasharray: 2 2; }
.an-plot .an-dot { fill: var(--select); stroke: var(--ink-2); stroke-width: 2; }
.an-readout { font: 11px var(--mono); color: var(--muted); min-height: 1.2em; }
.an-seg { display: grid; gap: 8px; }
.an-session strong { font-weight: 600; }
.an-label input[type="color"] { width: 28px; height: 24px; padding: 0; border: 1px solid var(--line); background: none; }
.an-label .text-input { flex: 1; min-width: 60px; height: 24px; }
.an-swatch { display: inline-block; width: 10px; height: 10px; border: 1px solid rgba(255, 255, 255, 0.3); vertical-align: -1px; }
.an-swatch.big { width: 16px; height: 16px; }
.an-limit { display: grid; gap: 6px; }
.an-form { display: grid; gap: 8px; padding-bottom: 8px; border-bottom: 1px dashed var(--line); }
.an-ring { position: absolute; pointer-events: none; border: 1.5px solid rgba(255, 255, 255, 0.85); border-radius: 50%; transform: translate(-50%, -50%); box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.5); }
.an-box { position: absolute; pointer-events: none; border: 1.5px dashed #ffd166; background: rgba(255, 209, 102, 0.08); }
.view-overlay.an-drawing { cursor: crosshair; }
`;
