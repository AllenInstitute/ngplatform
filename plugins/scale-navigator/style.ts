/**
 * The navigator's styles, in the status line (DESIGN.md): names in the
 * interface's face, sizes as readouts; the layer the views are on in the
 * strong white, a hidden one faint; a crumb under the pointer tinted.
 */
export const STYLE = `
.scale-nav-crumbs { display: flex; align-items: center; min-width: 0; overflow: hidden; white-space: nowrap; }
.scale-nav-list { display: flex; align-items: center; min-width: 0; }
.scale-nav-list > [hidden], .scale-nav-more[hidden] { display: none; }
.scale-nav-more::before { content: "\\2026"; }
.scale-nav-more { color: var(--faint); font-family: var(--ui); padding-right: var(--sp-2); }
.scale-nav-sep { color: var(--faint); font-family: var(--ui); white-space: pre; }
.status-item .scale-nav-crumb {
  display: inline-block; height: var(--ctl-h); line-height: var(--ctl-h); padding: 0 var(--sp-2); margin: 0;
  border: 0; background: transparent; color: var(--muted); font: inherit; white-space: nowrap; cursor: pointer;
}
.status-item .scale-nav-crumb .status-label { color: inherit; }
.status-item .scale-nav-crumb .readout-value { color: inherit; }
.status-item .scale-nav-crumb.current { color: var(--text-strong); }
.status-item .scale-nav-crumb.hidden-layer { color: var(--faint); }
.status-item .scale-nav-crumb:hover { background: var(--hover); color: var(--text-strong); }
.status-item .scale-nav-crumb:focus-visible { outline: 1px solid var(--focus); outline-offset: -2px; }
.status-item .scale-nav-level { display: block; white-space: nowrap; }
.scale-nav-approx { color: var(--muted); }
.scale-nav-dot { color: var(--faint); white-space: pre; }
`;
