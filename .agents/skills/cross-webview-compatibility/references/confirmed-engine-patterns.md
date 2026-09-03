# Confirmed Cross-Engine Patterns

Read only the section matching the mechanism being changed. These are verified
Flow Reader development constraints, not a chronology of past fixes.

## Event, focus, and overlay ownership

### Match listener lifetime to the input source

- A stable external DOM listener may retain its proxy, but refresh the callback
  ref in `useLayoutEffect` when input immediately after a React commit must see
  the new state. A passive effect leaves a valid stale-callback window.
- `useLayoutEffect` still starts after the first React commit. Install a global
  shortcut in bootstrap when it must work during asynchronous startup before
  the application tree commits.
- Iframe events do not bubble to the parent document. Acquire every document or
  window that can own input, and reacquire on iframe replacement. Prefer an
  existing rendition/content event pipeline when it already follows every new
  document; do not combine it with a second per-frame keyboard mechanism.
- A portal's DOM is outside the opening component's DOM subtree, even though
  React synthetic events can follow the React tree. Element-local native handlers
  cannot own all Escape input across a parent-document portal and reader iframes.

### Give each Escape one owner

- A cross-document overlay may listen in capture and consume Escape, but it
  must unwind one layer at a time and have one logical handler.
- A lower overlay must yield when the event target is inside another explicit
  keyboard-capture layer. Do not require the target to remain inside the lower
  overlay: after a view replacement WebKit can temporarily target the main
  document body even though the lower overlay still owns the action.
- Remove superseded local, iframe-only, or primitive-specific Escape paths once
  the shared owner is established. Parallel listeners hide ordering bugs and
  can handle one key twice.

### Treat browser focus completion as asynchronous when proven

- WebKit can finish its native Tab-focus caret restoration after focus-handler
  microtasks. If the product requires select-all or caret-at-end, apply it in
  the earliest proven later task and first confirm the same element is still
  active.
- Keep pointer focus native. Do not repeat selection writes across microtasks,
  animation frames, and timers to win a race.
- Forced focus does not repair missing iframe events or unclear Escape
  ownership. Observe the actual active element and event document first.

### Context-menu input

- Use the `contextmenu` event as the secondary-click contract. Do not require
  `button === 2`; macOS Control-click and trackpad gestures need not report the
  same button value as a Windows mouse.
- When the application owns the menu, call `preventDefault` synchronously in the
  `contextmenu` handler for every document that can produce it. If the event
  reaches JavaScript but the native menu still appears, test capture-phase
  interception. Capture cannot repair callbacks blocked by an iframe sandbox.
  Audit earlier `pointerdown` and `mousedown` handlers: their cancellation can
  suppress later selection or context-menu delivery.
- `preventDefault`, propagation control, menu rendering, and selection-state
  creation are separate boundaries. Confirm which boundary first diverges
  before changing another one. An animation frame cannot repair an event that
  never reached JavaScript.

## Sandboxed iframe events and security

### WebKit parent-installed callback rule

- WebKit bug 218086 treats a callback installed by the parent into a sandboxed
  same-origin `srcdoc` frame as script execution. With only
  `allow-same-origin`, native selection may visibly occur while parent-installed
  pointer, click, or context-menu callbacks never run.
- When Flow Reader requires those parent-owned callbacks, use
  `allow-same-origin allow-scripts` and preserve script blocking independently.
  `bypassCSP`, capture listeners, focus changes, and delayed React state do not
  change the sandbox permission boundary.
- Apply the same rule to EPUB content and generated rich dictionary frames.
  Sanitization, resource restrictions, and CSP remain independent protections;
  one does not replace the others.

### CSP must cover the serialized document shape

- An `allow-scripts` compatibility change is incomplete until ordinary authored
  scripts remain blocked and the explicit scripted-content opt-in still works.
- Insert the blocking CSP as the first child of the actual parsed `head` before
  serialization. Never locate a security boundary by matching markup strings:
  comments and text can contain fake `<head>` tokens.
- Reuse the existing parsed document and its one serialization pass. Remove a
  temporary CSP node afterward so the in-memory section is not persistently
  mutated.
- Cover XHTML with or without an authored head, standalone SVG roots, and every
  loader (`srcdoc`, blob URL, and `document.write`). Wrap a standalone SVG in a
  minimal HTML document whose head contains the CSP.
- A meta-delivered policy applies only after the meta and only from a valid HTML
  head. Verify attempted payload execution, not only the presence of an
  attribute or sanitizer output.

References: [WebKit 218086](https://bugs.webkit.org/show_bug.cgi?id=218086),
[MDN iframe sandbox](https://developer.mozilla.org/en-US/docs/Web/HTML/Element/iframe#sandbox).

## CSS layout and geometry

### Select the vertical pagination model by capability

- Chromium's vertical pagination path uses the complete Multicol Level 2 pair
  `column-height` plus `column-wrap`. WebKit lacks that pair and exposes the
  private `-webkit-column-axis: horizontal` model.
- These are different models, not prefixed spellings. In the Level 2 path,
  `column-width` is the vertical inline extent, `column-height` is physical page
  content width, and `row-gap` is the physical horizontal gap.
- In the WebKit path, the effective pagination root width determines physical
  fragmentation; `column-width` remains the vertical inline extent. Size the
  root to one physical page stride and do not overwrite prefixed column width
  with horizontal page width during zoom.
- Preserve the one-page root stride in both single- and double-page zoom. Scale
  physical width, padding, and gap consistently.
- Feature-detect the complete capability pair. Audit all CSS and JavaScript
  spellings—`column-height`, `columnHeight`, `column-wrap`, and `columnWrap`—and
  clear stale declarations when changing modes.
- Assertions must compare physical page width, gap, containment, glyph order,
  and seam crossings. Do not fabricate unsupported computed properties merely
  to make both engines report the same field names.

Reference: [Readium CSS EPUB compatibility](https://readium.org/css/docs/CSS21-epub_compat.html).

### Guard intrinsic sizing chains

- `flex: 1 1 0%` or `basis-0` can remove content's intrinsic contribution when
  combined with `max-height: max-content` and percentage-sized descendants in
  WebKit. A child may look painted while its hit-test container has collapsed.
- Change only the implicated basis to `auto`; do not mechanically replace
  toolbar uses that have no intrinsic or percentage block-size dependency.
- A percentage `max-width` inside a `width: max-content` vertical popover can
  create another intrinsic cycle. Use shrink-to-fit inline-block sizing with a
  finite page-derived pixel maximum, and do not latch scroll state from an
  incomplete zero `clientWidth` observation.
- When a click reports a visible stable target but hits an ancestor, compare
  element rectangles, scroll/client dimensions, and `elementFromPoint` before
  changing pointer handlers or adding waits.

### Measure the rendered invariant

- Glyph ink, line boxes, scroll areas, and rounded client dimensions are not
  interchangeable. Chromium may include oversized glyph ink in `scrollHeight`
  while WebKit may keep `scrollHeight === clientHeight`.
- Use text `Range` bounds to prove ink overflow and scroll dimensions to prove
  actual scrolling. Decide overflow on the physical axis for the writing mode,
  and use `clip` for the inactive non-scrolling axis when `hidden` would compute
  the other axis to `auto`.

Reference: [CSSOM View](https://www.w3.org/TR/cssom-view/).

## Asynchronous reader state

- Do not drop navigation merely because a prior turn is still committing. Wait
  for the owning navigation and any queued layout transaction before starting
  the next valid operation.
- A mutable single `pending` promise cannot represent nested navigation plus its
  display operation. Track a bounded set and drain snapshots until the set is
  empty; otherwise an inner operation can hide or clear its outer owner.
- Stable-state and persistence consumers must wait for the complete pending set,
  including work queued while waiting. Keep a synchronous idle path so normal
  navigation does not gain an unnecessary async boundary.
- Use explicit operation identity for latest-wins layout work. Timing differences
  expose invalid ownership but are not themselves a reason to add delays.

## Test evidence boundaries

- Ordinary keyboard and pointer input is the default evidence. Replace it only
  after a small standalone reproduction or confirmed upstream issue establishes
  a driver or browser capability limitation.
- If an old green test turns red, run it unchanged and focused in both engines.
  Do not dismiss it only because its feature appears unrelated.
- Prefer physical/user-visible outcomes over implementation properties that an
  engine does not support. Never polyfill computed style, disguise sandbox
  flags, add engine-specific waits, or weaken assertions to manufacture green.
- Browser permission support differs. If the product contract is native copy,
  use real copy input and verify the result with real paste into a controlled
  target. Do not require WebKit to grant Chromium clipboard permissions or mock
  the Clipboard API.
- A Playwright WebKit pass is development evidence for WebKit-family behavior,
  not proof that the system WKWebView, WebKitGTK, native menu, or compositor was
  exercised. Reserve those claims for the relevant real client.
- A broad speculative production diff is evidence to recheck the diagnosis.
  Remove trace logging, scratch probes, temporary configs, and result reports
  after their reusable conclusions have been captured here.
