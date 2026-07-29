# Reader Performance History

Read this before proposing or testing a Flow Reader performance optimization. Search for the touched area and avoid repeating rejected approaches unless the underlying ownership, DOM shape, or measurement condition has changed.

## Retained Approaches

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

## Rejected Approaches

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
- Mutation diagnostics and React Doctor are advisory. The accept/reject decision comes from comparable client measurements.
