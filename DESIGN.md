---
name: ngplatform
description: A platform around Neuroglancer for large scientific images, tractograms and meshes; the viewer shows data, the platform stays out of its way.
colors:
  ink-0: "#000"
  ink-1: "#0c0c0c"
  ink-2: "#141414"
  ink-3: "#1f1f1f"
  ink-card: "#1a1a1a"
  ink-4: "#292929"
  surface-overlay: "#1c1c1c"
  line: "#242424"
  line-strong: "#333"
  line-control: "#3a3a3a"
  line-hover: "#666"
  line-focus: "#8a8a8a"
  text: "#e6e6e6"
  text-strong: "#fff"
  muted: "#a3a3a3"
  accent: "#d0d0d0"
  accent-hover: "#f0f0f0"
  accent-ink: "#000"
  on: "#3f9f48"
  off: "#5c5c5c"
  knob: "#e6e6e6"
  ok: "#5fb37a"
  warn: "#d9a94a"
  err: "#e5736c"
  danger: "#8e3a36"
  danger-hover: "#a64540"
  dec-x: "#e0574b"
  dec-y: "#5cb46c"
  dec-z: "#4f88dc"
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
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-ink}"
    rounded: "{rounded.none}"
    height: "24px"
  button-primary-hover:
    backgroundColor: "{colors.accent-hover}"
  button-secondary:
    backgroundColor: "{colors.ink-3}"
    textColor: "{colors.text}"
    rounded: "{rounded.none}"
    height: "24px"
  button-danger:
    backgroundColor: "{colors.danger}"
    textColor: "{colors.text-strong}"
    rounded: "{rounded.none}"
  field:
    backgroundColor: "{colors.ink-0}"
    textColor: "{colors.text}"
    rounded: "{rounded.none}"
    height: "24px"
  switch-on:
    backgroundColor: "{colors.on}"
    rounded: "{rounded.switch}"
  switch-off:
    backgroundColor: "{colors.off}"
    rounded: "{rounded.switch}"
  card-head:
    backgroundColor: "{colors.ink-3}"
    textColor: "{colors.text}"
    rounded: "{rounded.none}"
  card-body:
    backgroundColor: "{colors.ink-card}"
    rounded: "{rounded.none}"
---

# Design System: ngplatform

## Overview

**Creative North Star: "The Instrument Panel"**

ngplatform is built on Neuroglancer and keeps its look: black and greys,
dense, quiet, square. The data is the only colourful thing on screen (a
tractogram's direction colours, a cell atlas's classes, a colour map), so
the interface around it is greyscale and steps back. People spend hours in
it reading data, not the chrome: the panels are a scientific instrument's,
precise and compact, not a product page's.

The interface is dark only. Density is a feature: docks hold cards of small
controls at one control height (24 px), on a 4 px grid. Hierarchy comes from
grey steps (ink-0 to ink-4), weight and position, not colour.

Rejected: colourful accents (a blue or a green accent was tried and judged
garish), gradients, rounded cards, decorative motion, "AI" styling.

**Key Characteristics:**
- Black and five grey surface steps; one light-grey accent for selection, focus and the primary action.
- Green appears on exactly one control: an on/off switch that is on.
- Square corners everywhere except the round on/off switches.
- Source Sans 3 for the interface, Source Code Pro for values, paths and code, every font set at one x-height (0.52).
- Five type sizes, from 11 px captions to 16 px sheet titles.

## Colors

Greyscale with a light-grey accent; colour belongs to the data and to state.

### Primary
- **Light Grey Accent** (#d0d0d0): the primary button, ticked boxes, slider fills, the chosen tab's underline, progress and the focus ring. Hover lifts it to #f0f0f0; text on it is black.

### Neutral
- **Engine Black** (#000, ink-0): behind the viewer, and the wells of fields and the log.
- **Bar Black** (#0c0c0c, ink-1): bars.
- **Dock Grey** (#141414, ink-2): docks.
- **Card Grey** (#1a1a1a, ink-card): a card's body, a step above the dock.
- **Raised Grey** (#1f1f1f, ink-3): a card's head, a secondary button.
- **Pressed Grey** (#292929, ink-4): pressed controls.
- **Overlay Grey** (#1c1c1c): menus, tips, toasts and sheets, with the strong line.
- **Lines** (#242424, #333, #3a3a3a for a field's edge, #666 under the pointer, #8a8a8a with focus).
- **Text** (#e6e6e6), **Strong text** (#fff), **Muted** (#a3a3a3): each at least 4.5:1 on the docks and on raised parts.

### State
- **Switch On Green** (#3f9f48) and **Switch Off Grey** (#5c5c5c): only on/off switches.
- **OK** (#5fb37a), **Warning** (#d9a94a), **Error** (#e5736c), **Danger** (#8e3a36 fill for deleting actions).
- **Direction colours** (x #e0574b, y #5cb46c, z #4f88dc): as tractography draws x, y and z; the logo and axis labels only.

### Named Rules
**The Data Owns Colour Rule.** The interface is greyscale; colour on screen means data, or a state (on, error, warning). No decorative hue.

**The One Green Rule.** Green is an on/off switch that is on. Nothing else is green.

## Typography

**Interface Font:** Source Sans 3 (with system-ui)
**Mono Font:** Source Code Pro (with ui-monospace)

**Character:** a neutral humanist sans at small sizes, with a mono for numbers, URLs and code; both held to one x-height so a fallback font keeps the layout.

### Hierarchy
- **Title** (600, 16px): sheet titles.
- **Heading** (600, 13px): a panel's sections and cards.
- **Control** (13px): control text in sheets and the top bar.
- **Body** (12px): body text and controls in the docks.
- **Caption** (11px): captions, labels, hints and tags (tags a little apart, 0.04em).

### Named Rules
**The Five Sizes Rule.** Five type sizes, no more; a new size is a new token, argued for.

## Layout

Docks either side of the viewer hold panels of cards; the viewer fills the
rest. Spacing is on a 4 px grid (2 and 6 px only inside dense controls), 24 px
between sections. Controls are one height in docks and panels (24 px) and a
larger one in sheets (28 px); a container sets the height, a button never
does. A pointer target is never less than 24 px (WCAG 2.5.8), whatever is
drawn. Every panel works at phone width with no sideways scroll.

## Elevation & Depth

Flat, by tonal layering: a surface is raised by a lighter grey (ink-0 to
ink-4), not a shadow. Shadows only lift what floats over the page.

### Shadow Vocabulary
- **Sheet** (`0 20px 48px rgba(0,0,0,.5), 0 0 0 1px rgba(0,0,0,.4)`): dialogs over the dimmed page.
- **Menu** (`0 10px 28px rgba(0,0,0,.45)`): menus and pickers.
- **Float** (`0 6px 18px rgba(0,0,0,.35)`): toasts and tips.
- **Dock** (`0 0 40px rgba(0,0,0,.6)`): a dock over the viewer.

## Shapes

Square: every radius is 0 (`--r`), cards, buttons, fields and sheets
alike. The one round shape is the on/off switch, a pill with a round knob.

## Components

- **Buttons**: primary is the light-grey accent with black text; secondary is raised grey; danger is red words, a red fill under the pointer. One height per container.
- **Fields and selects**: a black well, a #3a3a3a edge, lighter under the pointer and with focus.
- **On/off**: a round switch, grey off and green on; a tick box where a list of options each turn on.
- **Cards**: one block raised off the dock, within a #333 edge: a raised-grey head (ink-3) with the heading over a card-grey body (ink-card); a closed card is its head.
- **Selection**: a light-grey bar down the left and a faint tint.
- **Tabs**: the chosen tab underlined in #e6e6e6.

## Do's and Don'ts

- **Do** keep the interface greyscale and let the data carry colour.
- **Do** use the tokens in `src/ui/styles.css`; `npm run ui:audit` counts font sizes, button styles, radii and inline styles against `plans/ui-audit-baseline.json`.
- **Don't** add an accent colour, a gradient, a rounded card or a light theme.
- **Don't** use green for anything but a switch that is on.
- **Don't** animate for decoration: motion only shows a change of state, briefly.
- **Don't** add a type size, a radius or a control height outside the scales.
