---
name: reader-performance-measurement
description: >-
  Use when working in the Flow Reader repository on changes that may affect
  reader runtime performance: tab switching, page turns, zoom, spread or
  single-page layout cost, iframe rendering, epubjs manager/view/rendition code,
  reader pane CSS, annotation or definition overlays, sidebar panels tied to the
  active reader, generated book resources consumed by pagination, or state-flow
  changes that can affect first frame, settled time, long tasks, or reader
  counters.
---

# Reader Performance Measurement

Use this skill before implementing or accepting any Flow Reader change that can affect user-visible reader performance. The goal is to make the accept/reject decision from comparable client measurements, not intuition.

## Required Reference First

Before planning, implementing, or accepting performance work, read [Performance History](references/performance-history.md). Search it for the touched subsystem and treat retained/rejected history as the starting evidence unless the current code path or measurement condition has materially changed.

If retrying a rejected idea, first write down what changed since the recorded rejection and measure the same affected scenarios again.

Treat [Performance History](references/performance-history.md) as a record of performance optimization experiments, not a changelog or a general performance-regression ledger. Add an entry only when the change's primary purpose is to improve runtime performance and matched baseline and after runs at the same evidence level produce concrete timing or long-task deltas that justify a retained or rejected decision. A feature or correctness change may require the same baseline/after workflow for no-regression acceptance, but do not add it to the history merely because performance was measured or did not regress. Do not add after-only results, smoke passes, correctness outcomes, diagnostic observations, or unquantified claims. `perf-results/` is gitignored and ephemeral; never cite its paths as durable evidence in the history. Copy the necessary run conditions and numeric comparison into the entry itself.

Before editing the history, verify that the proposed entry names the compared scenario, metric, baseline/after relationship or numeric delta, evidence level, and decision. If any of these are missing, do not add the entry.

Place an accepted performance optimization under `Retained Approaches` only when the measured comparison justifies keeping it. Place an attempted performance optimization under `Rejected Approaches` only when the comparison justifies removing or not adopting it; state what measurement or code-path change would make a future retry meaningful. Let the final decision determine the section: do not record the same attempt in both sections. If later evidence reverses a recorded decision, update and move the existing entry instead of leaving contradictory entries.

## Decide Whether This Skill Applies

Run the performance workflow for changes touching:

- Tab switching, tab click, keyboard tab selection, or rapid tab interactions.
- Page turns, rapid page turns, `next`, `prev`, display, relocation, pagination, or spread restoration.
- Zoom, typography changes, single-page/spread mode, reader width, iframe sizing, or reader pane CSS that can alter render cost.
- `packages/epubjs` manager, view, rendition, layout, event, resize, or location code.
- Active reader overlays, including annotations and definitions, if they add hit testing, redraw work, DOM nodes, observers, or pointer/mouse handling over the reading body.
- Sidebar panels that observe or render active reader state: TOC, search, annotations, images, typography, or any focused-tab subscription.
- Generated TXT/EPUB package, XHTML, CSS, image dimensions, metadata, or resource structure when the reader opens it and the output can change DOM size, pagination, resource loading, or iframe content.
- React state-flow or Valtio subscription changes that may affect first frame, settled time, or long tasks in reader workflows.

Do not run the reader performance workflow for changes that cannot affect reader runtime cost:

- Pure Rust storage plumbing, path handling, command permissions, or error text.
- Cover resource import or generation when the cover is only shown in library/metadata surfaces and is not part of opening, paginating, or rendering the reader body.
- Translations, labels, and i18n-only text changes.
- Documentation-only changes.
- Script/test-only changes unless the measurement script itself is being changed.
- Native code outside reader data/resource paths.

If a Rust change affects generated cover resources, run reader performance only when the cover is loaded by the reader workflow being measured or changes generated book resources consumed by pagination. If the change only affects library cover display, use visual/layout verification for that UI instead.

When in doubt, inspect the changed data path. If the changed output reaches reader iframe DOM, pagination input, active sidebar reader subscriptions, or reader resource loading, measure it. If it stays outside those paths, explain why performance measurement is not useful.

## Evidence Levels

Use the right evidence level for the decision being made:

- `browser-smoke`: fast cross-platform script validation. Useful for checking that the script and deterministic fixture still work. Not enough to accept a performance optimization.
- `tauri-dev`: real WebView and desktop shell with dev build behavior. Useful for debugging client automation and reproducing a client-only issue. Not enough for final performance acceptance.
- `tauri-release`: compiled Tauri executable with an isolated data directory and CDP enabled. This is the authoritative evidence for accepting, rejecting, or comparing performance-sensitive changes.

Do not compare results across evidence levels. A `browser-smoke` baseline cannot be compared to a `tauri-release` after-run, and a dev-client run cannot be used as the final replacement for a release-client run.

## Required Method

1. Read [Performance History](references/performance-history.md) and search for similar retained or rejected attempts.
2. Classify the change using the trigger rules above.
3. If measurement is not required, record the reason in the final response.
4. If measurement is required, collect a baseline before the code change whenever possible.
5. Make the change.
6. Collect an after-run with the same evidence level, executable, window size, run count, scenario filter, book source, and data setup.
7. Compare baseline and after with the bundled compare script.
8. Accept the change only if the measured tradeoff is justified.
9. Update performance history only when the change was a performance optimization experiment; do not record feature or correctness work whose measurements served only as a no-regression gate.

If the worktree was already changed before you started and no reliable baseline exists, say that clearly. Do not invent a baseline or add a performance-history entry. Run the current measurement only when it is useful for the current investigation.

## Bundled Scripts

Run these scripts from the repository root. They use `process.cwd()` as the app root.

- Measure: `.agents/skills/reader-performance-measurement/scripts/measure-reader-performance-client.mjs`
- Compare: `.agents/skills/reader-performance-measurement/scripts/compare-reader-performance.mjs`

Use `node --check` on these scripts after editing them.

## Environment Contract

Configure the scripts with environment variables. Set them using the current shell, CI runner, or a small Node launcher; do not assume PowerShell, Bash, or any one platform.

Core variables:

- `FLOW_READER_PERF_MODE`: `browser`, `tauri`, or `auto`.
- `FLOW_READER_PERF_BOOK_SOURCE`: `mock` or `native`. Use the same value for baseline and after.
- `FLOW_READER_PERF_OUT_DIR`: output directory under `perf-results/`.
- `FLOW_READER_PERF_SCENARIOS`: optional comma-separated scenario filter.
- `FLOW_READER_PERF_RUNS`: run count. Keep baseline and after identical.
- `FLOW_READER_CDP_URL`: CDP endpoint for a real Tauri/WebView client, default `http://127.0.0.1:9351`.
- `FLOW_READER_APP_URL`: browser-smoke app URL, default `http://127.0.0.1:7127`.
- `FLOW_READER_DATA_DIR`: isolated app data directory. Set this before launching the Tauri client.

The current real-client automation connects through CDP. Use it on platforms where the built app exposes a CDP-compatible debug endpoint. If the current platform cannot expose CDP for its Tauri WebView, do not present browser-smoke results as final performance acceptance; record the limitation and perform the closest available client/manual check separately.

## Release Client Procedure

Use release-client measurements for acceptance:

```text
pnpm build
pnpm tauri:build
```

Launch the compiled executable for the current platform with isolated storage and a CDP-compatible debug endpoint. Use the actual executable path for that platform. Keep the same executable, data directory, CDP URL, window size, run count, scenario filter, and book source for baseline and after.

Platform-specific launch details belong to the local environment, not this skill. The launch must satisfy:

- `FLOW_READER_DATA_DIR` points to an isolated directory under `perf-results/`.
- A debug endpoint is reachable at `FLOW_READER_CDP_URL`.
- The client is the compiled release executable, not `pnpm dev` or `pnpm tauri:dev`.

Then run the measurement against that client:

```text
node --input-type=module -e "process.env.FLOW_READER_CDP_URL='http://127.0.0.1:9351'; process.env.FLOW_READER_PERF_MODE='tauri'; process.env.FLOW_READER_PERF_OUT_DIR='perf-results/reader-performance-baseline'; await import('./.agents/skills/reader-performance-measurement/scripts/measure-reader-performance-client.mjs')"
```

For the after-run, change only `FLOW_READER_PERF_OUT_DIR`:

```text
node --input-type=module -e "process.env.FLOW_READER_CDP_URL='http://127.0.0.1:9351'; process.env.FLOW_READER_PERF_MODE='tauri'; process.env.FLOW_READER_PERF_OUT_DIR='perf-results/reader-performance-after'; await import('./.agents/skills/reader-performance-measurement/scripts/measure-reader-performance-client.mjs')"
```

Compare:

```text
node .agents/skills/reader-performance-measurement/scripts/compare-reader-performance.mjs <baseline.json> <after.json> > perf-results/reader-performance-compare.txt
node .agents/skills/reader-performance-measurement/scripts/compare-reader-performance.mjs <baseline.json> <after.json> --json > perf-results/reader-performance-compare.json
```

Keep output under gitignored `perf-results/` as temporary local evidence. Do not reference those paths from versioned performance history; preserve the relevant conditions and numeric deltas in the history entry itself.

## Browser Smoke Procedure

Use this only to validate script behavior or cross-platform support:

```text
pnpm build
python -m http.server 7127 -d out
node --input-type=module -e "process.env.FLOW_READER_PERF_MODE='browser'; process.env.FLOW_READER_PERF_BOOK_SOURCE='mock'; process.env.FLOW_READER_PERF_OUT_DIR='perf-results/reader-performance-browser-smoke'; await import('./.agents/skills/reader-performance-measurement/scripts/measure-reader-performance-client.mjs')"
```

Do not use browser-smoke numbers to accept a performance optimization.

## Scenario Selection

Use the smallest scenario set that covers the changed path, then broaden if the code is shared:

- Tab state, sidebar subscriptions, tab UI, or focused-tab data: include `tab-switch/sidebar-closed`, `tab-switch/sidebar-toc`, `tab-click/sidebar-closed`, `tab-click/sidebar-toc`, `rapid-tab-click/sidebar-closed`, and `rapid-tab-click/sidebar-toc`.
- Page-turn, pagination, epubjs location, iframe layout, or reader body changes: include `page-turn/sidebar-closed`, `page-turn/sidebar-toc`, `page-turn-api/sidebar-closed`, `page-turn-api/sidebar-toc`, `rapid-page-turn/sidebar-closed`, and `rapid-page-turn/sidebar-toc`.
- Annotation/definition overlay changes: include annotation sidebar/tab scenarios when available, plus closed-sidebar page-turn or tab-switch scenarios that exercise overlay hit testing over the active body.
- Search, TOC, annotation, image, or typography sidebar changes: include the matching sidebar scenario and at least one closed-sidebar scenario to catch hidden work regressions.
- Generated book resource changes: include opening/import setup and at least one page-turn scenario whose body uses the generated content shape.

Keep baseline and after filters identical.

## Result Interpretation

Prefer `steadySummary` when present. Use cold samples only when the change specifically targets startup, first open, import, or first tab adoption.

Check at least:

- `firstFrameMs` p50 and p95.
- `operationMs` p50 and p95.
- `settledMs` p50 and p95.
- Long task count, total duration, and max duration.
- Reader counters: `display`, `next`, `prev`, `resizeRendition`, and `relayoutCurrentView`.

A stable p95 regression above 10% needs an explicit UX or correctness justification. A stable regression above 20% should be rejected unless it fixes a necessary correctness issue and has a follow-up optimization plan. New long tasks in rapid tab switching or rapid page turns are high risk even when average times look acceptable.

Do not accept an optimization that improves one scenario by moving work into another required scenario unless the product tradeoff is explicit and measured.

## Measurement Integrity

- Do not serialize localized UI text, large `innerText` snapshots, or locale-specific strings into performance assertions.
- Prefer selectors, counts, rects, resource ids, location signatures, reader counters, and timing values.
- Do not add measurement code that creates enough DOM reads, text extraction, or mutation work to distort the measured workflow.
- Keep the same run count, window size, scenario list, book source, executable build, and data setup across baseline and after.
- If the result JSON shows the wrong mode, app URL, book source, or missing client metadata, do not use it for acceptance.

## Final Response Requirements

State:

- Whether the performance workflow was required.
- Which evidence level was used.
- Baseline, after, and compare artifact paths only when those local files were actually produced and remain useful for the current handoff.
- The key deltas that justify keeping or rejecting the change.
- Any reason the result is only smoke evidence rather than final acceptance.

Do not use local `perf-results/` paths as a substitute for reporting the actual comparison or as evidence in a versioned history entry.

## Skill Resources

- Reference: [Performance History](references/performance-history.md)
- Measure script: [measure-reader-performance-client.mjs](scripts/measure-reader-performance-client.mjs)
- Compare script: [compare-reader-performance.mjs](scripts/compare-reader-performance.mjs)
