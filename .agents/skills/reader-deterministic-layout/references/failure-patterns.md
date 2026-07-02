# Reader Deterministic Layout Failure Patterns

Read this before changing Flow Reader layout, pagination, tab-pane, or reader-header/footer logic. Search for symptoms that match the bug before adding new fallback behavior.

## How To Use This File

- Start from a recorded reproduction path when the symptom matches.
- Verify the same invariant after fixing: body, header, footer, page number, percentage, and visible section indexes must come from one committed pagination snapshot.
- Do not hide a mismatch by falling back to persisted CFI, first section, nearest valid section, delayed retry loops, or broad event acceptance.
- When a new deterministic bug is fixed or an approach is rejected, add a compact entry in the matching section: successful fixes or reproducible bug patterns under `Known Failure Patterns`, rejected directions under `Rejected Approaches`. Include symptom, path, root cause, decision, and verification gate.

## Known Failure Patterns

### Header/body mismatch during pending page turn

- Symptom: during a page turn, the iframe body advances to the next chapter while the header/footer still belong to the previous committed snapshot.
- Reproduction path: long generated book, start near the end of one section, trigger next page, sample the client while `tab.turning` is still true and before the pagination snapshot has committed.
- Root cause: epubjs can update the iframe body before Flow Reader has accepted and committed the matching relocated/pagination snapshot.
- Fix direction: keep the loading cover visible while a page turn is pending, and commit body/header/footer/progress together from one snapshot.
- Verification gate: the client verifier must include a pending page-turn gate where a next body is covered until header/footer/body can commit together.

### Cross-section navigation rejected as percentage rollback

- Symptom: after next/previous at a section boundary, body can be on the next chapter while header/footer stay stale because the correct relocated event was rejected.
- Reproduction path: navigate across adjacent sections where the old committed percentage is high enough that the new section's initial percentage looks like a rollback.
- Root cause: a monotonic percentage guard can reject legitimate cross-section navigation when it does not first account for intended section-index direction.
- Fix direction: accept locations whose section indexes move consistently with the active navigation direction before applying percentage rollback checks.
- Verification gate: focused Playwright tests must cover cross-section spread navigation and stale-header prevention.

### Final-page relayout loses terminal spread semantics

- Symptom: after resize/sidebar changes, the body remains in the final chapter but the footer changes from end-of-book to an earlier page such as `1 / 3` or `2 / 3`.
- Reproduction path: open a long generated book, place one tab at the final visible spread, switch away, change reader width, then switch back.
- Root cause: old page indexes were replayed after page count changed. The model preserved "page index 0/1" but lost "this spread ended at the section/book end".
- Fix direction: record whether a spread ends at the section end and resolve the right side to the new last page after relayout.
- Verification gate: tests must cover final-page stability across tab switches and relayouts.

### Shared epubjs EventEmitter state leaks between tabs

- Symptom: resizing or displaying one tab changes another hidden tab's rendition location, body, or manager spread.
- Reproduction path: three tabs at distant sections, resize while tab C is active, then inspect hidden tab A/B runtime locations and committed snapshots.
- Root cause: epubjs EventEmitter state was stored on prototypes, causing manager instances to share listener tables.
- Fix direction: keep EventEmitter state per instance and gate relocated/rendered commits by explicit request or transaction identity.
- Verification gate: multi-tab randomized resize/sidebar/tab-switch client verification must prove inactive tabs do not commit foreign sections.

### Hidden pane measured under a different geometry

- Symptom: tab switching without size changes still changes pages, leaves blank iframes, or blocks page turns.
- Reproduction path: compare active pane rect with inactive pane rect after opening multiple tabs.
- Root cause: inactive panes were positioned offscreen with fixed full-window dimensions, so iframe column layout had different inputs while hidden.
- Fix direction: keep inactive panes in the same reader coordinate system as the active pane using absolute same-geometry layout; hide via visibility, opacity, pointer events, and z-index.
- Verification gate: the verifier must check inactive pane geometry, no hidden input handling, and no pagination counters during unchanged-size tab switching.

### Hidden iframe paint leak in Tauri WebView

- Symptom: DOM says inactive panes are hidden, but screenshots show hidden-tab iframe text over the active tab.
- Reproduction path: same-geometry inactive panes with `visibility: hidden` only, then inspect real Tauri screenshots/pixels after switching tabs.
- Root cause: in the WebView compositor, hidden iframe content can still paint unless the pane is also fully transparent.
- Fix direction: inactive panes need `opacity: 0` in addition to hidden visibility and disabled pointer events.
- Verification gate: real-client verification must include screenshot or pixel checks, not only DOM visibility checks.

### Duplicate active ownership on tab switch

- Symptom: unchanged-size tab switching produces many more active/inactive writes than the expected deactivate-old and activate-new operations.
- Reproduction path: instrument `setActive` calls while switching across three tabs without reader width or typography changes.
- Root cause: tab group selection owned active state synchronously, while a `BookPane` layout effect repeated active writes during cleanup/setup.
- Fix direction: keep active-state ownership in the group/tab model; pane components should only clear active state on unmount.
- Verification gate: pure tab switching should have exactly the expected active flips and zero reader pagination counters.

### Stale layout spread cache after real position change

- Symptom: after turning pages with the sidebar closed, reopening the TOC/sidebar can combine a new snapshot/header with an old iframe body from a previous section.
- Reproduction path: page turn, then return to a previously cached sidebar-open layout state.
- Root cause: layout-specific spread anchors were reused even after the actual reading position changed.
- Fix direction: clear layout spread anchors on committed position changes before storing the new current spread.
- Verification gate: TOC/sidebar reopen after page turns must keep body/header/footer aligned.

### Text edit reload destroys iframe before replacement render

- Symptom: after editing TXT content, the source file timestamp updates quickly but the reader turns blank for several seconds before the updated text appears.
- Reproduction path: open a generated TXT book, edit a visible text node, and sample the active reader immediately after pressing save.
- Root cause: the save callback called `reloadContentAfterEdit`, which destroyed the current rendition and iframe before the new package/rendition/display path finished. Large generated TXT books made the blank interval visible; EPUB books often completed fast enough to hide the issue.
- Fix direction: for the edited active tab, patch the currently rendered section text node in place using the same section/text-node/offset target used by storage, then reformat/expand the view and commit a fresh location snapshot. Fall back to full reload only when the rendered node cannot be verified.
- Verification gate: a real Tauri release client edit must keep active reader iframes mounted and the loading cover hidden while the visible text changes.

### Zoomed media crosses into the adjacent spread page

- Symptom: in double-page mode, increasing reader zoom lets a large image draw over the adjacent page while text continues to reflow inside the page columns.
- Reproduction path: open a reflowable book in double-page mode, set reader zoom above 1, and render an image wider than the current page column.
- Root cause: epubjs image adjustment constrained media with the unzoomed layout column width, while Flow Reader applies zoom using a scaled body with inverse column dimensions.
- Fix direction: when injecting zoom styles into iframe content, constrain media max inline size to the current single-page content column in unscaled coordinates.
- Verification gate: browser Playwright coverage must assert a wide image's rendered width stays within the zoomed single-page content column in double-page mode; final client layout changes still require the deterministic verifier on a Tauri client.

### Non-readable navigation entries block adjacent spread navigation

- Symptom: in double-page mode, TOC entries can point at non-readable resources such as missing XHTML files or `linear="no"` pages, and clicking them can leave navigation stuck at the edge of the readable flow.
- Reproduction path: open a reflowable EPUB whose NCX contains a missing `book-toc.html` entry and a `linear="no"` cover before the first readable section.
- Root cause: navigation entries were exposed even when they did not resolve to readable spine sections; reflowable spread measurement also rejected on missing section resources and aborted page construction.
- Fix direction: filter navigation entries in epubjs before publishing navigation, make spine lookups and `prev`/`next` return only readable sections, and treat confirmed missing section resources as zero-page sections so adjacent navigation keeps scanning.
- Verification gate: targeted reader checks should cover TOC filtering plus next/previous spread navigation across non-readable and missing sections; real-client layout verification is still required for final desktop spread acceptance.

### Single-page special section content offset outside first page

- Symptom: short reflowable sections such as title, inscription, or part-title pages report as one natural page, but their visible text is clipped or shifted outside the first page.
- Reproduction path: open a Kindle-converted EPUB whose short section body uses old `-webkit-box`/`box` centering with viewport-height sizing inside a horizontally paginated reflowable iframe.
- Root cause: epubjs measures the range width as one page, but the author CSS can place the content rect outside the first page's horizontal bounds. Tail blank trimming does not apply because no extra natural page is reported.
- Fix direction: during iframe expansion, only for one-page LTR reflowable horizontal sections, measure the first-page content rect and apply a per-iframe horizontal `translate` when the rect is mostly outside the first page.
- Verification gate: epubjs unit coverage must prove one-page clipped content is corrected while multi-page sections and content already inside the first page are ignored; final desktop layout acceptance still requires real-client verification.

### Short visual section measured as two pages

- Symptom: short front-matter or title-like reflowable sections are reported as two pages even though the useful visual content is a single page.
- Reproduction path: open an EPUB section whose page is mostly a body/html background or whose small centered content crosses the first horizontal page boundary after column layout.
- Root cause: iframe expansion rounds `textWidth()` to page multiples, while trailing blank trimming previously treated only non-empty text/media in the final range as decisive and kept background-only sections at the rounded width.
- Fix direction: keep the correction inside `trimTrailingBlankPages()`: reuse the existing text/media rect scan, collapse only two-page LTR horizontal sections that have page-sized visual backgrounds or small content crossing the page boundary, reject collapse when any meaningful rect starts inside the second page, and leave real two-page bounds unchanged.
- Verification gate: epubjs unit coverage must prove background-only and centered single-page visual sections collapse to one page while real two-page content and compact second-page-start content remain two pages; final desktop layout acceptance still requires real-client verification.

### Text-bearing page backgrounds fitted like covers

- Symptom: EPUB sections with a page background plus readable body text keep the background fitted like a cover image, so later paginated text pages do not each get a full-page background.
- Reproduction path: open a reflowable section with a body/html background image and non-empty body text spanning one or more horizontal pages.
- Root cause: page background normalization only checked the background image geometry and image dimensions; it did not distinguish textless cover-like sections from sections where the background is page decoration behind text.
- Fix direction: detect readable body text with a text-node scan that ignores comments, script/style content, hidden heading text, and hidden elements; keep textless sections on a forced no-repeat fit-inside-page path. For readable sections, first respect authored background layout constraints such as size, repeat, position, and attachment. Only when the author supplies a background image without those layout constraints should epubjs apply the fallback one-layer-per-page stretched background.
- Verification gate: epubjs unit coverage must prove comments and hidden headings do not count as readable text, authored readable background constraints are preserved from inline style and stylesheet rules, unconstrained readable backgrounds use page-sized no-repeat scroll layers, multi-page unconstrained readable sections get one stretched no-repeat scroll layer per page, repeated textless backgrounds are forced to display once, and cover-like textless backgrounds still fit inside the page; final desktop layout acceptance still requires real-client verification.

### Author overflow clips horizontal paginated columns

- Symptom: a reflowable EPUB can show a horizontal scrollbar on the first visible page, then render blank pages after horizontal page turns even though DOM range rects exist in later columns.
- Reproduction path: open a horizontal paginated reflowable section whose author CSS sets `html, body { height: 100%; overflow: auto; }`, then display a later exact spread such as section page 2/3.
- Root cause: paginated layout only forced body `overflow-y: hidden`, leaving body `overflow-x: auto`; Chromium can keep later CSS column fragments measurable but clip their paint when the outer stage scrolls across the expanded iframe.
- Fix direction: in `Contents.columns()`, make the iframe document element the clipped viewport and keep the body overflow visible so horizontal column fragments can paint across the expanded iframe. Hide the stage's native horizontal scrollbar without changing its scrollable surface.
- Verification gate: epubjs unit coverage must prove paginated columns override author overflow to `html { overflow: hidden }` and `body { overflow: visible }`, and browser pixel reproduction should show later exact-spread pages are nonblank.

### Oversized NCX-anchored spine section

- Symptom: opening a text-heavy EPUB can stall and sharply increase memory even when the book has many visible TOC chapters. A malformed implementation of this normalization can also make page turns jump back to the preface or advance only through the last split of each volume.
- Reproduction path: import an EPUB whose OPF spine contains one very large XHTML/HTML section while the NCX has many `content src="large.html#anchor"` entries into that same section. Include minified single-line OPF packages and nested OPF/NCX/content directories in coverage.
- Root cause: the TOC chapters are anchors, not spine sections, so epubjs must load and paginate the whole large DOM as one reflowable section. When rewriting split manifest/spine entries, indentation must not be inferred from non-whitespace text before the matched tag; minified OPFs otherwise duplicate package/manifest prefixes into each split item.
- Fix direction: during first unpack publication, conservatively normalize safe NCX-anchored oversized sections into multiple XHTML/HTML spine items and rewrite OPF, NCX, and existing HTML TOC links. Treat pre-tag text as indentation only when it is whitespace; otherwise insert split manifest and spine entries with empty indentation.
- Verification gate: Rust coverage must parse the rewritten OPF and prove a single package/manifest/spine, correct OPF spine/manifest, NCX entries, HTML TOC links, split file creation, and exported EPUB contents for both single-level and nested directory structures; final desktop performance acceptance still requires release-client before/after measurement on an affected native EPUB.

## Rejected Approaches

### Visibility-only hidden panes

- Attempt: keep inactive panes at the same geometry but hide them only with `visibility: hidden`, pointer-events off, and lower z-index.
- Why it failed: real Tauri WebView screenshots showed inactive iframe text composited over the active tab.
- Do not repeat unless a different compositor strategy is proven with pixel checks.

### Hidden tab kept at active geometry plus exact spread restore without ownership fix

- Attempt: change hidden pane geometry and restore exact spread after resize/activation.
- Why it failed: user-facing behavior got worse, including blank renders, blocked page turns, and restart/first-page regressions. It tried to repair stale runtime state after the fact instead of preventing stale operations from committing.
- Do not repeat without first fixing operation ownership and event gating.

### Active-only resize plus runtime/current target split

- Attempt: limit resize to active tabs and split initial open target from committed runtime target.
- Why it failed: automated eventual-stability tests passed, but rapid tab switching still visibly stalled and the code did not prove unchanged-size tab switch was only a visibility flip.
- Do not treat this as complete evidence for deterministic layout.

### Shell-level tab render reduction without lifecycle ownership change

- Attempt: reduce React work around tabs and no-op same-tab selection without changing rendition lifecycle ownership.
- Why it failed: real multi-tab use still had blocked page turns, blank bodies, first-page restore, and page jumps. The shell got lighter but stale epubjs/runtime events could still commit.
- Do not extend shell-only optimizations as a fix for reader state mismatch.

### Instant tab-strip gate without runtime ownership change

- Attempt: add counters and tab-strip geometry gates but leave deeper runtime ownership unchanged.
- Why it failed: it proved some shell properties but did not explain foreign section/location commits, stale relocated events, persisted-progress races, or shared state.
- Keep diagnostics, but do not use them alone as proof of deterministic reader state.

### Full spread snapshot without operation ownership change

- Attempt: store left/right spread snapshots and validate either visible side.
- Why it failed: the final-page relayout bug still reproduced because operation sequencing and terminal-spread semantics were not fully addressed.
- Keep only when paired with ownership and terminal-spread fixes.

## Current Gates To Protect

- Unchanged-size tab switching must call zero `display`, `next`, `prev`, `resizeRendition`, and `relayoutCurrentView`.
- Hidden panes must keep active-reader geometry and must not leak pixels or receive input.
- Page turns must not reveal a future body under stale header/footer while a committed snapshot is pending.
- Final-page, chapter-start, chapter-middle, and cross-section spreads must survive resize/sidebar/tab-switch operations.
- Browser tests are useful, but WebView compositor and window behavior require real-client verification for final acceptance.
