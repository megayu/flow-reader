# Flow Reader Performance History

Use this only after the measurement gate classifies the work as an optimization.
Search by affected subsystem, read the matching entries and relevant baseline
bullets, and avoid repeating a rejected approach unless ownership, DOM shape,
or measurement conditions changed. Load the whole file only for cross-cutting
work.

## Contents

- [Retained Approaches](#retained-approaches)
- [Rejected Approaches](#rejected-approaches)
- [Current Baseline Shape To Protect](#current-baseline-shape-to-protect)

Library-specific entries are grouped at the end of retained approaches and the
start of rejected approaches. Other entries cover reader interactions.

## Retained Approaches

### Construction-scoped note index lookups

- Change: reuse note-container classifications within one index build. Query named elements only after an ID miss, and build a first-name-wins map only for repeated fallbacks. Neither temporary structure is retained by the document's NoteIndex; popup lookups remain live.
- Measured effect: matched Windows `tauri-release` synthetic single-chapter EPUB opens used a 1280×800 client area at DPR 1.5, eight runs with three warmups excluded, and identical 16px typography. For 300 named notes, 1000 ID notes, and 1000 named notes, open-to-ready p50 changed -42.7%/-12.5%/-53.3%, and p95 changed -37.6%/-12.6%/-56.2%. Steady long-task totals changed 1194→581 ms, 5795→5029 ms, and 13219→5779 ms; task counts remained five per scenario. Post-GC heap-delta medians changed approximately -3.0%/+0.9%/+1.3%.
- Small-scale control: a separate matched 20-run pair, excluding three warmups, covered zero notes and four ID/named notes. Median open time changed +0.9%/+2.4%/+2.0%, and p95 changed +0.3%/-0.3%/+10.9%. The named-note tail increase was 6.8 ms (62.5→69.3 ms), with a 1.2 ms median increase, unchanged post-GC heap median, and no long tasks. First-RAF p95 increased 0.6 ms for named notes and decreased for the other controls.
- Decision: keep the explicit first-open UX tradeoff: dense named-note opens save about 1.4 seconds, while the small named-note control costs about 7 ms at the tail without retained-heap growth or new long tasks. Do not claim small-scale speedups or elimination of dense-open blocking.
- Constraint: results measure open-to-ready including layout, not isolated index time. First RAF is not a content-visible-frame guarantee. Heap readings are post-operation/post-GC JS heap deltas, not peak allocation or native process memory. Temporary space remains proportional to visited containers and named elements. No Linux/macOS release measurement was collected.

### Current-chapter find work reuse and cancellation

- Change: Cmd/Ctrl+F scans the current chapter in yielding batches, indexes CFI siblings once per query, resolves each match against one displayed view, and passes the resolved Range only to initial annotation attachment. The search effect shares one reset branch, and a previous-active ref tracks color updates without rebuilding every mark. Closing, replacing the query, changing chapters, or replacing the view cancels obsolete work; layout changes refresh page addresses.
- Measured effect: matched Windows `tauri-release` native-book runs used 120 chapters with 20 paragraphs per chapter, 80 hits in the searched chapter, a 1586×963 client area at 1.5 device scale, and direct `cmdf/query` and `cmdf/next-match` scenarios. The initial optimization comparison used eight runs with the first two excluded: query operation p50/p95 improved 41.4%/39.0%, first-frame p50/p95 improved 40.3%/37.3%, and settled p50/p95 improved 4.6%/6.7%. Next-match operation p50 improved 35.1% and first-frame p50 improved 32.8%; their p95 changed +2.0%/+2.4%, with settled p95 +0.6%. A separate comparison of the consolidated reset branch and transient Range attachment against that optimized implementation used two matched 16-run pairs under the same window/data conditions, excluding three warmup samples per run. Across the pooled 26 steady samples per side, query/next-match operation p95 changed -26.0%/-0.8%, first-frame p95 -23.2%/-5.1%, and settled p95 -3.9%/+1.3%. All comparisons had zero long tasks.
- Decision: keep. Actual-client inspection confirmed mark reuse while changing the active hit, zero search annotations after closing or changing chapters, latest-query results after rapid input, and aligned highlights after a width-changing sidebar action.
- Constraint: this is chapter-find evidence, not sidebar full-text-search evidence. Keep result/Range ownership scoped to the open query and invalidate layout-dependent page addresses. Initial highlight construction still scales with the number of hits. No matched heap measurement or Linux/macOS release-client evidence was collected.

### Stable iframe capture-listener options

- Change: share one immutable `{ capture: true }` options object across iframe shortcut and mouse-button subscriptions instead of allocating a new object during every reader render.
- Measured effect: matched `tauri-release` native-book runs used eight single runs and four burst runs for closed-sidebar page turns and tab switches. Single page-turn operation p50 improved about 16% and first-frame p50 improved about 15%; tab-switch first-frame p50 improved about 13%. Rapid-path totals varied across repeats, while the per-step worst first frame stayed within about 1% and every run retained zero long tasks.
- Decision: keep. Stable option identity deterministically prevents effect cleanup and listener reattachment after unrelated renders, does not change event handling, and showed no stable per-event or long-task regression.
- Constraint: keep the shared object immutable. Dynamic listener options must remain explicit effect dependencies rather than being hidden behind this constant.

### Single-pass cached-text search results

- Change: advance folded-text character offsets once per section, reuse one character buffer for every excerpt in that section, serialize section navigation context once per result group, and let the search virtual list index groups without cloning every expanded hit. Selection-menu searches bypass the input debounce while typed searches keep the existing debounce.
- Measured effect: matched `tauri-release` native synthetic-book runs used 120 chapters, 20 paragraphs per chapter, 9,600 broad-query hits, a 1280×800 client area at 1.5 device scale, six runs with the first two excluded from steady summaries, and the same `search-query/sidebar-search`, `tab-switch/sidebar-search`, and `tab-switch/sidebar-closed` filters. Steady broad-query operation p50 improved 48.6% and p95 improved 50.8%; settled p50 improved 28.8% and p95 improved 33.3%. Long-task total fell 32.8% and max duration fell 27.4%. A separate matched TOC run stayed within about 5% on first-frame p50/p95 and settled p50/p95, with zero long tasks. A 12-run search-sidebar repeat kept first-frame p50 within 1% and settled p50 improved within 1%; its steady operation and first-frame p95 increased about 11% and 18% respectively, while settled p95 stayed within 8% and no long tasks appeared.
- Decision: keep. The release-client improvement comes from less repeated search and result-materialization work, while all results and exact counts remain available and shared sidebar paths retain their no-long-task baseline.
- Constraint: keep typed-input debounce behavior independent from explicit selection-menu search, preserve stale-result rejection, and do not restore per-hit section metadata or eager full-tree row cloning without remeasuring broad queries and sidebar switching.

### Full-text excerpt boundaries, occurrence lookup, and cancellation

- Change: advance two paragraph-boundary cursors in hit order, scanning and trimming each visited paragraph at most once per cursor without storing a paragraph array; resolve only the clicked occurrence's CFI instead of generating every chapter match. Each replaceable query owns a native cancellation token acknowledged over IPC before cancellation is sent, with automatic release on completion. Clearing/replacing input or closing the book aborts the pending query while preserving stale-result rejection.
- Measured effect: two matched Windows `tauri-release` pairs used 120 chapters, 20 paragraphs per chapter, 9,600 broad-query hits, a 1586×963 client area at 1.5 device scale, and 12 runs per scenario with three warmups excluded per run. Across 18 steady samples per side, full-text query operation p50/p95 changed -1.2%/-3.0%; repeated result navigation changed -5.2%/-0.6%; replacing three queries changed -19.0%/-15.3%. Their first-frame p95 changed -4.3%/-1.0%/-17.7%, and settled p95 changed -1.7%/+2.2%/-29.1%. Result navigation kept zero long tasks. Replacement long-task count stayed 18, total changed 1385→1375 ms, and maximum changed 93→98 ms. A subsequent comparison against that implementation replaced its paragraph array with cursors under the same client/data conditions, using 16 runs with three warmups excluded. Query/result-navigation operation p95 changed -41.3%/-24.7%, first-frame p95 -41.0%/-25.0%, and settled p95 -0.8%/-5.4%; result navigation still had zero long tasks. Query replacement received a second matched 16-run pair after an initial settled p95 increase of 10.9%; the repeat changed -4.1%. Across its 26 steady samples per side, operation/first-frame/settled p95 changed -10.9%/-11.3%/+5.5%; long-task count stayed 26, total changed 2092→1953 ms, and maximum changed 99→92 ms.
- Decision: keep. Native cancellation returned no partial results while the following query retained all 9,600 hits, and an actual sidebar result click reached its target without errors. Cursor simplification preserved excerpt output and linear boundary scanning while removing the paragraph array; no stable tail or long-task regression appeared in the matched comparison and targeted repeat.
- Constraint: paragraph cursors add O(1) boundary state alongside the existing O(section text length) character buffer; there is no matched heap measurement. Cancellation is cooperative at section/hit boundaries and does not interrupt shared cold index construction or an individual string operation. Result navigation still scans up to the requested occurrence synchronously. These are full-text-search measurements, not Cmd/Ctrl+F evidence; Linux/macOS native measurements remain unavailable.

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

### RAF-throttled virtual list scroll state

- Change: schedule virtual-list viewport updates through `requestAnimationFrame` instead of updating synchronously inside the scroll event.
- Measured effect: versus the immediate retained-code measurement, TOC tab-switch first frame improved 6.9%, settled time improved 4.0%, and long-task total improved 20.2%; image tab-switch first frame improved 10.6%. Closed-sidebar page-turn first frame regressed 34.3%, but that path does not use virtual-list scroll events, had no long tasks, and its settled time improved 6.1%.
- Decision: keep with monitoring.
- Constraint: do not assume RAF is always faster. Measure closed-sidebar, TOC, and page-turn scenarios together because a scroll-state change can move work between paths.

### Lightweight TOC rows

- Change: use a TOC-specific lightweight row instead of the generic row shell where the generic features are not needed.
- Measured effect: steady TOC tab-switch operation improved 51.7%, first frame improved 50.6%, settled time improved 21.1%, and long-task total changed from 753ms to 0ms. Required closed-sidebar and page-turn scenarios stayed within the accepted tradeoff.
- Decision: keep.
- Constraint: preserve the established mouse behavior and product shortcuts. Do not add or remove interaction semantics for a performance-only goal without separate product evidence.

### TOC viewport slot reuse

- Change: key visible TOC virtual-list rows by viewport slot instead of nav-item identity.
- Measured effect: TOC child-list churn dropped from about 160 added/removed nodes to about 1/1. TOC tab-switch first frame improved 7.9% and long-task total changed from 163ms to 0ms; rapid TOC tab-click long-task total improved 10.2%, and rapid closed-sidebar tab-click long-task total improved 75.0%. Real TOC tab-click first frame regressed 3.3%, while its long-task total improved 51.0%.
- Decision: keep.
- Constraint: this is valid because the row represents a recycled viewport slot, not persisted user data identity. Do not generalize it to library or book rows.

### Inactive sidebar view gates

- Change: keep each sidebar view shell mounted, but do not render inactive heavy subscribed subtrees for TOC, search, annotations, images, and typography.
- Measured effect: final retained comparison made rapid tab-switch long-task totals zero with the sidebar closed and TOC open. Tab-switch first-frame averages improved about 21-65% across sidebar panels. Page-turn long tasks remained zero.
- Decision: keep.
- Constraint: keep the outer `PaneView` ownership and visible sidebar model. Do not replace this with a broad "render only active view" change unless ownership is redesigned and remeasured.

### Library row virtualization with memoized book cards

- Change: replace the full library card grid with a row-aligned, overscanned window and memoize stable overlapping `BookCard` instances; retain full data semantics for filtering, sorting, selection, and result counts.
- Measured effect: matched release-client none runs across 25/50/100/200/400/800/1200 books showed the crossover between 50 and 75 books. At 800 books, mount p95 improved about 90%, full-scroll p95 about 78%, filter-clear p95 about 97%, and mounted cards fell from 800 to about 30-35. At 1200 books, mount p95 improved about 94%, full-scroll p95 about 86%, and full-scroll private bytes fell from about 1,802 MiB to 714 MiB. Matched 25/50/100 SVG, WebP, and mixed runs confirmed that the large gains were not a no-cover special case.
- Decision: keep. Use a fixed total-library threshold in the product so small libraries keep the full grid while large libraries use the virtual window. WebView image-resource residency and cover-return flashing remain separate follow-up measurements; DOM virtualization alone does not prove decoded cover memory is bounded.
- Constraint: do not choose the threshold from current filtered-result count, and do not treat the retained window as authorization to restore old scroll anchors or add per-filter view caches.

### Shared library-grid width measurement

- Change: use the grid-window hook's width measurement for both recent-book capacity and virtualization, removing the page-level observer and unused row metadata.
- Measured effect: matched `tauri-release` no-cover mount runs used 25 and 800 books, three pilots, and five runs with the first excluded. At 25 books, operation p50 improved 1.9%, p95 regressed 5.4%, settled p95 regressed 2.4%, and long-task total improved 1.1%. At 800 books, operation p50 improved 3.7%, p95 improved 5.3%, settled p95 improved 2.4%, and long-task total improved 9.8%. Mounted and visible card counts were unchanged in both datasets.
- Decision: keep. The small-library variance stays below the 10% review threshold, while one measurement owner removes duplicate resize work and improves the virtualized case.
- Constraint: keep width measurement active below the virtualization threshold because recent-book capacity still depends on the grid column count; scroll observation remains virtualization-only.

### Decode-gated, bounded library cover resources

- Change: retain decoded cover resources by `bookId + revisioned cover URL`, keep presentation and stable-filter return leases separate, cap decode concurrency at eight, and evict unleased resources through a byte-estimated LRU. Restrict the resource cache to libraries at or above the virtualization threshold; small libraries keep the original image path. Batch stable-filter lease changes so one result transition performs one budget pass.
- Measured effect: a matched `tauri-release` 75-book mixed-cover return comparison used three pilots and five runs with the first run excluded. Return phases improved from 4 samples and 53 RAF frames containing pending covers to zero, maximum pending duration improved from 133.3 ms to zero, operation p95 improved 15.8%, long-task total improved 11.6%, and process-private p50 improved 5.0%. Final matched 25-book runs kept mount and filter-clear p95 within 1% of the original full-grid baseline. At 800 mixed books, the final stack kept about 35 cards mounted while mount p95 improved about 92%, full-scroll p95 about 76%, and filter-clear p95 about 98% versus the original grid; the retained cover budget did not erase the virtualization memory benefit.
- Decision: keep. Resource retention removes the observable return blank frame that decode gating alone could not prevent, while byte and entry limits keep application-owned image references bounded.
- Constraint: keep the cache identity tied to the cover revision, not only the book id. Search must not create query snapshots, active leases must remain a bounded viewport/stable-filter set, and WebView-owned decoded/GPU memory is not covered by the application byte estimate.

### Suspended library-cover grace period

- Change: on leaving the library, immediately discard non-visible, queued, and loading cover entries; retain only the ready visible window for a bounded grace period, then dispose the remaining image references and queue. Returning during the grace period resumes the same cache rather than constructing another manager.
- Measured effect: at the evaluated grace setting, matched `tauri-release` 800-book mixed-cover switch runs used three pilots plus 30 quick runs with the first three excluded, and a separate 11-run post-timeout set with the first run excluded. Versus indefinite retention, quick-return p50 was unchanged and p95 regressed 5.8%, with zero pending covers in all 27 steady returns. The post-timeout runs confirmed that the grace path had disposed its strong references; versus immediate disposal, process-private p50 improved about 8.0%, and repeated cycles did not grow monotonically.
- Decision: keep. It preserves the common quick-return experience while guaranteeing that a longer reader stay releases application ownership.
- Constraint: entering the reader must not start a second cache or preserve non-visible LRU entries. Use one product-owned grace deadline for cover retention and the single transient library return position; elapsed returns must release application-owned image resources.

### Bounded stable-filter cover range on quick return

- Change: size the stable-filter cover lease from the top virtual window and combine it with the active window, instead of treating a restored middle window's absolute end index as a cover count.
- Measured effect: matched `tauri-release` 800-book mixed-cover quick returns used three pilots and five runs with the first excluded. At the middle scroll position, DOM-node p50 fell 67.3%, document p50 47.6%, event-listener p50 39.0%, heap p50 22.2%, and working-set p50 19.7%; private/renderer-private p50 changed +3.1%/+6.8%. First-frame p50 changed +5.5% while p95 improved 8.3%; settled p50/p95 improved 1.6%/4.9%. At the top, first-frame p50 changed +2.6% and p95 -2.7%, with process memory effectively unchanged.
- Decision: keep. It removes an absolute-index retention bug without changing the common top return path, and bounds middle-position ownership to the top and active virtual windows.
- Constraint: measure restored non-top state at a middle position, not the bottom where a partial final row changes the mounted-card count. This is a large-library scenario; do not add a small-library matrix for it.

### Narrow PageActionBar reader subscription

- Change: derive whether a focused reader tab exists from `selectedIndex` and `tabs.length` instead of reading the full `focusedBookTab` object in `PageActionBar`. This keeps the global action bar subscribed to tab availability while excluding page-location and other nested current-tab updates.
- Measured effect: the baseline and after builds came from the same worktree, with only the `PageActionBar` subscription changed between them. Matched React Doctor profile-build samples used three independent recordings per scenario. A keyboard page turn reduced `PageActionBar` from seven renders and 8.5 ms total render duration to zero, while a real tab click remained at two renders. Matched `tauri-release` native-book runs used eight single runs with the first three excluded and four rapid bursts across closed-sidebar and TOC page turns, tab switches, and tab clicks. Closed-sidebar rapid page turns improved burst p50/p95 by 14.0%/9.7% and settled p50/p95 by 8.0%/5.2%; TOC rapid page turns improved burst p50/p95 by 17.9%/17.3% and settled p50/p95 by 14.9%/9.3%. All ten scenarios passed with zero long tasks, while the tab-switch and tab-click controls showed no consistent regression.
- Decision: keep. It removes a semantically unrelated render subtree from page turns and improves both rapid page-turn configurations without moving measurable cost into the tab-switch controls.
- Constraint: `PageActionBar` may depend only on reader-tab availability through this boundary. If an action later needs focused-tab metadata, give that action a narrower subscription and repeat both React render counts and the full page-turn/tab-switch release matrix.

### Imperative selection-menu measurement and placement

- Change: measure the mounted selection menu in a layout effect, write its position and visibility directly to that overlay element, and let `ResizeObserver` repeat the same DOM layout update when its contents resize. Remove the measured width and height from React state so opening the menu does not render the entire action and tooltip subtree a second time.
- Measured effect: matched React Doctor profile-build samples used three independent recordings. `TextSelectionMenuRenderer` fell from two renders and 6.9 ms median total render-event duration to one render and 5.4 ms; the duplicated action-button and tooltip subtree renders disappeared with it. Matched `tauri-release` native-book runs used 12 menu openings with the first three excluded and asserted that every visible menu stayed within the reader. Time to visible improved from 17.1/23.7 ms to 16.0/20.1 ms at p50/p95, and first-frame time improved from 18.2/28.8 ms to 17.1/23.1 ms. Settled p50 changed from 202.0 to 201.3 ms and p95 from 217.0 to 218.4 ms; both builds recorded zero long tasks.
- Decision: keep. The change removes the known measurement-driven React commit, improves the user-visible open path in the real client, and preserves horizontal, vertical, scrolling, focus, and overlay ownership behavior.
- Constraint: keep selection-menu measurement synchronous with the layout commit so a newly mounted or view-switched menu remains hidden until its final position is available. If overlay geometry or iframe ownership changes, repeat the horizontal and vertical geometry checks plus the real-client time-to-visible measurement.

### Local library-title search input state

- Change: keep the raw title-search query in a small toolbar component, publish it to the library only after the existing 150 ms debounce, and mirror the raw value into the return-state ref so reader/library switches still restore unfinished input. Clearing first commits the local empty value, then lets the component effect clear the library filter.
- Measured effect: matched React Doctor profile-build samples used three independent recordings. A full-title input reduced `Library`, `DropZone`, and `DropZoneInner` from two renders to one; `Library` median total render-event duration fell from 4.7 to 3.2 ms while the search control retained its two local renders. Matched `tauri-release` no-cover datasets used 25 and 800 books, three pilots, and eight formal runs with the first three excluded. At 25 books, search-apply operation p50/p95 improved 1.4%/0.7%; search-clear operation p50 changed +4.7% and p95 +2.0%, with first-frame p50/p95 +3.9%/+8.5%. At 800 books, search-apply operation p50 improved 1.6% while p95 changed +2.5%; search-clear operation p50 improved 6.9% while p95 changed +3.2%, with first-frame p50/p95 improving 2.1% and changing +2.1%. Both datasets kept mounted-card counts unchanged and recorded zero long tasks.
- Decision: keep. Each typed character now updates only the search control before the debounced result commit, while the matched single-input and clear paths remain within the review threshold in both full-grid and virtualized libraries.
- Constraint: keep the raw query synchronized with the library return-state ref without scheduling a parent render. Preserve the delayed empty-query handoff unless a replacement passes the 800-book search-clear control as well as the search-apply path.

### Reader tab clicks with many open books

- Change: stabilize the import-result notification callback, subscribe reader hooks only to the locale, typography, color-scheme, or settings setter values they use, and pass stable tab data into memoized pane containers. Add a deterministic 20-tab render scenario so tab-switch fan-out can be measured at scale.
- Measured effect: matched React Doctor profile-build samples used three independent recordings for both 3-tab and 20-tab clicks. At 3 tabs, total render events fell from 552 to 256; `ReaderTabItem` fell from seven renders to three, `AppTooltip` from 22 to eight, `PaneContainer` from six to two, and `Reader` and `Layout` from one each to zero. At 20 tabs, total render events fell from 1,789 to 231 (87.1%); `ReaderTabItem` fell from 41 renders to three, `AppTooltip` from 56 to eight, `PaneContainer` from 60 to two, and `Reader` and `Layout` again fell to zero. A matched Windows Tauri release control with three tabs improved single-click operation p50/p95 by 19.6%/21.1%, single-click first-frame p50/p95 by 20.4%/14.0%, rapid 18-step burst p50/p95 by 17.9%/15.5%, and maximum-step first-frame p95 by 41.0%. Single-click settled p95 changed +1.8%, rapid settled p50/p95 improved 10.0%/12.5%, and both builds recorded zero long tasks.
- Decision: keep. Tab clicks now update the selected tab boundary instead of rebuilding inactive reader panes and unrelated settings consumers, and the improvement grows with tab count without moving measurable cost into the settled phase.
- Constraint: preserve the narrow settings selectors. The 20-tab result establishes React render scaling in the browser diagnostic build; real-client timing remains a separate matched Tauri release control.

## Rejected Approaches

### Decode gating without retained library cover resources

- Attempt: display the real library image only after `load` plus `decode()`, but allow the resource to disappear when its virtualized card unmounts.
- Measured effect: in the most sensitive 75-book mixed-cover release run, filter reapply still produced 19 pending RAF frames across two steady samples with a longest pending interval of 78.8 ms; final filter clear produced 31 pending RAF frames across two samples with a longest interval of 145.3 ms.
- Decision: reject as a complete anti-flash solution. It prevents an undecoded image from painting, but replaces it with the placeholder and therefore does not preserve a previously shown cover across unmount.
- Retry condition: none under the current virtual-card ownership model; decode gating remains only as the presentation half of the retained resource design.

### Synchronous parent clear for local library search

- Attempt: when the local search input becomes empty, clear the parent library filter in the same event instead of from the search component effect.
- Measured effect: matched `tauri-release` 800-book no-cover runs used three pilots and eight formal runs with the first three excluded. Search-clear operation p50 regressed 11.9%, p95 regressed 8.2%, and first-frame p50/p95 regressed 8.2%/3.4%; search-apply did not gain enough to offset the clear regression.
- Decision: reject. Combining the local input and virtualized-grid clear work in one commit made the primary clear operation slower.
- Retry condition: keep the local and parent commits separate unless a different ownership boundary improves the repeated-input path and passes the 800-book clear comparison.

### Immediate disposal or indefinite retention of suspended library covers

- Attempt: either clear every application-held cover as soon as reading mode opens, or retain the suspended cover set without a timeout.
- Measured effect: at the evaluated grace setting, matched `tauri-release` 800-book mixed-cover quick-switch runs showed immediate disposal did not lower cycling memory and had about 3.1% higher quick-return process-private p50 than the bounded grace path. Indefinite retention matched grace quick-return p50 and improved p95 by 5.8%, but by construction never released the application's strong image references during a long reader stay. In post-timeout runs, the grace path improved process-private p50 about 8.0% versus immediate disposal while still reaching a stable memory platform.
- Decision: reject both extremes. Immediate disposal adds avoidable reallocation without demonstrating a memory win in quick cycling; indefinite retention violates the reader-mode release requirement.
- Retry condition: reconsider only if WebView lifecycle ownership changes, then remeasure both quick returns and long reader stays rather than using a single RSS snapshot.

### Replace iframe listener refs with Effect Events

- Change: replace the listener ref plus synchronization effect in `useFrameEvent` with `useEffectEvent`.
- Measured effect: the first matched `tauri-release` run improved isolated single operations but regressed rapid page-turn burst p95 about 36% and rapid tab-click burst p95 about 15%, with rapid-path settled p95 also higher. Removing the Effect Event change recovered the per-step worst first-frame measurements.
- Decision: reject. Reducing hook count did not simplify the hot event execution path and produced unacceptable burst evidence.
- Constraint: do not remove the listener ref solely to reduce hook count. Any replacement must preserve stable subscriptions and demonstrate matched rapid page-turn and rapid tab-switch results.

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
- Rejection evidence: real-client setup produced active-tab metadata from one book with body/header/footer from another.
- Decision: rejected because it breaks the visibility-based multi-tab invariant and can reproduce cross-tab content mismatch.
- Retry condition: reconsider only after reader body and chrome ownership are redesigned so one committed tab snapshot controls all visible surfaces.

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
- Rejection evidence: TOC tab switching sometimes improved, but page-turn first frame was unstable or regressed.
- Decision: rejected under the current reader focus and group ownership model.
- Retry condition: retry only if that ownership model changes, then measure tab switching and page turns together.

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
- Rejection evidence: it helped already-fast page turns but hurt slower tab-switch paths.
- Decision: rejected because optimizing page turns cannot move cost into multi-tab switching.
- Retry condition: any new boundary must measure closed-sidebar and TOC tab switching alongside page turns.

### TOC auto-locate layout effect

- Attempt: move TOC auto-locate into a layout effect to run before paint.
- Rejection evidence: it blocked the interaction frame and worsened tab switching.
- Decision: rejected because TOC auto-location is not required pre-paint work in this reader flow.
- Retry condition: reconsider only if auto-location becomes part of the visible commit invariant and the interaction-frame cost is measured.

### Debounced TOC auto-scroll

- Attempt: debounce TOC auto-scroll during rapid tab switching.
- Measured effect: TOC tab switch worsened about 10%, rapid TOC tab-click worsened about 21%, closed-sidebar rapid tab-click worsened about 27%, and long tasks increased sharply.
- Decision: rejected. The debounce delayed work until it overlapped later commits instead of removing it.

### Reader pagination subscription split

- Attempt: move page-width CSS variable sync and chapter-find pagination sync into smaller child components so `BookPane` no longer subscribes to pagination at the top level.
- Measured effect: rapid TOC tab-click first frame worsened about 40%, long tasks returned, and closed-sidebar page-turn first frame worsened about 30%.
- Decision: rejected. Extra subscriptions and sync paths hurt the primary multi-tab requirement.

### Defer view-version notification until navigation settles

- Attempt: keep iframe window ownership current during a page turn, but defer all `viewVersion` and overlay notifications raised by intermediate `rendered` and `removed` events until `turning` becomes false.
- Measured effect: matched React Doctor profile-build samples reduced `BookPane`, reader header/footer, annotations, and edge-navigation renders from ten to four per keyboard page turn, with no render-count change during tab clicks. Matched `tauri-release` native-book runs used eight single runs with the first three excluded and four rapid bursts. With the TOC open, page-turn operation p50/p95 regressed 90.4%/84.2% and first-frame p50/p95 regressed 101.3%/64.6%. Rapid page-turn burst p95 regressed 6.8% closed and 10.7% with TOC; rapid closed-sidebar tab-click max-step first-frame p95 regressed 39.0%. The deterministic release verifier passed, so the failure was displaced interaction cost rather than snapshot correctness.
- Decision: reject. The lower render count came from concentrating React work at the visible navigation commit, making the actual interaction slower.
- Retry condition: do not defer the notification batch to the end of navigation. Reconsider only with a consumer design that removes intermediate work without moving it onto the body/header/footer commit boundary, and measure both TOC page turns and rapid tab clicks.

### Drop pagination dependency from page-width observer

- Attempt: remove `paginationVersion` from page-width observer dependencies.
- Rejection evidence: one single-step TOC page-turn metric improved, but rapid TOC tab switching and rapid TOC page turns regressed.
- Decision: rejected because a single-step improvement does not justify regressions in rapid interactions.
- Retry condition: a replacement invalidation source must preserve rapid tab-switch and rapid page-turn behavior and be measured in both paths.

### Coalesced reader page-width sync scheduler

- Attempt: coalesce `--flow-reader-page-width` / `--flow-reader-spread-width` sync work in `BookPane` by replacing per-callback immediate update plus RAF plus timeout with RAF-only scheduling, and then with a conservative immediate update plus one pending RAF/timeout.
- Measured effect: `tauri-release` native-book comparison with page-turn, rapid-page-turn, tab-switch, and rapid-tab-click scenarios showed unacceptable rapid-path regressions. RAF-only regressed `rapid-tab-click/sidebar-closed` burst p95 by about 39% and settled p95 by about 37%. The conservative variant still regressed `rapid-tab-click/sidebar-closed` settled p95 by about 21%, while `rapid-tab-click/sidebar-toc` long-task total rose about 12%.
- Decision: rejected. The scheduler cleanup reduced some single-step or max-step frame metrics, but moved cost into required rapid tab-click paths.
- Constraint: do not coalesce this sync path without a new approach that preserves rapid tab-click settled p95 and TOC long-task totals. Compare closed-sidebar and TOC rapid tab-click together with page-turn scenarios.

### Remove TOC row aria-label

- Attempt: remove TOC row `aria-label` after diagnostics showed many attribute mutations.
- Measured effect: rapid TOC tab-click first frame worsened about 5%, long tasks returned, and rapid TOC page-turn first frame worsened about 3%.
- Decision: rejected. Mutation-count reductions are not acceptance evidence when client metrics and accessibility risk are worse.

### Pass ImageView tab id through visible blocks

- Attempt: let `ImagePane` pass its existing focused-tab id through `MeasuredImageBlock` to each visible image `Block`, removing one `useReaderSnapshot` subscription per visible block.
- Measured effect: matched `tauri-release` native-book runs used eight runs with the first three excluded and covered closed, search, and image sidebar tab switches and tab clicks plus search input. An adjacent reverse A/B improved image tab-click operation p50 about 25% and p95 about 14%, but image tab-switch first-frame p50 worsened about 37%, first-frame p95 about 87%, and settled p95 about 22%. No long tasks appeared in the tab scenarios.
- Decision: rejected. Removing per-block subscriptions did not produce a stable improvement across the required image tab-click and tab-switch paths.
- Retry condition: reconsider only if image rows become substantially heavier or their subscription ownership changes, then measure image tab switching and tab clicking together with a closed-sidebar control.

### Reuse SearchPane keyword snapshot in the IME buffer hook

- Attempt: pass the `focusedBookTab.keyword` already read by `SearchPane` into `useIntermediateKeyword` instead of subscribing to the same reader snapshot again inside the hook.
- Measured effect: matched `tauri-release` native-book runs used the same eight-run, first-three-excluded matrix as the adjacent baseline. Search-sidebar tab-switch first-frame p50 improved about 9%, but first-frame p95 worsened about 17%. Search input operation p50 worsened about 20%, and steady long-task total increased about 14%.
- Decision: rejected. The simpler subscription graph did not provide a stable runtime benefit and regressed the actual search-input path.
- Retry condition: keep the separate IME buffer subscription unless search state ownership or input synchronization changes; any retry must include both search-sidebar switching and a real search query.

## Current Baseline Shape To Protect

- Current retained release-client performance should have zero long tasks for the primary closed-sidebar and TOC rapid tab-switch and rapid page-turn paths.
- Closed/sidebar and TOC tab switching should be compared together; optimizing only the open TOC path is not enough.
- Page-turn checks must accompany tab-switch optimizations because many failed attempts moved work between these paths.
- Library virtualization must retain full filtering, sorting, selection, and result-count semantics while keeping mounted cards bounded above the fixed total-library threshold.
- Library cover retention must remain revision-aware and bounded; quick reader returns may use the shared grace period, but longer reader stays must release application-owned image resources.
- Mutation diagnostics and React Doctor are advisory. The accept/reject decision comes from comparable client measurements.
