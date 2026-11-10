/**
 * The Annotations panel's and the annotation table's own styles (the
 * Labels card has its own, in ./labels.ts): only what the app's shared
 * parts (cards, rows, fields, hints, the status line) do not give, in the
 * app's tokens.
 */
export const STYLE = `
.an { display: grid; gap: var(--sp-2); }
.an .stack > :empty { display: none; }
.an-end { display: flex; justify-content: flex-end; }
.an-inline { display: flex; gap: var(--sp-2); align-items: center; }
.an-inline .num-input { width: 0; flex: 1; min-width: 44px; }
.an-layer > .field { flex: 1 1 160px; }
.an-table-wrap { overflow-x: auto; }
.an-table { width: 100%; border-collapse: collapse; font-size: var(--fs-body); }
.an-table th { text-align: left; color: var(--faint); font-weight: 500; padding: var(--sp-1) var(--sp-2); white-space: nowrap; }
.an-table td { padding: 3px var(--sp-2); border-top: 1px solid var(--line); overflow-wrap: anywhere; }
.an-table .num { text-align: right; font-family: var(--mono); font-size: var(--fs-caption); white-space: nowrap; overflow-wrap: normal; }
.an-click { cursor: pointer; }
.an-click:hover td { background: var(--hover); }
.an-current td { background: var(--select-soft); }
.an-results { display: grid; gap: var(--sp-3); }
.an-result { border: 1px solid var(--line); padding: var(--sp-3) var(--sp-4); display: grid; gap: var(--sp-2); }
.an-result-head { display: grid; gap: var(--sp-1); font-size: var(--fs-body); }
.an-result-head .faint { font-size: var(--fs-caption); }
.an-facts { display: grid; grid-template-columns: auto 1fr auto 1fr; gap: var(--sp-1) var(--sp-4); margin: 0; font-size: var(--fs-body); }
.an-facts dt { color: var(--faint); }
.an-facts dd { margin: 0; font: var(--fs-caption)/1.5 var(--mono); text-align: right; white-space: nowrap; }
.an-plot-wrap { display: grid; gap: var(--sp-1); }
.an-plot { width: 100%; height: auto; display: block; }
.an-plot .an-grid { stroke: var(--line); stroke-width: 1; }
.an-plot .an-axis { stroke: var(--line-strong); stroke-width: 1; }
.an-plot .an-tick { fill: var(--faint); font: var(--fs-caption) var(--mono); }
.an-plot .an-line { fill: none; stroke: var(--select); stroke-width: 2; stroke-linejoin: round; }
.an-plot .an-cross { stroke: var(--muted); stroke-width: 1; stroke-dasharray: 2 2; }
.an-plot .an-dot { fill: var(--select); stroke: var(--ink-2); stroke-width: 2; }
.an-readout { font: var(--fs-caption) var(--mono); color: var(--muted); min-height: 1.2em; }
.an-groups, .an-fields { display: grid; gap: var(--sp-1); }
.an-group { display: flex; gap: var(--sp-2); align-items: center; }
.an-group[data-depth="1"] { padding-left: 14px; }
.an-group[data-depth="2"] { padding-left: 28px; }
.an-group[data-depth="3"] { padding-left: 42px; }
.an-group[data-depth="4"] { padding-left: 56px; }
.an-group[data-depth="5"] { padding-left: 70px; }
.an-group[data-depth="6"] { padding-left: 84px; }
.an-group > input.text-input { flex: 1; min-width: 50px; }
.an-group.an-active > input.text-input { border-color: var(--select); }
.an-group .an-group-parent { width: 22px; flex: none; padding: 0; color: transparent; cursor: pointer; }
.an-group .an-group-parent option { color: var(--text); background: var(--ink-1); }
.an-group.an-dim > input.text-input { color: var(--faint); }
.an-count { font: var(--fs-caption) var(--mono); min-width: 2ch; text-align: right; }
.an-field-row { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: var(--sp-3); align-items: center; font-size: var(--fs-body); }
.an-field-row .faint { font-size: var(--fs-caption); }
.an-form { padding-top: var(--sp-4); border-top: 1px dashed var(--line); }
.an-textarea { width: 100%; min-height: 0; resize: vertical; font: var(--fs-body)/1.4 var(--ui); padding: var(--sp-2) var(--sp-3); height: auto; }
.an-table-panel { display: flex; flex-direction: column; gap: var(--sp-3); height: 100%; min-height: 0; }
.an-toolbar .an-search { flex: 1 1 260px; min-width: 160px; max-width: 520px; height: 24px; }
.an-toolbar select { height: 24px; width: auto; }
.an-table-body { display: grid; grid-template-columns: minmax(0, 1fr) 280px; gap: 10px; flex: 1; min-height: 0; }
.an-table-scroll { overflow: auto; min-height: 0; }
.an-table-scroll .an-table th { position: sticky; top: 0; background: var(--ink-2); z-index: 1; }
.an-table-scroll .an-table td { overflow-wrap: normal; white-space: nowrap; max-width: 320px; overflow: hidden; text-overflow: ellipsis; }
.an-sortable { cursor: pointer; user-select: none; }
.an-sortable:hover { color: var(--text); }
.an-editor { overflow: auto; min-height: 0; display: grid; gap: var(--sp-3); align-content: start; border-left: 1px solid var(--line); padding-left: 10px; font-size: var(--fs-body); }
.an-editor .field { display: grid; grid-template-columns: 80px minmax(0, 1fr); gap: var(--sp-3); align-items: center; }
.an-editor .field > span:first-child { color: var(--faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.an-editor .field .text-input, .an-editor select { width: 100%; height: 24px; min-width: 0; }
.an-editor .an-textarea { height: auto; }
.an-editor-head { display: grid; gap: var(--sp-1); }
.an-comment { border-left: 2px solid var(--line-strong); padding: var(--sp-1) 0 var(--sp-1) var(--sp-3); display: grid; gap: var(--sp-1); }
.an-comment > .faint { display: flex; align-items: center; justify-content: space-between; font-size: var(--fs-caption); }
.an-inline-wide { display: block; }
.an-inline-wide .text-input { width: 100%; }
.an-tip { position: absolute; pointer-events: none; max-width: 260px; background: var(--ink-1); border: 1px solid var(--line-strong); padding: var(--sp-2) var(--sp-4); font-size: var(--fs-body); line-height: 1.4; display: grid; gap: 1px; z-index: 5; }
.an-tip[hidden] { display: none; }
.an-tip .faint { font-size: var(--fs-caption); }
.an-tip-comment { font-style: italic; }
@media (max-width: 900px) { .an-table-body { grid-template-columns: minmax(0, 1fr); } .an-editor { border-left: 0; padding-left: 0; } }
`;
