# Phase 4: Accessibility

About a week.

Each batch ends with the checks in [README.md](README.md#checks-for-every-batch). Tick an item when it is merged, with the commit: `- [x] … (abc1234)`.

## 4 · Accessibility

**Goal:** Keyboard, screen-reader and reduced-motion use work everywhere; an automated check joins `ui:audit`.

**Files:** src/ui/overlays.ts, src/ui/docks.ts, src/ui/shell.ts, plugins/collections, plugins/atlas

**Items:** 9

- [ ] **Major** · M · Core app: Sheets are not real modals: no aria-modal, no focus trap, no focus return  
  `src/ui/overlays.ts:10–54`
- [ ] **Major** · M · Core app: Menus, dock tabs, the Settings nav and the Tools picker have roles but no arrow-key behaviour  
  `overlays.ts:288; docks.ts:56, 99`
- [ ] **Minor** · S · Core app: Reduced motion honoured only by the busy dot (not the progress bar, transitions, 3-D momentum)  
  `styles.css:242, 554; engine.ts:248`
- [ ] **Minor** · S · Core app: Dock resizers: not focusable, no arrow keys, stuck on pointercancel; the view split writes storage on every move  
  `docks.ts:340; shell.ts:1308`
- [ ] **Minor** · S · Core app: Command palette lacks combobox semantics  
  `overlays.ts:62`
- [ ] **Minor** · S · Core app: Share has no accessible name on narrow screens  
  `shell.ts:146`
- [ ] **Minor** · S · Core app: Error toasts should be role=alert and stay while hovered  
  `overlays.ts:349`
- [ ] **Minor** · M · OME Collections: The graph does not scale past about 15 members and is not keyboard-usable  
  `plugin.ts:725, 737`
- [ ] **Minor** · S–M · Atlas: The tree redraws in full and lacks keyboard navigation; Show all hides 3-D meshes  
  `plugin.ts:239, 377`
