import{g as x,h as g,p as c,i as f}from"./voxels-tXmgS9Zv.js";function s(a){return x(a.viewer.getState())}function u(a){return(a.viewer.getState().layers??[]).filter(n=>Array.isArray(n.annotations)).map(n=>({name:n.name,annotations:n.annotations}))}function w(a){return(a.point??a.pointA??a.center??a.points?.[0]??[]).length}function m(a,e,n){return g(a.viewer.layerTransform(e),s(a),n)}function v(a,e,n){const l=m(a,e,3),p=l([0,0,0]),d=[0,1,2].map(t=>l([0,1,2].map(o=>o===t?1:0)));if(n.some(t=>!Number.isFinite(p[t])))return;const i=new Float64Array(16);return i[15]=1,n.forEach((t,o)=>{for(let r=0;r<3;++r)i[4*o+r]=d[r][t]-p[t];i[4*o+3]=p[t]}),f(i)}function b(a,e,n){return c(a.viewer.layerTransform(e),n.voxelToRas,s(a))}const y=`
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
.an-block { display: grid; gap: 6px; }
.an-groups, .an-fields { display: grid; gap: 2px; }
.an-group { display: flex; gap: 4px; align-items: center; }
.an-group input[type="color"] { width: 22px; height: 22px; padding: 0; border: 1px solid var(--line); background: none; flex: none; }
.an-group .text-input { flex: 1; min-width: 50px; height: 24px; }
.an-group.an-active .text-input { border-color: var(--select); }
.an-group .an-group-parent { width: 18px; flex: none; height: 22px; padding: 0; border: 1px solid var(--line); background: var(--ink-1); color: transparent; cursor: pointer; }
.an-group .an-group-parent option { color: var(--text); background: var(--ink-1); }
.an-group.an-dim .text-input { color: var(--faint); }
.an-count { font: 11px var(--mono); min-width: 2ch; text-align: right; }
.an-field-row { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: 6px; align-items: center; font-size: 12px; }
.an-field-row .an-faint { font-size: 11px; }
.an-textarea { width: 100%; min-height: 0; resize: vertical; font: 12px/1.4 var(--ui); padding: 4px 6px; height: auto; }
.an-table-panel { display: flex; flex-direction: column; gap: 6px; height: 100%; min-height: 0; }
.an-toolbar .an-search { flex: 1 1 260px; min-width: 160px; max-width: 520px; height: 24px; }
.an-toolbar select { height: 24px; }
.an-table-body { display: grid; grid-template-columns: minmax(0, 1fr) 280px; gap: 10px; flex: 1; min-height: 0; }
.an-table-scroll { overflow: auto; min-height: 0; }
.an-table-scroll .an-table th { position: sticky; top: 0; background: var(--ink-2); z-index: 1; }
.an-table-scroll .an-table td { overflow-wrap: normal; white-space: nowrap; max-width: 320px; overflow: hidden; text-overflow: ellipsis; }
.an-sortable { cursor: pointer; user-select: none; }
.an-sortable:hover { color: var(--text); }
.an-editor { overflow: auto; min-height: 0; display: grid; gap: 6px; align-content: start; border-left: 1px solid var(--line); padding-left: 10px; font-size: 12px; }
.an-editor .field { display: grid; grid-template-columns: 80px minmax(0, 1fr); gap: 6px; align-items: center; }
.an-editor .field > span:first-child { color: var(--faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.an-editor .field .text-input, .an-editor select { width: 100%; height: 24px; min-width: 0; }
.an-editor .an-textarea { height: auto; }
.an-editor-head { display: grid; gap: 2px; }
.an-comment { border-left: 2px solid var(--line-strong); padding: 2px 0 2px 6px; display: grid; gap: 2px; }
.an-comment > .an-faint { display: flex; align-items: center; justify-content: space-between; font-size: 11px; }
.an-comment-x { height: 18px; }
.an-inline-wide { display: block; }
.an-inline-wide .text-input { width: 100%; }
.an-tip { position: absolute; pointer-events: none; max-width: 260px; background: rgba(12, 12, 12, 0.92); border: 1px solid var(--line-strong); padding: 4px 8px; font-size: 12px; line-height: 1.4; display: grid; gap: 1px; z-index: 5; }
.an-tip[hidden] { display: none; }
.an-tip .an-faint { font-size: 11px; }
.an-tip-comment { font-style: italic; }
@media (max-width: 900px) { .an-table-body { grid-template-columns: minmax(0, 1fr); } .an-editor { border-left: 0; padding-left: 0; } }
`;export{y as S,u as a,v as b,b as i,w as r,s,m as t};
