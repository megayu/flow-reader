# Flow Reader UI Specification

This specification defines Flow Reader's established desktop UI. It is a product
contract, not a record of whichever implementation happens to exist locally.

## Contents

- [Product direction](#product-direction)
- [Implementation map](#implementation-map)
- [Desktop interaction model](#desktop-interaction-model)
- [Typography](#typography)
- [Geometry and spacing](#geometry-and-spacing)
- [Component contracts](#component-contracts)
- [Themes and visual states](#themes-and-visual-states)
- [Motion and runtime cost](#motion-and-runtime-cost)
- [Reader invariants](#reader-invariants)
- [Verification](#verification)

## Product Direction

Flow Reader is a compact desktop reading application.

- Optimize for reading correctness, immediate response, and low long-session memory
  use before decoration.
- Keep dense navigation efficient, visually quiet, consistent, and polished.
- Express hierarchy with surface, contrast, spacing, typography, and restrained
  state feedback.
- Keep application chrome subordinate to book content. Book-like styling belongs
  only to explicit reader page-appearance modes.
- Keep every workflow complete by mouse. Use shortcuts only to accelerate frequent
  actions, not to reproduce the entire interface as a keyboard UI.
- Do not introduce mobile navigation, touch gesture layers, mobile hit-target
  sizing, responsive page rearrangement, browser history/navigation conventions,
  or generic website patterns. Desktop window resizing is a layout constraint, not
  a request to turn the app into a mobile layout.

## Implementation Map

Inspect these owners and their actual consumers before introducing another pattern:

| Concern                              | Principal implementation                                      |
| ------------------------------------ | ------------------------------------------------------------- |
| Theme surfaces and semantic colors   | `src/styles/theme.ts`, `src/pages/styles.css`                 |
| App UI type scale                    | `src/styles/ui.ts`, `src/pages/styles.css`                    |
| Buttons                              | `src/components/ui/button.tsx`, `src/components/Button.tsx`   |
| Inputs and selects                   | `src/components/ui/input.tsx`, `src/components/ui/select.tsx` |
| Rows and tree indentation            | `src/components/Row.tsx`, `src/hooks/useList.ts`              |
| Reader tabs                          | `src/components/Tab.tsx`                                      |
| Pane headers and split panes         | `src/components/base/PaneView.tsx`, `base/SplitView.tsx`      |
| Dialog and floating surfaces         | `src/components/ui/dialog.tsx`, `popover.tsx`, `tooltip.tsx`  |
| Product shortcuts and blocking       | `src/shortcuts.ts`, `src/keyboard.ts`                         |
| Reader interface and page appearance | `src/components/Reader.tsx`, `src/pages/styles.css`           |
| Theme invariants                     | `tests/unit/theme-tokens.test.ts`                             |

## Desktop Interaction Model

### Mouse path

- Provide a complete mouse path for every feature: visible control, menu, context
  menu, wheel, drag, or direct manipulation as appropriate.
- Preserve the first pointer-down drag, continuous movement, release, collapse,
  expansion, outside click, and saved geometry of existing panes and overlays.
- Keep hover and pressed feedback immediate. Show necessary actions without moving
  labels, rows, tabs, or neighboring controls.
- Preserve content-driven height, useful maximum height, overflow, and visible
  scrollbar access for long lists and editors.

### Shortcuts

- Give shortcuts only to high-frequency, stable actions such as reading navigation,
  chapter/search navigation, common panel toggles, and other established repeated
  operations.
- Prefer one printable character when it is memorable and conflict-free in the
  active context. Use modifiers when a single character would collide with text
  entry, system behavior, or another active command.
- Block global shortcuts in inputs, textareas, selects, editable content, and
  blocking overlays through `src/keyboard.ts`.
- Keep a mouse entry point for every shortcut action and show the shortcut in the
  existing tooltip/settings surfaces when relevant.
- Do not add general Tab traversal, roving tab index, arrow/Home/End movement among
  controls, keyboard pane resizing, or keyboard-only tree/menu/tab operation.
- Preserve keys that are already the feature itself, including text editing,
  search-result Enter behavior, Escape cancellation, and reader page shortcuts.

Web accessibility coverage is outside the default product acceptance scope. Do not
add ARIA state owners, screen-reader-only copy, focus graphs, or keyboard navigation
machinery unless the user explicitly requests that work. Native or library-owned
attributes may remain when they add no Flow-specific state or code.

## Typography

### Application UI

- Derive the UI scale from the user-configurable base size:
  - `xs = max(11, base - 2)`
  - `sm = max(12, base - 1)`
  - `base = base`
  - `lg = base + 2`
  - `xl = base + 4`
- Default to 15 px and support the full 12–18 px settings range.
- Use `text-base` for ordinary controls and rows. Use another defined step only for
  real hierarchy or density.
- Use `leading-none` for fixed-height single-line controls when needed for optical
  centering; use tight or snug leading for multiline content.
- Use medium or semibold weight for labels and section headings. Keep secondary
  text quieter.
- Use monospace or tabular numerals only for shortcuts, hexadecimal values,
  counters, and stable numeric readouts.

### Reader content

- Treat EPUB/TXT typography as a separate user-controlled system.
- Never feed app font tokens into book typography or pagination.
- App UI changes must not alter iframe content, column width, pagination, or stored
  book typography.

## Geometry and Spacing

Use established size families before adding another height:

| Role                          | Visible size | Examples                                      |
| ----------------------------- | -----------: | --------------------------------------------- |
| Dense list row                |        24 px | TOC, search, annotation, virtualized tree row |
| Extra-small control           |        24 px | `Button` `xs`, `icon-xs`                      |
| Compact control / pane header |        28 px | `Button` `sm`, pane header                    |
| Standard control              |        32 px | button, input, select, segmented control      |
| Large control                 |        36 px | `Button` `lg`, `icon-lg`                      |
| Primary activity action       |   48 × 48 px | left activity bar                             |
| Standard glyph                |        16 px | control, tab, menu, row                       |
| Compact glyph                 |     12–14 px | extra-small and small controls                |
| Activity glyph                |        28 px | primary activity bar                          |

- Keep same-role peers the same height and cross-axis alignment.
- Do not change virtualized row height for appearance alone; it is also a scrolling
  and measurement input.
- Let a control fill a fixed-height parent when appropriate; avoid padding that
  makes its effective geometry ambiguous.
- Keep single-line text, icons, counters, steppers, and close buttons visually
  centered. Multiline content may align to the top intentionally.
- Center text and icons through the control's actual content box, line height, and
  flex/grid alignment. Do not translate or relatively offset control text to hide
  an incorrect inner or outer box.

Use the 2, 4, 6, 8, 10, 12, 16, and 20 px spacing rhythm:

| Space | Typical use                                |
| ----: | ------------------------------------------ |
|  2 px | tightly grouped micro-controls             |
|  4 px | compact icon/label or sibling gap          |
|  6 px | standard icon/label gap                    |
|  8 px | compact inset or small surface padding     |
| 10 px | standard control horizontal inset          |
| 12 px | sidebar or compact panel inset             |
| 16 px | dialog or standard content inset           |
| 20 px | roomy empty state or reading-related inset |

- Balance left and right inset for symmetrical controls. Keep intentional
  asymmetry for indentation, scrollbar gutters, leading icons, chevrons, or
  trailing actions consistent within the component family.
- Align repeated title, label, and field starts across a panel.
- Use `min-w-0` and `min-h-0` where content must shrink or scroll; reserve action
  space before using `ml-auto`.
- Prefer flex/grid relationships over arbitrary absolute positioning.

## Component Contracts

### Source choice

- Flow geometry and behavior apply regardless of whether implementation uses CSS,
  project code, a platform element, or an installed primitive.
- Prefer a targeted correction over replacement. Share a primitive only when
  repeated consumers truly have the same geometry, states, and behavior.
- A library default must not create a parallel visual family or change dismissal,
  scrolling, dragging, content sizing, or persistence.

### Buttons and icon controls

- Reuse existing Flow button variants and sizes when they match the workflow.
- Use one primary action per group. Use quieter variants for toolbar, inline, and
  secondary actions.
- Keep icon/label gaps, glyph size, disabled appearance, tooltip, and pressed
  feedback consistent among peers.
- Keep close, reset, and row-action glyphs inside stable boxes and vertically
  centered.

### Inputs, steppers, selects, and editors

- Use 32 px for standard single-line controls and 28 px only for an established
  compact context.
- Keep text, prefix/suffix controls, increment/decrement buttons, and chevrons
  vertically centered.
- Give long option collections the useful available desktop height and a visible
  scrollbar when content overflows. Do not force a font list into a short generic
  menu.
- Keep short selectors compact. Preserve the established selection and dismissal
  behavior of the specific selector rather than inheriting a primitive default.
- Let multiline editors retain the useful area required by their workflow; do not
  collapse them to a single-line field during a component replacement.

### Rows, menus, trees, and library selection

- Keep ordinary virtualized rows at `LIST_ITEM_SIZE` for rendering, measurement,
  overscan, and scrolling.
- Keep row content vertically centered, truncated safely, and aligned through a
  stable twisty/icon column and depth indentation.
- Reserve a trailing area for badges and row actions so hover does not shift text.
- Keep selection visually distinct from hover. Library selection uses the existing
  rectangular row/card silhouette; do not turn it into a pill.
- Collapsing a tree group must leave its header available to expand again.

### Tabs and breadcrumbs

- Preserve the Flow tab silhouette, selected surface, reverse-rounded cutouts,
  separators, close-button placement, dragging, drop feedback, and middle-click
  close.
- Keep selected and unselected outer geometry identical. Show state through
  overlays, color, opacity, or stable indicators rather than reflow.
- Keep labels truncated and close actions available without changing tab width.
- Pure tab switching must not trigger reader layout work when layout inputs are
  unchanged.
- Reader breadcrumbs are display-only context; do not add navigation behavior.

### Activity bar, sidebars, and split panes

- Keep activity actions at 48 × 48 px with 28 px icons and a stable active-edge
  indicator.
- Keep the library sidebar and reader sidebar at a 240 px default and 160 px
  minimum. Persist their widths independently as
  `flow-reader:sidebar:library:width` and `flow-reader:sidebar:reader:width`.
- Keep the library list pane at a 220 px default and 120 px minimum. Keep the
  definitions pane at a 120 px default and 72 px minimum. Let the reader TOC and
  annotations panes consume the remaining height with their existing 160 px
  minimum instead of inventing a second preferred height.
- Keep pane headers at 28 px and preserve established default, collapsed, and saved
  pane heights.
- Keep dividers visually thin while retaining their established pointer capture
  area. Dragging must start on the first press, remain continuous, and save the
  resulting size.
- Keep header text and actions vertically centered; hover actions occupy reserved
  space.
- Treat reader-sidebar width or resize-semantics changes as reader layout work.
  Use performance measurement only when runtime work amount, timing, frequency, or
  lifetime also changes.

### Dialogs, popovers, menus, tooltips, and notifications

- Preserve the actual trigger, stacking, placement, collision, dismissal, editing,
  apply/cancel, and return-to-workflow behavior of each surface.
- Use 16 px dialog inset with aligned header, body, and footer unless an established
  specialized surface requires different geometry.
- Use semantic surface tokens, a subtle boundary, and only the elevation needed to
  distinguish the overlay.
- Keep tooltip copy concise and show established shortcuts in a separate token.
- Keep notification icon, text, and close action vertically aligned; multiline
  message text may retain its natural line alignment.
- Let illustration groups expand to the height their visible content needs within
  the available pane, then scroll only when necessary.

### Empty, loading, and error states

- Add a state only when the workflow can enter it.
- Keep the normal surface geometry while swapping state content.
- Use direct product language. Avoid decorative placeholders, perpetual shimmer,
  marketing copy, and animation that continues while hidden.

## Themes and Visual States

- Use Flow semantic tokens from the theme system rather than raw palette colors or
  one-off hex values.
- Product categories whose color carries stable meaning, such as reading status
  and annotation colors, may use one centralized named palette. Do not convert
  those colors into the current theme accent or scatter duplicate literals among
  consumers.
- Respect the existing app/activity/sidebar/content/tab/panel/control surface
  hierarchy and use `--flow-text` / `--flow-text-muted` for text hierarchy.
- Add a theme token only when the value is genuinely shared; generate it for all
  supported themes and cover it in `tests/unit/theme-tokens.test.ts` when
  appropriate.
- Keep the base radius at 10 px and use derived smaller radii for compact nested
  controls. Reserve pills for badges, counters, progress, scrollbars, and established
  compact floating controls.
- Prefer borders or inset rings for structure. Use shadows for real overlay or
  reader-material elevation, not every row or card.
- Keep border width present across states; change color instead of geometry.

Every supported state must keep dimensions and sibling positions stable:

- Hover identifies the pointer target.
- Pressed state confirms the click immediately.
- Selected/current state has enough contrast to remain distinct from hover.
- Disabled state is visibly unavailable and non-interactive.
- Dragging and drop-target states show the active geometry without reflow.
- Loading and error feedback appear only while applicable.

Use more than a barely perceptible color shift when two adjacent states otherwise
look the same. Do not add effects that communicate no state.

## Motion and Runtime Cost

- Use motion only for response, hierarchy, or spatial continuity.
- Prefer short CSS transitions of color, background, border, opacity, or small
  transforms. Keep floating-surface motion around 100 ms unless the existing
  workflow specifies otherwise.
- Do not animate pane size, iframe geometry, width, height, top, or left for
  decoration.
- Do not add smooth scrolling, parallax, staggered list entrance, ambient motion,
  blur animation, or scroll-triggered reveal.
- Do not measure layout per frame or use React state for pointer/scroll animation.
- Clean up every listener, observer, timer, subscription, and RAF. Stop hidden UI
  work.
- Measure before and after when a change can affect first frame, page turns, tab
  switches, bundle size, memory, or long-session responsiveness.

## Reader Invariants

- Treat reader body, header, footer, page number, progress, and visible section
  indexes as one committed visual state.
- Do not let UI styling alter viewport, columns, spread mode, iframe geometry,
  pagination input, or active position.
- Align header/footer with the active page or spread.
- Keep inactive panes visually and interactively hidden without losing required
  geometry or leaking pixels.
- Keep unchanged-layout tab activation a visibility/state operation, not resize or
  repagination.
- Position annotations, definitions, selection menus, and reader toolbars against
  active iframe/page geometry and prevent edge clipping.
- Keep page appearance modes (`cards`, `book`, `divider`) decorative only.

## Verification

Choose evidence from the changed mechanism, not from the fact that a UI file was
edited:

- Source inspection is enough for an unambiguous literal presentation edit that
  changes no behavior or layout ownership.
- Refresh the affected surface for visual judgment. Use bounding rectangles only
  for numeric alignment, size, clipping, or boundary claims. Use screenshots only
  for pixel appearance, contrast, theme, or visual-reference comparison.
- Exercise the actual client workflow when pointer behavior, drag, dismissal,
  scrolling, persistence, window integration, or WebView behavior changes.
- Add an automated test when logic has a stable regression assertion: shared state,
  boundary calculation, persistence, component contracts used by several callers,
  or a previously recurring bug. Do not add a test that only repeats a CSS class,
  token, or fixed dimension.
- Run a production build for shared TypeScript/API changes, dependencies, config,
  bundling/tree-shaking, or production-only behavior. Do not package Tauri merely
  because a button, icon, radius, spacing, or local alignment changed.
- Run reader layout or performance verification only when that skill's mechanism
  actually changed.

Verify only affected states and entry points. Theme, localization, constrained
window, long-content, and shortcut coverage are required only when the change can
alter them. Once the selected evidence passes, stop; do not repeat the same claim
at browser, dev-client, release-client, screenshot, and automated-test levels.

For a dependency or primitive replacement, also verify deleted code, final source
size, tree-shaken production output, listeners/portals/observers, and every affected
consumer. Preserve the existing implementation when total cost or behavioral
parity is uncertain.
