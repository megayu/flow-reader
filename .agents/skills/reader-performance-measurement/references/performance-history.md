# Reader Performance History

Read this before proposing or testing a Flow Reader performance change. Search for the touched area and avoid repeating rejected approaches unless the underlying ownership, DOM shape, or measurement condition has changed.

## How To Use This File

- Treat retained entries as current design constraints until a fresh release-client comparison proves otherwise.
- Treat rejected entries as known bad tradeoffs. Retest only when you can name the code-path change that invalidates the old result.
- Prefer `tauri-release` comparisons for acceptance. Dev or browser smoke runs can validate scripts, but they do not replace release-client evidence.
- When a new experiment is accepted or rejected, add a compact entry here in the matching section: accepted or retained conclusions under `Retained Approaches`, rejected conclusions under `Rejected Approaches`. Include the scenario set, key deltas, decision, and reason.

## Retained Approaches

### Invalidate iframe page counts only when physical page width changes

- Change: keep the last applied `pageWidth` on each iframe view and clear content width/page-count caches only when that value changes. This makes any relayout with changed physical page geometry, including relayouts that remain in double-page mode, remeasure vertical pages without adding work to ordinary same-width page turns.
- Measured effect: final `tauri-release` native-book comparison against `perf-results/vertical-rl-horizontal-baseline/result.json`, with 12 single runs and 4 bursts, covered the closed-sidebar steady paths. `page-turn` operation p50/p95 changed +2.6%/-22.2%, first-frame p95 -9.9%, and settled p95 +3.1%. `page-turn-api` operation p50/p95 changed -13.1%/+5.3%, first-frame p95 -0.4%, and settled p95 -2.7%. Rapid page-turn burst p95 improved 36.5%. No long tasks were introduced. Artifact: `perf-results/cmdf-next-page-horizontal-after/reader-performance-2026-07-11T02-36-51-587Z.json`.
- Decision: keep. The targeted release comparison shows no stable horizontal page-turn regression; unmeasured sidebar and tab scenarios are not part of this conclusion.
- Constraint: do not clear these caches on same-width `setLayout()` calls. Re-run view-mode correctness plus steady page-turn measurements if the invalidation condition broadens.

### Keep vertical target mapping and relayout ownership off steady horizontal page turns

- Change: map vertical-rl targets from the rendered view's right edge, explicitly align chapter targets to the reading-order first slot, trim views outside the resolved spread, serialize view-mode relayout requests, and derive zoom row geometry from writing mode. Horizontal target math and ordinary next/previous paths retain their existing behavior.
- Evidence correction: the earlier retained note for this change relied on inconsistent full/isolated runs and dismissed 20%+ operation and first-frame regressions because settled p95 was below 10%. That was not a valid no-regression conclusion and is superseded by the measurements below.
- Measured effect: the final `tauri-release` native-book comparison used a verified isolated library copy under `perf-results`, the existing release baseline, 12 single runs, and 4 burst runs. All page-turn operation and first-frame p50/p95 values were unchanged or faster; rapid page-turn burst p95 improved 25-43%; rapid tab-click burst p95 improved 29-43%; no page-turn long tasks were introduced. The full run's only positive delta above 10% was `tab-switch/sidebar-closed` operation p50 at +11.6%, while its p95 and settled metrics improved. An isolated repeat made that same operation p50 -7.5%, operation p95 -45.9%, first-frame p50 -6.3%, settled p50 -7.1%, and long tasks 1 -> 0, so the full-run p50 increase was not stable. Artifacts: `perf-results/vertical-rl-followup-final-horizontal-compare.{txt,json}` and `perf-results/vertical-rl-followup-tab-switch-isolated-compare.{txt,json}`.
- Decision: keep. The corrected release evidence shows no stable horizontal performance regression and no new long tasks.
- Constraint: keep target glyph probing vertical-only, use explicit spread-start alignment only for chapter/TOC navigation, and keep ordinary horizontal next/previous operations on their existing phase-preserving path. Re-run the same complete release scenarios if target resolution, view trimming, or shared relayout ownership changes again.

### Reuse the iframe view writing mode during style injection

- Change: when epubjs calls the reader's `beforeLayout` hook, use the writing mode already resolved by `IframeView` instead of probing computed styles and walking the dominant content chain a second time. Keep the contents probe only for style refreshes that have no view context.
- Measured effect: `tauri-release` native-book comparison used the same 12 page-turn, rapid-page-turn, tab-switch, tab-click, and rapid-tab-click scenarios as the pre-change baseline, with 12 single runs and 4 burst runs. Page-turn first-frame p50 improved about 11-26%, rapid page-turn burst p95 improved about 26-45%, and rapid tab-click burst p95 improved about 29-48%. No page-turn long tasks were introduced. A full-run `tab-click/sidebar-toc` p95 outlier was not stable: an isolated 12-run repeat improved operation p95 from 91.8ms to 79.6ms, first-frame p95 from 99.6ms to 89.9ms, settled p95 from 337.9ms to 280.4ms, and long-task count from 2 to 0.
- Decision: keep. It removes duplicate synchronous layout inspection and preserves the vertical style branch without adding horizontal page-turn work.
- Constraint: only trust `view.writingMode` after epubjs has resolved and set it. Code paths that refresh existing contents without a view must retain the contents-based fallback.

### Virtual list overscan 4

- Change: reduce virtual list overscan from 8 to 4.
- Measured effect: improved p50 first frame in closed-sidebar tab switch by about 24%, TOC tab switch by about 17%, annotation/image tab switch by about 10-14%, and closed-sidebar page turn by about 40%. Long-task totals dropped in the main tab-switch paths.
- Decision: keep. It balanced tab switching and page turns better than overscan 2.
- Constraint: do not lower overscan globally just because TOC looks faster in isolation; closed-sidebar and page-turn paths must stay in the comparison.

### Lazy tooltip content mount

- Change: keep tooltip triggers mounted, but render tooltip content only while open.
- Measured effect: heavier tab-switch paths improved about 4-11%, TOC page-turn first frame improved about 25%, and tab-switch long-task totals dropped. Search sidebar first frame regressed by less than 1ms in absolute terms.
- Decision: keep. The only regression was tiny on an already-fast path.
- Constraint: tooltip changes still need UI interaction tests because the optimization changes mount timing.

### Narrow TOC pane Valtio snapshot scope

- Change: avoid reading the whole focused book snapshot for TOC tree work; use narrow primitives and immutable nav data.
- Measured effect: static-production p50 improved across required scenarios, including about 10% for TOC tab switching and 14-19% for page-turn first frame. Long tasks dropped substantially in tab-switch paths.
- Decision: keep.
- Constraint: copy this pattern only when the state being bypassed is stable/immutable enough. Adding frequently updated primitives can be worse.

### Pause hidden TOC auto-scroll effects

- Change: keep hidden sidebars mounted, but skip hidden TOC/library auto-scroll effects while inactive.
- Measured effect: hidden-panel diagnostics stopped showing hidden `scrollTo` calls. Formal tab-switch first-frame improved about 13-33%, and several tab-switch long-task totals dropped to zero.
- Decision: keep.
- Constraint: this was not a license to unmount or clear hidden list rows; returning to a panel must not become more expensive.

### Direct TOC locate handler

- Change: remove the state/effect chain for "locate current"; schedule the scroll directly when expansion does not need a render.
- Measured effect: small cleanup. React Doctor issue count dropped by one; performance gain was not the main claim.
- Decision: keep because it removes avoidable active-pane state churn without changing visible behavior.

### RAF-throttled virtual list scroll state

- Change: schedule virtual-list viewport updates through `requestAnimationFrame` instead of updating synchronously inside the scroll event.
- Measured effect: reduced TOC-open rapid tab-click long-task pressure in the retained measurement set, while keeping list DOM shape and scroll behavior.
- Decision: keep with monitoring.
- Constraint: do not assume RAF is always faster. Measure closed-sidebar, TOC, and page-turn scenarios together because a scroll-state change can move work between paths.

### Lightweight TOC rows

- Change: use a TOC-specific lightweight row instead of the generic row shell where the generic features are not needed.
- Measured effect: removed TOC-open tab-switch long tasks in the retained run while preserving row text, click behavior, twisty behavior, dimensions, tooltip behavior, and scroll behavior.
- Decision: keep.
- Constraint: keep the row accessibility and keyboard behavior under review; do not remove semantics for a performance-only goal without separate evidence.

### TOC viewport slot reuse

- Change: key visible TOC virtual-list rows by viewport slot instead of nav-item identity.
- Measured effect: TOC child-list churn dropped from about 160 added/removed nodes to about 1/1 in the diagnostic path. TOC tab-switch long-task total went to zero in the retained run, and rapid tab-click long-task total dropped materially.
- Decision: keep.
- Constraint: this is valid because the row represents a recycled viewport slot, not persisted user data identity. Do not generalize it to library/book rows.

### Inactive sidebar view gates

- Change: keep each sidebar view shell mounted, but do not render inactive heavy subscribed subtrees for TOC, search, annotations, images, and typography.
- Measured effect: final retained comparison made rapid tab-switch long-task totals zero with the sidebar closed and TOC open. Tab-switch first-frame averages improved about 21-65% across sidebar panels. Page-turn long tasks remained zero.
- Decision: keep.
- Constraint: keep the outer `PaneView` ownership and visible sidebar model. Do not replace this with a broad "render only active view" change unless ownership is redesigned and remeasured.

### Invalidate stale layout spread cache on position changes

- Change: clear layout-specific spread anchors on committed location changes before recording the new spread.
- Measured effect: `page-turn/sidebar-toc` changed from failing due to stale body/header mix to passing; post-fix TOC page-turn first frame stayed in the expected range.
- Decision: keep as a correctness/performance prerequisite.
- Constraint: performance work must not reintroduce stale layout reuse after real reading-position changes.

### Live patch active text edit after save

- Change: after a text edit succeeds, patch the edited active tab's rendered section text node in place and re-report the current location. If the edited active tab cannot be verified and patched, report an inconsistency instead of destroying and reloading the active rendition.
- Measured effect: in `tauri-release` custom UI verification on a generated TXT book, the active reader kept 2 iframes mounted, the loading cover stayed hidden, and visible text changed within about 55ms after save sampling started.
- Decision: keep. It removes the user-visible blank interval caused by destroying the rendition before the replacement render finishes.
- Constraint: only use this for the edited active tab when the selected live text node or structural paragraph/heading target verifies against the original text and offsets. Other tabs should reload after an edit; the edited active tab should fail visibly if verification does not match.

### Fail-fast generated TXT text edits

- Change: generated TXT paragraph edits require the structural paragraph index captured from the rendered paragraph and no longer infer it from generated XHTML. The client supports both generated-source shape (`div[data-flow-body-text] > p`) and rendered epubjs shape (`p[data-flow-body-text]`). Text-edit saves also stop synchronously hashing the full unpacked EPUB/source TXT after a one-node edit; they update the content version and a lightweight edit revision hash instead.
- Measured effect: after-only `tauri-release` custom client verification on generated TXT books passed. A visible small-book edit reported about 21ms native replacement time and about 32ms active-iframe patch time; a direct replacement in chapter 300 reported about 323ms native replacement time. No comparable pre-change baseline was available for this implementation batch.
- Decision: keep as a fast-fail/fast-return correctness change, but do not claim a measured percentage improvement without a comparable baseline.
- Constraint: TXT paragraph edit targets must include `paragraphIndex`; missing structural targets should fail instead of falling back to whole-document inference. Different-byte-length TXT source edits can still require tail rewriting of `source.txt`.

### Image sidebar persisted index cache

- Change: keep image classification in the WebView, but persist the section image index through Rust using the same serde JSON plus zstd cache pattern as search text cache. Cache hits populate `section.images` without loading section DOM.
- Measured effect: after-only `browser-smoke` with `tab-switch/sidebar-image`, `tab-click/sidebar-image`, and `tab-switch/sidebar-closed` passed with zero long tasks. No comparable pre-change or `tauri-release` baseline was available for this implementation batch.
- Decision: keep as a functional cache and regression-smoke pass, but do not claim a measured release-client performance win from this entry.
- Constraint: before making further performance claims or broadening image sidebar ownership, run a comparable `tauri-release` baseline/after set including the image sidebar and at least one closed-sidebar scenario.

### Conservative section document trimming

- Change: track section document access in `BookTab` and trim old loaded section documents only after a delayed high-watermark check. Current visible sections, rendered views, the active section, and in-flight section loads are protected.
- Measured effect: after-only `browser-smoke` with `tab-switch/sidebar-closed`, `tab-switch/sidebar-image`, `tab-click/sidebar-image`, `page-turn/sidebar-closed`, and `page-turn/sidebar-toc` passed with zero long tasks. No comparable pre-change or `tauri-release` baseline was available for this implementation batch.
- Decision: keep as a conservative memory-control mechanism and regression-smoke pass, but do not claim a measured release-client performance win from this entry.
- Constraint: keep trimming delayed and watermarked; do not introduce per-click, per-panel, or per-page-turn unload rules without comparable release-client measurements.

## Rejected Approaches

### Row CSS containment

- Attempt: add CSS containment to generic sidebar/list rows.
- Measured effect: TOC tab-switch first frame worsened about 12%, and settled time worsened about 15%.
- Decision: rejected. It slowed the heaviest path.

### Global virtual list overscan 2

- Attempt: reduce global virtual list overscan from 8 to 2.
- Measured effect: TOC tab switch improved about 20%, but closed-sidebar tab switch regressed about 5%.
- Decision: rejected in favor of overscan 4. Balanced reader fluidity matters more than one isolated TOC win.

### TOC-only overscan 2 or 3

- Attempt: keep global overscan at 4, but use lower overscan only for TOC.
- Measured effect: TOC-only overscan 2 regressed TOC tab switch by about 13% and TOC page turn by about 7% versus overscan 4. Later overscan 2/3 retests after hidden-scroll changes still traded one required path against another.
- Decision: rejected. Do not repeat without a new virtual-list architecture.

### Synchronous virtual-list scroll state

- Attempt: assign scrollTop and update viewport state synchronously for `scrollToItem({ behavior: 'auto' })`.
- Measured effect: TOC tab switch improved about 8%, but closed-sidebar, annotation, image, and TOC page-turn scenarios regressed about 17-38%.
- Decision: rejected. It moved work into required non-TOC paths.

### Per-tab or WeakMap flattened TOC row caches

- Attempt: cache flattened TOC rows per tab/version or by WeakMap.
- Measured effect: per-tab cache regressed TOC tab switch by about 38% and TOC page turn by about 56%. A later WeakMap retest also reintroduced rapid TOC tab-click long tasks.
- Decision: rejected. Cache bookkeeping is not worth it under the current TOC ownership model.

### Active-only inactive tab chrome

- Attempt: keep epubjs containers mounted but render header, footer, overlays, and other inactive tab chrome only for the active tab.
- Measured effect: real-client setup failed with active tab metadata from one book and body/header/footer from another.
- Decision: rejected immediately. It breaks the visibility-based multi-tab invariant and can reproduce cross-tab content mismatch.

### Memoized reader header/footer

- Attempt: wrap reader header/footer components in `React.memo`.
- Measured effect: closed-sidebar tab switch worsened about 17%, TOC tab switch worsened about 35%, and settled times worsened.
- Decision: rejected. Memoization added overhead or blocked the wrong render boundary.

### Pane container CSS containment

- Attempt: add CSS containment to reader pane containers.
- Measured effect: closed-sidebar tab switch worsened about 20%, TOC tab switch worsened about 26%, while only secondary panels improved.
- Decision: rejected. Core tab switching is higher priority than secondary-panel wins.

### Narrow LibraryPane snapshot variants

- Attempt: narrow `LibraryPane` reader snapshot reads in ways similar to the retained TOC narrowing.
- Measured effect: TOC tab switch sometimes improved, but page-turn first-frame was unstable or regressed.
- Decision: rejected. Do not retry unless the reader focus/group ownership model changes.

### Primitive subscribe for TOC state

- Attempt: subscribe to lower-level TOC primitives or add `currentNavItemVersion` to reduce snapshot work.
- Measured effect: primitive current item version improved one rapid page-turn metric by about 2%, but rapid TOC tab-click first frame worsened about 25% and long tasks returned.
- Decision: rejected. Adding frequently updated primitives to `BookTab` is not safe under the current model.

### Clear hidden TOC list rows

- Attempt: keep hidden TOC components mounted but feed empty rows to hidden virtual lists.
- Measured effect: tab-switch scenarios regressed broadly; TOC tab switch first frame worsened about 53% and long-task total worsened about 61%.
- Decision: rejected. Rebuilding hidden list DOM on return costs more than keeping it stable.

### Memoize SideBar boundary

- Attempt: memoize the sidebar boundary to reduce page-turn updates.
- Measured effect: helped already-fast page turns but hurt slower tab-switch paths.
- Decision: rejected. Do not optimize a fast path by regressing multi-tab switching.

### TOC auto-locate layout effect

- Attempt: move TOC auto-locate into a layout effect to run before paint.
- Measured effect: blocked interaction frame and worsened tab switching.
- Decision: rejected. Pre-paint work is wrong for this reader flow.

### Remove LibraryPane from TOC view

- Attempt: diagnostic removal of library pane from TOC view.
- Measured effect: did not support LibraryPane as the dominant bottleneck.
- Decision: diagnostic only. Do not turn it into a product change without fresh evidence.

### Debounced TOC auto-scroll

- Attempt: debounce TOC auto-scroll during rapid tab switching.
- Measured effect: TOC tab switch worsened about 10%, rapid TOC tab-click worsened about 21%, closed-sidebar rapid tab-click worsened about 27%, and long tasks increased sharply.
- Decision: rejected. The debounce delayed work until it overlapped later commits instead of removing it.

### Reader pagination subscription split

- Attempt: move page-width CSS variable sync and chapter-find pagination sync into smaller child components so `BookPane` no longer subscribes to pagination at the top level.
- Measured effect: rapid TOC tab-click first frame worsened about 40%, long tasks returned, and closed-sidebar page-turn first frame worsened about 30%.
- Decision: rejected. Extra subscriptions and sync paths hurt the primary multi-tab requirement.

### Drop pagination dependency from page-width observer

- Attempt: remove `paginationVersion` from page-width observer dependencies.
- Measured effect: one single-step TOC page-turn metric improved, but rapid TOC tab switching and rapid TOC page turns regressed.
- Decision: rejected. Do not trade rapid interactions for a single-step metric.

### Coalesced reader page-width sync scheduler

- Attempt: coalesce `--flow-reader-page-width` / `--flow-reader-spread-width` sync work in `BookPane` by replacing per-callback immediate update plus RAF plus timeout with RAF-only scheduling, and then with a conservative immediate update plus one pending RAF/timeout.
- Measured effect: `tauri-release` native-book comparison with page-turn, rapid-page-turn, tab-switch, and rapid-tab-click scenarios showed unacceptable rapid-path regressions. RAF-only regressed `rapid-tab-click/sidebar-closed` burst p95 by about 39% and settled p95 by about 37%. The conservative variant still regressed `rapid-tab-click/sidebar-closed` settled p95 by about 21%, while `rapid-tab-click/sidebar-toc` long-task total rose about 12%.
- Decision: rejected. The scheduler cleanup reduced some single-step or max-step frame metrics, but moved cost into required rapid tab-click paths.
- Constraint: do not coalesce this sync path without a new approach that preserves rapid tab-click settled p95 and TOC long-task totals. Compare closed-sidebar and TOC rapid tab-click together with page-turn scenarios.

### Remove TOC row aria-label

- Attempt: remove TOC row `aria-label` after diagnostics showed many attribute mutations.
- Measured effect: rapid TOC tab-click first frame worsened about 5%, long tasks returned, and rapid TOC page-turn first frame worsened about 3%.
- Decision: rejected. Mutation-count reductions are not acceptance evidence when client metrics and accessibility risk are worse.

## Current Baseline Shape To Protect

- Current retained release-client performance should have zero long tasks for the primary closed-sidebar and TOC rapid tab-switch and rapid page-turn paths.
- Closed/sidebar and TOC tab switching should be compared together; optimizing only the open TOC path is not enough.
- Page-turn checks must accompany tab-switch optimizations because many failed attempts moved work between these paths.
- Mutation diagnostics and React Doctor are advisory. The accept/reject decision comes from comparable client measurements.
