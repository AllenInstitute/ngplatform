---
name: ngplatform
description: A platform around Neuroglancer for large scientific images, tractograms and meshes; the viewer shows data, the platform stays out of its way.
colors:
  ink-0: "#000"
  ink-1: "#000"
  ink-2: "#000"
  ink-3: "#000"
  ink-card: "#000"
  ink-4: "rgba(255, 255, 255, 0.10)"
  surface-overlay: "#141414"
  line: "rgba(255, 255, 255, 0.10)"
  line-strong: "rgba(255, 255, 255, 0.20)"
  line-control: "rgba(255, 255, 255, 0.20)"
  line-hover: "rgba(255, 255, 255, 0.36)"
  line-focus: "rgba(255, 255, 255, 0.92)"
  text: "rgba(255, 255, 255, 0.92)"
  text-strong: "#fff"
  muted: "rgba(255, 255, 255, 0.64)"
  faint: "rgba(255, 255, 255, 0.46)"
  hover: "rgba(255, 255, 255, 0.06)"
  select-soft: "rgba(255, 255, 255, 0.08)"
  selection: "rgba(255, 255, 255, 0.30)"
  accent: "#ebebeb"
  accent-hover: "#fff"
  accent-ink: "#000"
  focus: "#fff"
  on: "#ebebeb"
  off: "rgba(255, 255, 255, 0.20)"
  knob: "rgba(255, 255, 255, 0.92)"
  err: "#db4437"
  err-line: "rgba(219, 68, 55, 0.6)"
  danger: "rgba(219, 68, 55, 0.18)"
  dec-x: "#e0574b"
  dec-y: "#5cb46c"
  dec-z: "#4f88dc"
  view-margin: "#0c0c0c"
  view-outline: "#666"
  view-x: "#ce6e65"
  view-y: "#71af7c"
  view-z: "#6890cb"
  view-frame: "#333"
  view-ink-line: "#a3a3a3"
  view-ink-accent: "#d0d0d0"
  view-ink-keyline: "#000"
  view-ink-text: "#e6e6e6"
colors-light:
  ink-0: "#fff"
  ink-1: "#fff"
  ink-2: "#fff"
  ink-3: "#fff"
  ink-card: "#fff"
  ink-4: "rgba(0, 0, 0, 0.10)"
  surface-overlay: "#f4f4f4"
  line: "rgba(0, 0, 0, 0.10)"
  line-strong: "rgba(0, 0, 0, 0.20)"
  line-control: "rgba(0, 0, 0, 0.20)"
  line-hover: "rgba(0, 0, 0, 0.36)"
  line-focus: "rgba(0, 0, 0, 0.88)"
  text: "rgba(0, 0, 0, 0.88)"
  text-strong: "#000"
  muted: "rgba(0, 0, 0, 0.62)"
  faint: "rgba(0, 0, 0, 0.56)"
  hover: "rgba(0, 0, 0, 0.06)"
  select-soft: "rgba(0, 0, 0, 0.08)"
  selection: "rgba(0, 0, 0, 0.22)"
  accent: "#141414"
  accent-hover: "#000"
  accent-ink: "#fff"
  focus: "#000"
  on: "#141414"
  off: "rgba(0, 0, 0, 0.20)"
  knob: "rgba(0, 0, 0, 0.88)"
  err: "#c53929"
  err-line: "rgba(197, 57, 41, 0.6)"
  danger: "rgba(197, 57, 41, 0.12)"
  dec-x: "#c0463a"
  dec-y: "#3a8a4a"
  dec-z: "#3d72c4"
  view-margin: "#f3f3f3"
  view-3d: "#fff"
  view-outline: "#808080"
  view-x: "#b03a2e"
  view-y: "#2b7039"
  view-z: "#2c5fae"
  view-frame: "#c8c8c8"
  view-ink-line: "#5c5c5c"
  view-ink-accent: "#262626"
  view-ink-keyline: "#fff"
  view-ink-text: "#1a1a1a"
typography:
  title:
    fontFamily: "Source Sans 3, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 600
  heading:
    fontFamily: "Source Sans 3, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 600
  control:
    fontFamily: "Source Sans 3, system-ui, sans-serif"
    fontSize: "13px"
  body:
    fontFamily: "Source Sans 3, system-ui, sans-serif"
    fontSize: "12px"
  caption:
    fontFamily: "Source Sans 3, system-ui, sans-serif"
    fontSize: "11px"
  mono:
    fontFamily: "Source Code Pro, ui-monospace, monospace"
    fontSize: "12px"
  readout:
    fontFamily: "Source Code Pro, ui-monospace, monospace"
    fontSize: "12px"
    fontFeature: "tnum"
rounded:
  none: "0"
  switch: "999px"
spacing:
  sp-1: "2px"
  sp-2: "4px"
  sp-3: "6px"
  sp-4: "8px"
  sp-5: "12px"
  sp-6: "16px"
  sp-7: "24px"
  icon: "16px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-ink}"
    rounded: "{rounded.none}"
    height: "24px"
  button-primary-hover:
    backgroundColor: "{colors.accent-hover}"
  button-secondary:
    backgroundColor: "{colors.ink-0}"
    textColor: "{colors.text}"
    rounded: "{rounded.none}"
    height: "24px"
  button-danger:
    backgroundColor: "{colors.ink-0}"
    textColor: "{colors.err}"
    rounded: "{rounded.none}"
  field:
    backgroundColor: "{colors.ink-0}"
    textColor: "{colors.text}"
    rounded: "{rounded.none}"
    height: "24px"
  tab-chosen:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-ink}"
    rounded: "{rounded.none}"
  switch-on:
    backgroundColor: "{colors.on}"
    rounded: "{rounded.switch}"
  switch-off:
    backgroundColor: "{colors.off}"
    rounded: "{rounded.switch}"
  card:
    backgroundColor: "{colors.ink-card}"
    textColor: "{colors.text}"
    rounded: "{rounded.none}"
  float-surface:
    backgroundColor: "{colors.surface-overlay}"
    rounded: "{rounded.none}"
  selected-row:
    backgroundColor: "{colors.select-soft}"
    textColor: "{colors.text-strong}"
  layer-chip:
    textColor: "{colors.text}"
    rounded: "{rounded.none}"
  readout:
    textColor: "{colors.text}"
  readout-unit:
    textColor: "{colors.muted}"
  view-stage:
    backgroundColor: "{colors.view-margin}"
---

# Design System: ngplatform

## Overview

**Creative North Star: "The Instrument Panel"**

ngplatform is built on Neuroglancer and keeps its materials: black panels,
1 px lines, white type, square corners, numbers in a monospaced face. The
data is the only colourful thing on screen (a tractogram's direction
colours, a cell atlas's classes, a colour map); the interface around it is
greyscale and steps back. People spend hours in it reading data, not the
chrome: the panels are a scientific instrument's, precise and compact, and
someone who knows Neuroglancer recognises its parts (the numbered layer
chips, the Source, Rendering and Annotations tabs, Min–Max, 1–99 % and
5–95 %, its tick boxes and sliders), restyled, not reinvented.

There are two themes, dark (the default, as Neuroglancer is) and light,
chosen in Settings › View (or as the system is) and kept in the browser,
never in a link. The light theme is the same system mirrored, not another
look: white panels, black at the opacities white has in the dark. The views
take the theme's ground: black in the dark, white in the light (shown in
this browser, never saved in the scene or its link); Black views in the
light theme keeps them black there, as Neuroglancer and radiology viewers
show images. Density is a feature: docks hold sections of
small controls at one control height (24 px), on a 4 px grid. Hierarchy
comes from white at a few opacities, weight, position and 1 px lines, not
from grey fills or colour.

Rejected: colourful accents (a blue, then a green accent, then a light-grey
accent on grey fills), an eight-colour palette for the interface's own use,
gradients, rounded cards, invented control shapes, decorative motion, "AI"
styling.

**Key Characteristics:**
- Black panels separated by 1 px lines; menus, sheets and floating cards a step up (#141414). In the light theme the mirror: white panels, what floats a step down (#f4f4f4).
- White at fixed opacities: text 92, 64 and 46 %; lines 10, 20 and 36 %; hover 6 %.
- One hue in the chrome: Neuroglancer's error red, for errors and what deletes.
- What is chosen or on is inverted (a white fill, black words) or outlined in 1 px white; nothing is green.
- The views are a near-black stage, Neuroglancer's own chrome included; red, green and blue only where they name the axes.
- Source Sans 3 for words, Source Code Pro for every number, address and code, both at one x-height (0.52).
- Square corners everywhere except the round on/off switches.

## Colors

Black and white at a few opacities; one red; colour belongs to the data.

### Neutral
- **Black** (#000, ink-0 … ink-card): the views' surroundings, docks, cards, bars, field wells. A part is told from its neighbour by a 1 px line, not a fill.
- **Overlay** (#141414): what floats: menus, the command palette, sheets, toasts, tips, a view's floating card.
- **Lines** (white 10 % between parts, 20 % a control's or a section's edge, 36 % under the pointer, 92 % a field with the focus).
- **Text** (white 92 %), **Strong** (#fff), **Muted** (64 %), **Faint** (46 %, 4.6:1 on black): labels are muted, hints and disabled words faint.
- **Hover** (white 6 %), **Pressed** (10 %), **Selected row** (8 %, with the strong text), **Selected text** (30 %).

### Chosen and on
- **Inverted** (#ebebeb fill, black words): the chosen tab, the pressed segment or toggle, the primary button, a switch that is on (its knob black). Tick boxes and sliders are the browser's own, in this white.
- **Outlined** (1 px white): the scene shown, the focused view's frame, a field with the focus.
- **Focus**: a 1 px white outline, 2 px out.

### Error
- **Error red** (#db4437, Neuroglancer's): error words and marks, an error toast's edge, a deleting action's words and its tint under the pointer. Nothing else is red; warnings and success are white, told by their words and marks.

### Axes
- **Direction colours** (x #e0574b, y #5cb46c, z #4f88dc): as tractography draws x, y and z; the logo, axis arrows and the orientation cube's edges in the views.

### View chrome
Neuroglancer's own parts over and in the views, in this system.
- **Stage** (#0c0c0c, view-margin): the margin around the sections, where there is no data. A new scene, an example and the blank viewer start with it (`src/core/view_defaults.ts`); a link keeps its own.
- **Outline** (#666, view-outline): an image's or segmentation's bounding box, set on the layers the platform adds and the examples'; 3.4:1 on the stage.
- **Frames**: each panel 1 px line-strong, the focused one white.
- **Axis labels** (x #ce6e65, y #71af7c, z #6890cb, view-x/y/z): the direction colours a step quieter, at least 5:1 on the stage, in the caption size and the mono face.
- **Coordinates**: the position bar and the pointer's position in the mono face, names and units muted.
- **Scale bar**: Source Code Pro, 12 px, a 3 px bar.
- **Resolution histograms**: Neuroglancer's red and orange bars shown in greys (a CSS filter).
- Not changeable without changing Neuroglancer (WebGL with fixed colours): the axis lines (red, green, blue at half strength), and the scale bar's white, bold type on its 30 % black box. On the light ground these read poorly and do not follow it: the scale bar's white words on its box (then #aaa on the sections' grey, #b2b2b2 on white), 2.3 and 2.1:1; the axis lines, pure red, green and blue at half strength, 2.4, 1.3 and 3.3:1 on white (green all but gone). The bounding boxes (#666, the platform's default) are 5.7:1 on white.

### Light theme
The dark set mirrored (`colors-light`, `:root[data-theme="light"]` in `src/ui/styles.css`): what is white at an opacity in the dark is black at about the same one in the light.
- **White** (#fff, ink-0 … ink-card) for panels, wells and bars; **Overlay** (#f4f4f4) for what floats, with its 1 px line-strong edge and a lighter shadow.
- **Text** black 88 %, **Muted** 62 %, **Faint** 56 % (not 46 %: black at 46 % is 3.4:1 on white). Every level at least 4.8:1 on white and on the overlay grey: text 16.5 and 15.3, muted 6.2 and 6.0, faint 4.95 and 4.85.
- **Lines** black 10, 20 and 36 %, the focus's field 88 %; **Hover** 6 %, **Pressed** 10 %, **Selected row** 8 %, **Selected text** 22 %.
- **Inverted** is a black fill (#141414) with white words; **Outlined** a 1 px black line; **Focus** a 1 px black outline, 2 px out.
- **Error red** a step darker, #c53929: 5.3:1 on white, 4.8:1 on the overlay grey (#db4437 there would be 4.3 and 3.9). In the dark #db4437 is 4.9:1 on black and 4.3:1 on the overlay grey.
- Scrollbars, the caret, placeholders, ranges and tick boxes follow (the browser draws them in the light scheme, in the accent).

### Views and their ground
The views have a ground of their own. In the dark theme it is the scene's (a new scene's margin #0c0c0c, the 3-D view black). In the light theme the views are shown on the light ground (the margin the lightest grey, #f3f3f3, the 3-D view white), unless Settings › View › Black views in the light theme is on: shown in this browser only, never written into the workspace or its link, and switching to the dark theme (or keeping the views black) puts back exactly the backgrounds the scene carries. A background set in Settings › View meanwhile is the person's: shown and saved. Captures show what is on screen, the white included. A plugin's background for a while (Luxar's black behind splats) is shown over the light ground. Each of Neuroglancer's view panels and each overlay over them carries its ground (`data-view-ground`, `data-view-ground-3d` with `.over-3d` for what is over the 3-D view), and the tokens there are the set for that ground, whatever the theme: the frames, axis labels, the 3-D view's switches, the layout buttons, the floating card, the view aids' cube, labels and bookmarks. What is drawn on canvases over the views takes its colours from the same tokens (`viewInk()` in `@ngplatform/sdk/dom`: `--view-ink-*` and the direction colours): on a dark ground light grey lines with a black keyline, on a light one dark grey lines with a white keyline; the direction colours a step darker on a light ground (at least 3.8:1 as lines) and the axis labels at least 5.4:1.

### Named Rules
**The Ground Rule.** The chrome follows the theme; the views, and what is drawn over them, follow the view's ground.

**The Greyscale Rule.** The chrome is black and white at the opacities above. A hue in it is either the error red or an axis colour naming an axis in the views; nothing else.

**The Inversion Rule.** Chosen or on is shown by inversion or a 1 px white outline (black in the light theme). No green, no coloured bar down the side of a row, no coloured edge wider than 1 px.

## Typography

**Interface Font:** Source Sans 3 (with system-ui)
**Mono Font:** Source Code Pro (with ui-monospace)

**Character:** a neutral humanist sans at small sizes, and Neuroglancer's habit of a monospaced face for every number; both held to one x-height so a fallback font keeps the layout.

### Hierarchy
- **Title** (600, 16px): sheet titles.
- **Heading** (600, 13px): a panel's sections and cards, one style.
- **Control** (13px): control text in sheets and the top bar.
- **Body** (12px): body text and controls in the docks; labels muted.
- **Caption** (11px): captions, hints and tags (tags a little apart, 0.04em).
- **Readout** (Source Code Pro, 12px, tabular digits): every number, shown or typed: the coordinates over the views, the status line's items, sizes and counts, number fields, layer chips. A shown value's unit follows a thin space in the muted white (`readout()` in `@ngplatform/sdk/dom`, `.readout-value`, `.readout-unit`). A layer's data source is a readout: the store's name, beneath it where it is (quiet) and the path, cut short at its start, with copy and edit; the whole address in the box while editing.

### Named Rules
**The Five Sizes Rule.** Five type sizes, no more; a new size is a new token, argued for.

## Layout

One left column (layers, the selected layer's settings, the tools) beside
the views. Spacing is on a 4 px grid (2 and 6 px only inside dense
controls), 24 px between sections, more room between groups than within
them. Controls are one height in docks and panels (24 px) and a larger one
in sheets (28 px); a container sets the height, a button never does. A
pointer target is never less than 24 px (WCAG 2.5.8), whatever is drawn.
Every panel works at phone width with no sideways scroll.

## Elevation & Depth

Flat: parts sit side by side on black, divided by 1 px lines. Only what
floats is lighter (#141414) and has a shadow.

### Shadow Vocabulary
- **Sheet** (`0 20px 48px rgba(0,0,0,.5), 0 0 0 1px rgba(0,0,0,.4)`): dialogs over the dimmed page.
- **Float** (`0 8px 24px rgba(0,0,0,.45)`): everything that floats without dimming the page (`--shadow-menu` is the same shadow).
- **Dock** (`0 0 40px rgba(0,0,0,.6)`): the left column over the views on a phone.

### The Floating Surface
One style for what floats over the views or the page: menus, the command palette, toasts, tips, completions, Neuroglancer's dropdowns and a view's floating card (class `float-surface`): #141414, a 1 px line-strong edge, square, the Float shadow.

## Motion
Motion only shows a change of state, briefly, easing out: `--t-fast` (120 ms) for a control's own change (a switch, a chevron), `--t` (200 ms) for a part that grows or moves (a progress bar), `--ease-out` (`cubic-bezier(0.2, 0, 0, 1)`). With reduced motion every duration is 0: changes happen at once.

## Shapes

Square: every radius is 0 (`--r`), cards, buttons, fields, chips and
sheets alike. The one round shape is the on/off switch.

## Components

- **Buttons**: lines on black (a 20 % edge, 36 % and a hover tint under the pointer); primary inverted; danger red words, a red tint under the pointer; disabled at the faint white. One height per container.
- **Tabs**: the chosen one inverted, as Neuroglancer's; the left column's Layers and Plugins only in the strong text.
- **Fields and selects**: a black well, a 20 % edge, 36 % under the pointer, 92 % with the focus; numbers in the mono face, no spinners.
- **On/off**: a round switch, a quiet track off, white on; a tick box (the browser's own, white) where a list of options each turn on.
- **Cards**: a 1 px line around a head and its body, both black; a closed card is its head.
- **Layer chips**: a layer's number (Neuroglancer's, in draw order) in a small square, mono: white while shown, faint while hidden.
- **Selection**: the white 8 % tint and the strong text; no bar down the left.
- **Icons**: one set of line drawings (`src/sdk/icons.ts`), 16 px with a 1 px line; inside a line of text, at the text's size. Never a character (×, ⋯, ▸, ✓) in an icon's place; an icon-only button has a name.
- **Browser surfaces**: selected text on white 30 % (black 22 % in the light); a caret in the strong text; thin scrollbars with a 36 % thumb; placeholders a quieter text; ranges and tick boxes the browser's own in the accent.
- **Shader editor** (CodeMirror): greyscale in both themes, the syntax told by weight and opacity, not hue: keywords and types in the strong text at 600, names and numbers in the text, punctuation muted, comments faint, an error red; selected text and the matching bracket in the selection tints.

## Do's and Don'ts

- **Do** keep the chrome black and white and let the data carry colour.
- **Do** keep Neuroglancer's conventions recognisable: restyle its parts, don't reinvent their shapes.
- **Do** use the tokens in `src/ui/styles.css`; `npm run ui:audit` counts font sizes, button styles, radii and inline styles against `plans/ui-audit-baseline.json`.
- **Don't** add a hue to the chrome, a grey fill to tell parts apart, a gradient or a rounded card; the light theme is the dark one mirrored, not a look of its own.
- **Don't** colour what is drawn over the views with fixed values: read the view's ink (`viewInk()`, the `--view-ink-*` tokens), so it reads on either ground.
- **Don't** use green, or any colour, for on or selected: invert or outline in white.
- **Don't** put a character where an icon belongs, or a coloured bar down the side of a selected row.
- **Don't** animate for decoration: motion only shows a change of state, briefly.
- **Don't** add a type size, a radius or a control height outside the scales.
