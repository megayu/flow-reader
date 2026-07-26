# Flow Reader EPUB Layout Policy

This is the normative product policy for EPUB layout, spread, page order, and
physical slots. EPUB conformance alone does not define a bug. Update this policy
before expanding the supported model.

## Decision model

| Concern               | Flow Reader rule                                                                                                                                                              |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Layout                | One per book. Package `rendition:layout=roll` uses `pre-paginated` compatibility; use recognized `reflowable` or `pre-paginated` values directly; otherwise use `reflowable`. |
| Flow                  | One per book. Package `scrolled-doc` and `scrolled-continuous` both use the bounded `scrolled-doc` model; all other values use normal paginated behavior.                     |
| Spread intent         | One per book. Precedence: explicit current-book user setting, recognized package `rendition:spread`, application default.                                                     |
| Spread values         | `none` means single page. `auto`, `landscape`, `both`, and deprecated `portrait` mean responsive double page. Missing or invalid package values fall through.                 |
| Actual divisor        | Responsive double page may fall back to one page when width is insufficient. Width is a capability gate, not a preference.                                                    |
| Page order            | Resolve package `pageProgressionDirection` once at book open. Missing means `ltr`; `ltr` is left-first and `rtl` is right-first for navigation, slots, footer, and restore.   |
| Manager `writingMode` | One current value that rendered iframes may update through `updateWritingMode()`. It controls content flow and physical geometry, not logical order.                          |
| CSS writing mode      | Preserve document and descendant writing modes; they do not change logical book order.                                                                                        |
| `textDirection`       | Controls inline text direction only.                                                                                                                                          |

## Placement and restore

- Pre-paginated double-page mode uses a deterministic pairing heuristic rather
  than complete EPUB page placement. Pair adjacent explicit left/right items;
  treat `page-spread-center` as undecided and alternate from the preceding
  resolved slot, or place the first item opposite the nearest following
  explicit item. Repeated explicit slots may leave blanks; never reorder items
  or special-case spine item zero as a cover.
- A one-page LTR reflowable book remains in the left slot across initial open,
  relayout, and restoration.
- Keep terminal-page meaning independent from physical placement:
  `endsAtSectionEnd` must not derive or rewrite `left`, `right`, or `anchor`.
- The same logical position and layout inputs must reproduce the same physical
  slots across initial open, relayout, and restore.
- Body, header, footer, percentage, and visible section indexes must come from
  the same committed pagination snapshot.
- A package-global scrolled book always renders one spine document at a time in
  a single-page layout, regardless of the user spread setting. Each document
  reports `1/1`.
- Footer percentage is the number of completed spine documents through the
  current document divided by the total document count. It does not depend on
  document length or change with the document's scroll position.
- Package-global scrolled documents follow the current document's physical
  block-progression axis: horizontal writing scrolls vertically, while
  `vertical-rl` and `vertical-lr` scroll horizontally toward the physical left
  and right respectively. Hide overflow on the unused axis. Wheel and touchpad
  input scroll within the current document until its logical boundary, then
  turn to the adjacent spine document. Forward turns enter at the logical start
  and backward turns enter at the logical end.

## Deliberate EPUB compatibility limits

| EPUB capability or expectation                                        | Flow Reader policy                  | Product reason                                                       |
| --------------------------------------------------------------------- | ----------------------------------- | -------------------------------------------------------------------- |
| Spine-item `rendition:layout-*`                                       | Ignore                              | Layout is book-wide                                                  |
| Spine-item `rendition:spread-*`                                       | Ignore                              | Single-page or double-page intent is book-wide                       |
| Spine-item `rendition:flow-*`                                         | Ignore                              | Flow is book-wide                                                    |
| Package `scrolled-continuous`                                         | Normalize to `scrolled-doc`         | Bound memory and avoid a second continuous-document navigation model |
| Exact distinction between `auto`, `landscape`, `both`, and `portrait` | Normalize to responsive double page | Measured usable width is more useful than nominal device orientation |
| Reflowable `page-spread-left/right` placement                         | Ignore                              | Logical pagination and user spread take priority                     |
| Independent writing modes for adjacent visible spine items            | Not guaranteed                      | The rendition manager intentionally retains one current writing mode |

A book that depends on these unsupported local behaviors cannot be represented
perfectly. This is an accepted product limit.

## Maintenance and diagnosis

- Keep product decisions here, technical failures in `failure-patterns.md`,
  local invariants in source comments, and executable evidence in tests.
- Diagnose a book in this order: effective global layout, effective global
  spread intent, measured divisor, book page-progression direction, current
  writing mode, physical pagination geometry, and only then supported local
  metadata.
