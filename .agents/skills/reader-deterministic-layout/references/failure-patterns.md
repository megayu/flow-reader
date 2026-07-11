# Reader Deterministic Layout Failure Patterns

Read this before changing Flow Reader layout, pagination, tab-pane, or reader-header/footer logic. Search for symptoms that match the bug before adding new fallback behavior.

## How To Use This File

- Start from a recorded reproduction path when the symptom matches.
- Verify the same invariant after fixing: body, header, footer, page number, percentage, and visible section indexes must come from one committed pagination snapshot.
- Do not hide a mismatch by falling back to persisted CFI, first section, nearest valid section, delayed retry loops, or broad event acceptance.
- When a new deterministic bug is fixed or an approach is rejected, add a compact entry in the matching section: successful fixes or reproducible bug patterns under `Known Failure Patterns`, rejected directions under `Rejected Approaches`. Include symptom, path, root cause, decision, and verification gate.

## Known Failure Patterns

### Reader page decoration follows configured spread instead of actual geometry

- Symptom: a page frame can retain a center seam after responsive double-page mode has fallen back to one page, or vertical-rl can receive writing-direction-specific decoration offsets.
- Reproduction path: enable a page appearance in a wide double-page reader, then switch to single page or narrow the reader; repeat with a vertical-rl book.
- Root cause: presentation state can be derived from the requested spread or writing direction instead of the rendition's current physical `layout.divisor`, column width, and gap.
- Fix direction: keep page decoration in a pointer-inert application-layer overlay, derive its physical geometry from the active rendition layout, and keep it out of EPUB iframe styles and typography signatures.
- Verification gate: UI coverage must prove card frames use the rendition gap, divider/book seams appear only at physical double-page center, vertical-rl uses the same physical geometry, and appearance toggles call no display, resize, or relayout operations.

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

### Tab drag target outline overlaps selected tab chrome

- Symptom: dragging a tab toward the currently selected tab makes the two tabs look stacked or merged even though their layout rectangles remain separate.
- Reproduction path: open at least three tabs, keep the destination tab selected, then drag another tab across its midpoint without releasing.
- Root cause: the selected tab chrome extends into adjacent slots with rounded `before` and `after` pseudo-elements. Drawing a full inset ring around that selected destination emphasizes the extended chrome and reads as a second tab occupying the same slot.
- Fix direction: keep tab rectangles stationary during drag and show one insertion marker at the destination boundary using the normal tab separator's exact width, height, and vertical alignment. Do not outline the destination tab or change tab-strip geometry.
- Verification gate: pointer interaction coverage must prove there is one 2px by 20px centered boundary marker, no destination ring, in-strip release commits the order, out-of-strip release cancels, and reader pagination/activation counters remain unchanged.

### Tab reorder moves mounted reader panes

- Symptom: after dragging a tab, the selected view-mode value can remain double-page while the iframe renders with single-page geometry; other symptoms can include changed pagination, stale search/image/typography state, or inconsistent reader visuals without an obvious pattern.
- Reproduction path: open multiple mounted reader tabs, keep a vertical-rl tab in double-page mode, then drag a tab across the strip and observe child-list mutations on the reader pane parent.
- Root cause: the same reordered `tabs` array drove both tab-strip order and reader pane DOM order. React preserved keyed pane identity but moved the existing pane node with `insertBefore`, which removes and reinserts the node; moving a mounted iframe can invalidate WebView layout/compositor state without changing Flow Reader's view-mode value.
- Fix direction: keep tab-strip navigation order separate from a stable, append-only pane mount order. Reordering tabs must update only tab chrome order and the selected navigation index; mounted pane and iframe DOM nodes must stay in place.
- Verification gate: browser interaction coverage must observe zero reader-pane child-list moves during reorder and preserve pane/iframe/rendition/manager/view references, double-page divisor and spread geometry, pagination snapshots and counters, TOC, search, annotations/definitions, image indexes, and typography state for every tab.

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
- Fix direction: for the edited active tab, patch the currently rendered section text node in place using the same section/text-node/offset target used by storage, then reformat/expand the view and commit a fresh location snapshot. If the rendered node cannot be verified, report the edit as inconsistent immediately.
- Verification gate: a real Tauri release client edit must keep active reader iframes mounted and the loading cover hidden while the visible text changes.

### TXT text edits depend on unstable rendered text-node indexes

- Symptom: editing any generated TXT paragraph or chapter title reports stale text even though the visible text and `source.txt` still match.
- Reproduction path: open a generated TXT book after reader/epubjs DOM or layout changes, select a body paragraph or generated `h2.flow-txt-chapter`, and save a replacement.
- Root cause: storage verified the edit by replaying the rendered iframe's global text-node index against the unpacked XHTML file. The rendered DOM can gain, lose, reorder, or move generated TXT markers relative to the source XHTML, such as epubjs rendering `div[data-flow-body-text] > p` as `p[data-flow-body-text]`, so storage checks the wrong node or receives no paragraph index and returns `TEXT_REPLACE_NODE_STALE`.
- Fix direction: use one XHTML replacement path with structural strategies for generated TXT paragraphs and headings before the generic EPUB text-node strategy. Capture paragraph indexes from the actual rendered TXT paragraph shape, including `p[data-flow-body-text]`, and keep TXT-specific work limited to syncing `source.txt` and `nav.xhtml`; locate source edits by streaming encoded lines to the target chapter and paragraph instead of building full-book line ranges.
- Verification gate: Rust storage coverage must prove paragraph and heading replacements succeed with an intentionally stale rendered `textNodeIndex`; active-tab patching should use the same structural target and report inconsistency if verification fails.

### Zoomed media crosses into the adjacent spread page

- Symptom: in double-page mode, increasing reader zoom lets a large image draw over the adjacent page while text continues to reflow inside the page columns. A related regression can make an authored inline note icon expand to its large intrinsic bitmap size as soon as zoom is explicitly set, including zoom `1`.
- Reproduction path: open a reflowable book in double-page mode, set reader zoom above 1, and render an image wider than the current page column. Also render a large intrinsic image under `sup` or `sub` with an authored relative height such as `0.9em`, then explicitly set zoom.
- Root cause: epubjs image adjustment constrained media with the unzoomed layout column width, while Flow Reader applies zoom using a scaled body with inverse column dimensions. The resulting zoom rule also forced `height: auto !important` on every image, overriding author-sized superscript and subscript icons.
- Fix direction: when injecting zoom styles into iframe content, constrain media max inline size to the current single-page content column in unscaled coordinates. Keep automatic intrinsic height for ordinary images, video, and canvas, but preserve authored heights for images nested under `sup` or `sub` without scanning media nodes or reading computed styles.
- Verification gate: browser Playwright coverage must assert a wide image's rendered width stays within the zoomed single-page content column in double-page mode and a 512-by-512 superscript icon remains at its authored relative height; final client layout changes still require the deterministic verifier on a Tauri client.

### Negative-margin heading background crosses into adjacent spread page

- Symptom: in double-page mode, a colored chapter/title heading background can extend beyond the current page and cover the adjacent page's text.
- Reproduction path: open a reflowable EPUB section whose leading heading has a visible background and author CSS like `margin: -2em -2em 1.5em -2em` while horizontal pagination uses columns for spread mode.
- Root cause: the negative inline margins are authored to make the heading background reach the single-page edge, but in a multi-column spread they expand the heading beyond the current page column and into the next page. Clipping the whole body or iframe is not acceptable because the horizontal column renderer needs later column fragments to remain paintable.
- Fix direction: before measuring a reflowable horizontal LTR section, inspect only the first few direct body children and clamp visible-background title-like blocks' negative inline margins to the current page padding. Do not rewrite unpacked XHTML/CSS, do not add book-specific selectors, and do not change global overflow.
- Verification gate: epubjs unit coverage must prove leading visible-background headings with excessive negative inline margins are clamped to page padding, while headings without visible backgrounds, headings whose margins already fit within page padding, and RTL sections are left unchanged; final client layout verification is still required before claiming desktop visual acceptance.

### Zoomed positioned body background drifts from authored anchor

- Symptom: in a decorated title section, increasing reader zoom makes a positioned body background image drift away from the author's intended corner or edge anchor.
- Reproduction path: open a reflowable EPUB section whose `body` has a single explicitly positioned `no-repeat` background with simple percentage or length `background-size`, then set reader zoom above 1.
- Root cause: Flow Reader zoom scales the body while inversely resizing its layout box. CSS background size and position are resolved against that pre-transform box, so a decorative body background can drift from the visible page anchor.
- Fix direction: during zoom CSS injection, keep the authored background size and pin single-layer explicitly positioned no-repeat body backgrounds with simple numeric `background-size` to the iframe viewport via fixed attachment; leave repeated, fitted, and multi-layer backgrounds untouched.
- Verification gate: focused reader optimization tests must prove explicit positioned decorative backgrounds are viewport-anchored and repeated or fitted backgrounds are ignored; final desktop visual acceptance still requires real-client layout verification.

### Non-readable navigation entries block adjacent spread navigation

- Symptom: in double-page mode, TOC entries can point at non-readable resources such as missing XHTML files or `linear="no"` pages, and clicking them can leave navigation stuck at the edge of the readable flow.
- Reproduction path: open a reflowable EPUB whose NCX contains a missing `book-toc.html` entry and a `linear="no"` cover before the first readable section.
- Root cause: navigation entries were exposed even when they did not resolve to readable spine sections; reflowable spread measurement also rejected on missing section resources and aborted page construction.
- Fix direction: filter navigation entries in epubjs before publishing navigation, make spine lookups and `prev`/`next` return only readable sections, and treat confirmed missing section resources as zero-page sections so adjacent navigation keeps scanning.
- Verification gate: targeted reader checks should cover TOC filtering plus next/previous spread navigation across non-readable and missing sections; real-client layout verification is still required for final desktop spread acceptance.

### TOC targets omitted from package spine

- Symptom: an EPUB opens to its contents page, but clicking chapter entries does not navigate and page turns cannot reach the chapters.
- Reproduction path: import a converter-broken EPUB whose NCX points at real manifest XHTML chapter files while the OPF spine contains only cover/toc-like entries.
- Root cause: epubjs navigation resolves through readable spine sections; manifest resources that are not referenced by `spine/itemref` have no stable reading-order location, progress, or adjacent page-turn state.
- Fix direction: keep the compatibility at first-unpack normalization. When multiple NCX targets resolve to existing manifest HTML resources missing from a suspiciously tiny readable spine, append those manifest IDs to the OPF spine before pagination. Do not add a runtime fallback that displays arbitrary non-spine resources.
- Verification gate: Rust import-normalization coverage should prove missing manifest chapters are added to spine, while isolated missing targets in an otherwise complete spine are left untouched; final reader layout verification is required only when claiming desktop visual navigation acceptance.

### TOC targets marked non-linear

- Symptom: a multi-volume converted EPUB can show an empty or incomplete sidebar TOC, and links from the book's top-level contents page do not navigate.
- Reproduction path: import a Kindle/MOBI-converted EPUB whose NCX, EPUB3 nav toc, or OPF guide toc page points at volume start XHTML files that are present in the spine but marked `linear="no"`.
- Root cause: Flow Reader filters navigation to readable spine sections, and epubjs treats `linear="no"` itemrefs as non-readable even when the book's official TOC points at them.
- Fix direction: keep this repair at first-unpack normalization. Only for targets reached from official TOC sources, change the matching existing spine itemref from `linear="no"` to `linear="yes"`; do not rewrite arbitrary body links and do not change cover or other non-linear resources that are not TOC targets.
- Verification gate: Rust import-normalization coverage should prove NCX, EPUB3 nav toc, and OPF guide toc page targets are made readable while landmark cover entries and unrelated `linear="no"` spine items are preserved.

### Single-page special section content offset outside first page

- Symptom: short reflowable sections such as title, inscription, or part-title pages report as one natural page, but their visible text is clipped or shifted outside the first page.
- Reproduction path: open a Kindle-converted EPUB whose short section body uses old `-webkit-box`/`box` centering with viewport-height sizing inside a horizontally paginated reflowable iframe.
- Root cause: epubjs measures the range width as one page, but the author CSS can place the content rect outside the first page's horizontal bounds. Tail blank trimming does not apply because no extra natural page is reported.
- Fix direction: during iframe expansion, only for one-page LTR reflowable horizontal sections, measure the first-page content rect and apply a per-iframe horizontal `translate` when the rect is mostly outside the first page.
- Verification gate: epubjs unit coverage must prove one-page clipped content is corrected while multi-page sections and content already inside the first page are ignored; final desktop layout acceptance still requires real-client verification.

### Short visual section measured as two pages

- Symptom: short front-matter or title-like reflowable sections are reported as two pages even though the useful visual content is a single page.
- Reproduction path: open an EPUB section whose page is mostly a body/html background, whose small centered content crosses the first horizontal page boundary after column layout, or whose author CSS uses a spread-wide positioned wrapper such as `position:absolute; width:100%; text-align:center` so compact visible text is pinned at the first-page edge.
- Root cause: iframe expansion rounds `textWidth()` to page multiples, while trailing blank trimming previously treated only non-empty text/media in the final range as decisive and only collapsed compact content when it crossed the page boundary. Spread-wide wrappers can make useful text sit at the page edge without crossing it, so the rounded second page was kept.
- Fix direction: keep the correction inside `trimTrailingBlankPages()`: reuse the existing text/media rect scan, collapse only two-page LTR horizontal sections that have page-sized visual backgrounds, compact content crossing the page boundary, or compact content pinned near the first-page edge; reject collapse when any meaningful rect starts inside the second page, and leave real two-page bounds unchanged.
- Verification gate: epubjs unit coverage must prove background-only, centered crossing, compact page-edge, and spread-wide-wrapper single-page visual sections collapse to one page while real two-page content and compact second-page-start content remain two pages; final desktop layout acceptance still requires real-client verification.

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

### Vertical-rl Level 1 columns collapse a spread into one continuous page

- Symptom: a vertical-rl section reports the same `width`, `pageWidth`, `columnWidth`, `gap`, and padding as a horizontal spread, but real-client pixels show one continuous sheet with text crossing the physical middle gap; inline text can also run bottom-to-top when OPF page progression is copied into CSS `direction`.
- Reproduction path: open a reflowable vertical-rl EPUB with `page-progression-direction="rtl"` in double-page mode, then compare body scroll dimensions, character rect order, the physical middle band, and a release-client screenshot against a horizontal control at the same geometry.
- Root cause: in vertical writing, CSS Multicol Level 1 `column-width` is the vertical inline size rather than the physical page width. Reusing the horizontal `column-width` and `column-gap` values preserves misleading computed fields but does not constrain the horizontal block size, so content overflows vertically or forms one spread-wide block. OPF RTL describes page progression and must not be forced onto the vertical text's inline direction.
- Fix direction: keep the same physical body width, height, and four-side padding, but use CSS Multicol Level 2 for vertical-rl: set `column-width` to writable physical height, `column-height` to writable single-page width, `column-count: 1`, `column-wrap: wrap`, `column-gap: 0`, and `row-gap` to the horizontal spread gap. Keep the manager's page progression RTL while leaving the rendered text direction author-controlled.
- Verification gate: unit and browser tests must compare physical page width/gap instead of identically named CSS properties, prove character Y positions advance downward, and prove no text rect crosses the middle gap. Tauri release evidence must cover both tagged vertical books and a horizontal control with equal frame/padding, zero dark pixels in the expected gap crop, and no glyph pixels beneath the expanded right-edge navigation panel.

### Vertical-rl logical spreads reuse horizontal physical slot order

- Symptom: vertical text has a correct two-page frame, but the earlier page appears on the left, page turns skip or repeat content, chapter targets do not begin on the right, restored tabs reopen a different spread, or footer labels disagree with the visible pages.
- Reproduction path: open a reflowable vertical-rl section with at least three logical pages in spread mode, record the right and left page CFIs and footer labels, then turn forward and backward, jump to a chapter target, and restore the same spread from a pagination snapshot.
- Root cause: horizontal pagination helpers encode two separate facts in one left/right model: logical page order and physical slot position. In vertical-rl those facts diverge because the earlier logical page occupies the physical right slot and the later page occupies the physical left slot. Cross-section rendering can make the model look correct while inserting the later section on the wrong side of the stage, so footer and `currentReflowableSpread` checks alone can pass while pixels are reversed.
- Fix direction: derive one explicit pagination model containing writing mode, page progression axis and direction, and spread slot order. Build spreads from logical earlier/later pages, append vertical-rl cross-section views in physical reading order, trim views outside the resolved spread, and commit the same model with the reader pagination snapshot. Keep the horizontal `left-first` path unchanged.
- Verification gate: engine tests must cover first, middle, terminal, and cross-section spreads plus next/previous and location ranges. UI and Tauri release checks must inspect each visible iframe's physical rect and chapter marker, not only model slots; include a one-page chapter on the right, the next chapter start on the left, and the following chapter shortcut.

### Vertical-rl targets are counted from the physical left edge

- Symptom: a nested TOC item opens unrelated content near the end of its section, repeated previous-chapter shortcuts become stuck, Cmd-F skips visible same-page matches, or a sidebar search result opens a page that does not contain the result.
- Reproduction path: in a multi-page vertical-rl section, resolve an element-id or CFI target whose first glyph is near the physical right edge, then compare the selected page with the target glyph rect and repeat navigation across a section boundary.
- Root cause: horizontal target pagination derives a page index from `targetRect.left / pageWidth`. Vertical-rl progresses from the physical right edge, and a fragmented wrapper's bounding rect can cover many columns instead of identifying the target's logical first glyph. Explicit chapter targets also reused the current cross-section phase, while forward chapter navigation incorrectly read the physical right/start endpoint even when the next chapter start was already visible on the logical later/left page.
- Fix direction: resolve the target's first meaningful character rect, calculate its vertical-rl page index from the rendered view's physical right edge, and give chapter/TOC displays an explicit spread-start alignment option. Chapter navigation must use logical location order just like horizontal reading: forward resolves from `location.end`, backward from `location.start`; only the physical start slot changes from left to right.
- Verification gate: epubjs tests must cover right-edge, middle, and left-edge targets. UI tests and Tauri release checks must cover nested TOC clicks, repeated previous/next chapter shortcuts, multiple same-page Cmd-F matches, and sidebar-result activation with visible marks in both tagged vertical books.

### Chapter find counts document metadata as visible text

- Symptom: searching text that appears in a chapter title reports extra results, opens the final page for previous results, or shows no highlight; ordinary body-only queries work. On a cross-section horizontal spread, Cmd-F can also search the right page's next chapter instead of the left reading-order start page.
- Reproduction path: search a title word that exists in both XHTML `<head><title>` and the rendered heading, then move to the previous result. Repeat on a horizontal cross-section spread whose left and right pages belong to different sections.
- Root cause: `Section.find()` and `Section.search()` walked the whole XHTML `document`, so non-rendered metadata produced CFIs that could not be highlighted. Chapter-find scope also selected the physical right slot unconditionally, which is correct only for `right-first` vertical pagination and wrong for `left-first` horizontal pagination.
- Fix direction: restrict section text search to `document.body` with `documentElement` only as a body-less fallback. Select the scoped section from the pagination model's `spreadSlotOrder`, using the opposite slot only when the reading-order start slot is absent.
- Verification gate: epubjs tests must prove head-only text returns no matches. Reader tests must cover the same unique title token in head and body for horizontal and vertical books, plus pure `left-first`/`right-first` scope selection. Tauri release checks must verify known title queries in both tagged vertical books and a horizontal control with result counts, disabled boundary buttons, body-owned CFI ranges, and a visible active highlight.

### Vertical-rl zoom and view-mode changes reuse horizontal column axes

- Symptom: switching to single-page mode leaves two stale iframe views, zoomed vertical text exceeds the page frame, or Cmd-F advances its counter/footer while the active highlight remains one page offscreen. The Cmd-F failure can occur while the reader remains in double-page mode.
- Reproduction path: open a vertical-rl spread, switch between double and single page, apply a non-default zoom, and inspect view count plus computed `column-width`, `column-height`, `row-gap`, transform, and physical frame bounds.
- Root cause: spread and layout-signature effects can start overlapping relayouts, and the visible-view shortcut can retain a section that is no longer part of the single-page spread. Zoom also used a physical left transform origin for right-anchored vertical content. Single-page layout supplied `column-height = pageWidth` and then added `row-gap`, making the actual row stride larger than the manager's page width. A separate failure occurred whenever a relayout changed the physical `pageWidth` of an existing iframe while its measured text width stayed equal. This can happen during double-page layout without a view-mode switch. `_contentPageCount` then retained geometry calculated with the previous page width, so the model and footer advanced while the stale RTL pixel offset left the active highlight offscreen.
- Fix direction: serialize relayout requests under the existing latest-operation ownership token, trim views outside the resolved spread, anchor vertical zoom at the physical top-right, and derive Multicol Level 2 row geometry from the active writing mode. In single-page vertical-rl, use `column-height = pageWidth - rowGap`. Track the last applied physical page width per iframe; when it changes, clear content width/page-count caches and force remeasurement before positioning the spread.
- Verification gate: UI tests must assert exactly one section view in single-page mode, stable view count after mode changes, vertical zoom axis values, body bounds inside the iframe, and zero text Range rects crossing the visible page boundary. Cmd-F must cross to an off-page result in both single and double modes with the target page and active highlight visible. Tauri release checks must cover both tagged vertical books.

### Vertical-rl overlays reuse horizontal above/below geometry

- Symptom: note popovers and selection menus cover vertical text or clip outside the reader, definition waves appear beneath glyphs instead of on their left, and a multi-line highlight can be interpreted in physical left-to-right order.
- Reproduction path: in a vertical-rl page, open a linked note near the physical right side, release a multi-line selection near a page edge, create both highlight and underline annotations, and define a visible word. Compare each overlay rect with the selected range fragments and physical page bounds.
- Root cause: horizontal overlay helpers treat the inline axis as left-to-right and place UI above or below a range. Vertical-rl needs physical side placement while preserving logical range order: top-to-bottom within a line, then right-to-left across lines. marks-pane's default underline also always draws along the physical bottom edge.
- Fix direction: share one page-bounded left/right placement helper with explicit preferred side, fallback, margin, gap, and avoid rects. Preserve release-point vertical alignment for the selection menu, clone note content with explicit vertical writing styles, order range fragments by descending physical x then ascending y, and draw vertical definition waves and annotation underlines on each glyph fragment's physical left.
- Verification gate: pure geometry tests must cover preferred/fallback sides and selection avoidance; browser tests must prove a complete two-by-five action grid, vertical note content, punctuation overrides, and left-side waves. Tauri release checks must create and click annotations in both tagged books, prove cross-line bottom/top fragment geometry, and verify linked note placement in every book that contains internal note links.

### Inline-wrapper paragraphs ignore body typography

- Symptom: EPUB text appears readable, but custom body typography does not affect the visible text in chapters where every paragraph is shaped like `p > span` or `p > b`.
- Reproduction path: open a Calibre/Sigil-like reflowable EPUB whose paragraph nodes have no direct text and all visible text is inside direct inline children with their own classes.
- Root cause: Flow Reader marks paragraph candidates as body text, but injected body typography only targets the marked paragraph; classed child inline elements keep their authored font styles.
- Fix direction: keep body detection at paragraph granularity, mark only selected body paragraphs that have no direct text and only direct text-bearing inline wrapper children, then pierce typography CSS to those direct children.
- Verification gate: focused body-text tests must prove inline-wrapped paragraphs receive the wrapper marker without expanding detection to arbitrary descendant inline nodes; final desktop layout acceptance still requires real-client verification when claiming visual/page-count stability.

### Cross-section note popovers keep author font size

- Symptom: after increasing reader font size, note popovers opened from cross-section footnotes can stay at the EPUB author's smaller footnote size.
- Reproduction path: open an EPUB whose body note reference links to a split footnote section, increase typography font size, then open a footnote whose source CSS sets the note block to `0.75em` or `0.8em`.
- Root cause: Flow Reader clones popover content from the linked note element. For cross-section notes, the hidden render path loads the raw section document and does not pass through the active rendition typography injection before computed styles are copied.
- Fix direction: identify note content from linked note/backlink structure instead of expanding class or id term lists, and apply the active reader font size to the cloned popover content tree after normalizing the note clone.
- Verification gate: focused note marker and body-text tests must cover backlink-marked note content; UI or client verification should confirm the popover font changes with the reader typography setting.

### Note popovers show scrollbars without content overflow

- Symptom: a short linked note fits inside its page-bounded popover but still shows scroll chrome, while long horizontal or vertical notes must remain scrollable.
- Reproduction path: open a short reciprocal linked note and compare its physical client and scroll dimensions, then extend the same note beyond the available physical width or height.
- Root cause: the note content container was always declared `overflow: auto`, so WebView scrollbar presentation could appear even when neither physical axis overflowed. The first conditional attempt compared `scrollHeight` with rounded `clientHeight`; in WebView2, glyph ink can extend a few pixels beyond a complete line box, so a source note measured `clientHeight = 72` and `scrollHeight = 75` even though all content fit naturally and the page allowed `675.5px`. Treating either physical axis as scrollable also lets an unrelated cross-axis difference create the wrong scrollbar. Pairing `overflow-x: hidden` with `overflow-y: visible` is invalid for this purpose because CSS computes the visible axis to `auto` when the other axis is hidden, scroll, or auto.
- Fix direction: reuse the popover's existing resize measurement and follow the writing direction. Horizontal notes scroll only when physical content height exceeds the configured page-bounded `maxHeight`, clip the horizontal axis, and otherwise leave vertical overflow visible. Vertical-rl notes scroll only when physical width exceeds client width, clip the vertical axis, and otherwise leave horizontal overflow visible. Use `clip`, not `hidden`, for the inactive non-scrolling axis. Do not add a document-wide observer or remove scrolling from genuinely long notes.
- Verification gate: focused browser interaction coverage must prove glyph overflow can make `scrollHeight` exceed `clientHeight` without enabling scrolling while it remains below `maxHeight`, and that content above `maxHeight` still enables vertical scrolling. Final acceptance must use a real Tauri release client with an affected native EPUB and record client/scroll/max dimensions plus computed overflow; vertical coverage must retain its physical horizontal scroll path and clipped vertical axis.

### Oversized NCX-anchored spine section

- Symptom: opening a text-heavy EPUB can stall and sharply increase memory even when the book has many visible TOC chapters. A malformed implementation of this normalization can also make page turns jump back to the preface, advance only through the last split of each volume, or generate split files with browser-visible structure errors such as orphan closing tags.
- Reproduction path: import an EPUB whose OPF spine contains one very large XHTML/HTML section while the NCX has many `content src="large.html#anchor"` entries into that same section. Include minified single-line OPF packages, nested OPF/NCX/content directories, and oversized sections whose NCX anchors are placed on text blocks wrapped by repeated container elements such as `div.text > p#anchor`.
- Root cause: the TOC chapters are anchors, not spine sections, so epubjs must load and paginate the whole large DOM as one reflowable section. When rewriting split manifest/spine entries, indentation must not be inferred from non-whitespace text before the matched tag; minified OPFs otherwise duplicate package/manifest prefixes into each split item. When creating split XHTML files, cutting exactly at the anchor tag can leave already-open wrapper elements in the previous generated file and unmatched closing tags in the next generated file. XML-parser validation and ad hoc tag blacklists are also too strict for real EPUB content that browser engines can read, such as HTML named entities, embedded SVG, or legacy prefixed tags without namespace declarations.
- Fix direction: during first unpack publication, normalize NCX-anchored oversized sections into multiple XHTML/HTML spine items and rewrite OPF, NCX, generated split-file internal links, and existing HTML TOC links. Do not reject solely because the oversized section contains tables, normal anchor links, XHTML DTD declarations, browser-compatible named entities, embedded Web content, or legacy prefixed tags; choose a recoverable block boundary for each NCX anchor and synthesize required open and close ancestor tags around generated fragments. Treat pre-tag text as indentation only when it is whitespace; otherwise insert split manifest and spine entries with empty indentation.
- Verification gate: Rust coverage must prove a single package/manifest/spine, correct OPF spine/manifest, NCX entries, HTML TOC links, split file creation, exported EPUB contents for both single-level and nested directory structures, wrapped-anchor oversized sections, browser-compatible entity/prefixed-tag/embedded-Web-content, and no obvious orphan closing tags from generated split boundaries; final desktop performance acceptance still requires release-client before/after measurement on an affected native EPUB.

### Malformed NCX navLabel text removes navPoint content

- Symptom: opening an EPUB fails before the reader renders with `Cannot read properties of null (reading 'getAttribute')` from `Navigation.ncxItem`.
- Reproduction path: open a MOBI-converted EPUB whose `toc.ncx` has a `navLabel/text` containing unescaped angle-bracket command notation such as `<Key-x>{arg}` while the matching XHTML heading correctly escapes it as `&lt;Key-x&gt;`.
- Root cause: the invalid NCX text can corrupt or truncate the parsed `navPoint` subtree before epubjs builds navigation, so later siblings disappear or a `navPoint` appears without a direct `content src`. The old NCX parser assumed every `navPoint` had a descendant `content`, and could also incorrectly use a child navPoint's `content` as the parent's target.
- Fix direction: keep this compatibility inside epubjs NCX handling: before XML parsing, escape raw `<` characters inside NCX `navLabel/text`; after parsing, require a direct child `content src`, skip malformed navPoints instead of throwing, and promote valid child navPoints when their parent was skipped. Do not alter pagination or add reader reload fallbacks.
- Verification gate: epubjs Navigation tests must cover unescaped angle brackets in raw NCX labels, missing direct NCX `content`, child promotion after a malformed parent, and preservation of valid sibling navigation entries.

### Fixed-layout pages omit viewport but declare original resolution

- Symptom: an image-only fixed-layout EPUB renders each page partially clipped even though the source image is complete; opening the image directly shows the full page. Image indexing can also throw from `createTreeWalker` when a parsed section document has no `body`.
- Reproduction path: open a Kindle Comic Creator style EPUB whose OPF metadata declares `rendition:layout` as `pre-paginated`, `fixed-layout` as true, and `original-resolution` such as `1200x1920`, while individual XHTML pages contain a single large image and omit `meta name="viewport"`.
- Root cause: epubjs fixed-layout `fit()` scales pages from the per-page viewport meta. Without that tag it has no stable authored coordinate system, so large image pages can be laid out against the iframe size and clipped. Flow Reader image classification also assumed every section document has `document.body`.
- Fix direction: parse OPF `original-resolution` as a fixed-layout fallback viewport only when `rendition:viewport` is absent and the book is pre-paginated; pass that fallback into `Contents.fit()` and use it only when the page itself omits viewport dimensions. Do not scan image dimensions, rewrite unpacked XHTML, or override page-authored viewport tags. In image classification, fall back from `document.body` to the document element before creating a tree walker.
- Verification gate: epubjs tests must prove `original-resolution` becomes a fallback viewport, fixed-layout fitting uses it only when page viewport is missing, and page viewport wins when present; reader optimization tests must prove missing `body` does not make start-position image classification throw.

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
