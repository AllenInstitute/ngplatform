/** The view aids' styles: square, the app's greys, 24 px controls. */
export const STYLE = `
.view-aids-labels { position: absolute; pointer-events: none; }
.view-aids-cube { position: absolute; width: 64px; display: grid; gap: var(--sp-2); pointer-events: none; }
.view-aids-cube-canvas { display: block; pointer-events: auto; }
.view-aids-cube-buttons { display: flex; justify-content: center; gap: var(--sp-1); }
.view-aids-cube-turns { display: grid; grid-template-columns: repeat(3, 20px); justify-content: center; gap: 2px; pointer-events: auto; }
.view-aids-cube-turns .btn.icon { width: 20px; height: 20px; min-width: 0; min-height: 0; padding: 0; border: 1px solid var(--line); background: var(--ink-2); color: var(--text-dim); pointer-events: auto; }
.view-aids-cube-turns .btn.icon:hover { background: var(--ink-3); color: var(--text); border-color: var(--line-hover); }
.view-aids-cube-turns .btn.icon svg { width: 14px; height: 14px; }
.view-aids-cube-turns .btn.icon:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; }
.view-aids-cube-buttons .btn.icon, .view-aids-strip > .btn.icon {
  pointer-events: auto; width: 24px; height: 24px; min-width: 24px; padding: 0;
  background: var(--ink-1); border: 1px solid var(--line); color: var(--muted);
}
.view-aids-cube-buttons .btn.icon:hover, .view-aids-strip > .btn.icon:hover { background: var(--ink-3); color: var(--text); border-color: var(--line-hover); }
.view-aids-cube-buttons .btn.icon svg, .view-aids-strip > .btn.icon svg { width: 16px; height: 16px; }
.view-aids-strip {
  position: absolute; display: flex; align-items: flex-end; gap: var(--sp-2); pointer-events: none;
}
.view-aids-strip > .btn.icon { align-self: flex-end; }
.view-aids-strip-list { display: flex; gap: var(--sp-2); overflow-x: auto; scrollbar-width: none; min-width: 0; pointer-events: auto; }
.view-aids-strip-list::-webkit-scrollbar { display: none; }
.view-aids-thumb {
  position: relative; flex: none; width: 64px; height: 40px; padding: 0; margin: 0; cursor: pointer;
  background: var(--ink-0); border: 1px solid var(--line-strong); border-radius: 0; overflow: hidden;
}
.view-aids-thumb img { display: block; width: 100%; height: 100%; object-fit: cover; }
.view-aids-thumb.no-image { width: auto; min-width: 64px; max-width: 128px; height: 24px; align-self: flex-end; }
.view-aids-thumb.no-image .view-aids-thumb-name { position: static; line-height: 22px; background: none; }
.view-aids-thumb-name {
  position: absolute; left: 0; right: 0; bottom: 0; padding: 0 var(--sp-2);
  font: var(--fs-caption)/14px var(--ui); color: var(--text); background: var(--view-ink-label);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-align: left;
}
.view-aids-thumb:hover { border-color: var(--line-hover); }
.view-aids-thumb.current { border-color: var(--accent); }
/* The switches, where Neuroglancer shows none (its 3-D-only layout): as its group beside Sections looks. */
.view-aids-switches {
  position: absolute; display: flex; pointer-events: auto;
  background: var(--ink-1); border: 1px solid var(--line); font: var(--fs-caption)/1 var(--ui); color: var(--text);
}
.view-aids-switch { display: inline-flex; flex-direction: row-reverse; align-items: center; gap: var(--sp-3); height: 22px; padding: 0 var(--sp-4); cursor: pointer; }
.view-aids-switch + .view-aids-switch { border-left: 1px solid var(--line); }
.view-aids-switch:hover { background: var(--hover); }
.view-aids-switch input { margin: 0; cursor: pointer; }
.view-aids-thumb:focus-visible, .view-aids-cube .btn.icon:focus-visible, .view-aids-strip > .btn.icon:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; }
`;
