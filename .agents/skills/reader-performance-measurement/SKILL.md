---
name: reader-performance-measurement
description: >-
  Use before editing Flow Reader when the task explicitly targets runtime
  performance, or when a feature/correctness change can plausibly alter the
  amount, timing, frequency, complexity, or lifetime of reader runtime work.
  Read the skill to decide whether an existing scenario requires measurement.
  Do not use for cheap bounded logic, static CSS/property values, or declarative
  layout-only changes that keep the same runtime work.
---

# Reader Performance Measurement

Use comparable client measurements—not intuition—to decide whether a change is
performance-safe or whether an optimization should be retained.

## Execution Flow

1. Apply the [measurement gate](#1-apply-the-measurement-gate).
2. Match the changed operation to the [coverage catalog](#2-match-actual-coverage).
   If measurement is not required, stop performance work and report why.
3. Select an evidence level, read relevant performance history, and produce a
   trustworthy pre-edit baseline.
4. Implement the change, rebuild with the same profile, and repeat the same
   measurement conditions.
5. Compare baseline and after results, decide whether to retain the change, and
   report the evidence.
6. Update performance history only for a measured performance-optimization
   experiment.

## 1. Apply the Measurement Gate

| Work type                     | Measure when                                                                                                                        |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Feature or correctness change | Both conditions hold: the change materially affects runtime work in an operation, and the coverage catalog measures that operation. |
| Performance optimization      | Measure unless the improvement is structurally guaranteed by removing work without replacement or relocation.                    |

A material effect changes work count, frequency, complexity, resource volume,
layout invalidation, subscriptions, update timing, or object lifetime. Classify
the mechanism and trace its data path; a reader component name, a value reaching
the reader, or a nearby scenario is not sufficient.

Inspect these paths when the mechanism can materially affect them:

- Tab selection, tab clicks, or rapid tab interactions.
- Page turns, `next`, `prev`, display, relocation, pagination, or spread
  restoration.
- Zoom, typography, single/spread mode, reader width, iframe sizing, or reader
  pane CSS that changes render cost.
- `packages/epubjs` manager, view, rendition, layout, event, resize, or location
  code.
- Active annotation or definition overlays that add body hit testing, redraws,
  DOM nodes, observers, or pointer/mouse handling.
- TOC, search, annotation, image, typography, or other sidebar panels that
  observe or render focused-reader state.
- Generated TXT/EPUB packages, XHTML, CSS, image dimensions, metadata, or
  resource structure that changes reader DOM size, pagination, loading, or
  iframe content.
- React state flow or Valtio subscriptions that affect first frame, settled
  time, or long tasks in reader interactions.

Skip measurement when runtime work is unchanged, including:

- Cheap bounded conditions or assignments, static CSS/property values, and
  declarative output changes unless the exact code is known to be hot.
- Input validation, number normalization, parsing, or persistence that keeps
  the same commit event and reader update path.
- Rust storage plumbing, path handling, command permissions, or error text.
- Covers used only by library/metadata surfaces. Measure generated cover changes
  only when the measured reader operation loads the cover or the generated
  resource affects pagination; otherwise use visual/layout verification.
- Translations, labels, i18n-only text, documentation, and native code outside
  reader data/resource paths.
- Script- or test-only changes, except changes to the measurement script itself.

For feature/correctness work, skip performance measurement if either gate
condition fails.

Skip measurement when code alone proves that the same path performs strictly
less work, with no comparable replacement or work moved elsewhere. This covers
removing high-frequency IPC or duplicate computation. Still verify correctness;
measure if runtime behavior or tradeoffs make the result uncertain.

## 2. Match Actual Coverage

Use only scenarios that execute the changed operation:

| Operation measured                 | Scenario filters                                                                                                                                |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `focusedGroup.selectTab(...)`      | `tab-switch/sidebar-closed`, `tab-switch/sidebar-toc`, `tab-switch/sidebar-search`, `tab-switch/sidebar-annotation`, `tab-switch/sidebar-image` |
| Reader-tab click and adoption      | `tab-click/sidebar-closed`, `tab-click/sidebar-toc`, `tab-click/sidebar-search`, `tab-click/sidebar-annotation`, `tab-click/sidebar-image`      |
| Repeated reader-tab clicks         | `rapid-tab-click/sidebar-closed`, `rapid-tab-click/sidebar-toc`                                                                                 |
| `focusedBookTab.search(...)`       | `search-query/sidebar-search`                                                                                                                   |
| Arrow-key page turns               | `page-turn/sidebar-closed`, `page-turn/sidebar-toc`                                                                                             |
| `focusedBookTab.next()` / `prev()` | `page-turn-api/sidebar-closed`, `page-turn-api/sidebar-toc`                                                                                     |
| Repeated Arrow-key page turns      | `rapid-page-turn/sidebar-closed`, `rapid-page-turn/sidebar-toc`                                                                                 |

Imports and tab positioning happen before timing. The catalog does not measure
book import/open, first render, initial pagination, book-authored EPUB
CSS/images, zoom, typography, resize, view-mode changes, sidebar scrolling, or
overlay interaction. An open-sidebar variant measures only its table operation
while that panel is mounted.

If the operation is absent, skip measurement for feature/correctness work;
optimizations requiring empirical evidence must add or adapt a scenario. Update
this catalog whenever the measurement script changes its operations.

## 3. Establish the Pre-Edit Baseline

### Choose the evidence level

| Level           | Valid use                                                                                                                    |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `browser-smoke` | Fast cross-platform validation of the script and deterministic fixture; never final optimization evidence.                   |
| `tauri-dev`     | Debug client automation or reproduce a client-only issue in the real WebView/desktop shell; never final acceptance evidence. |
| `tauri-release` | Authoritative comparison for accepting or rejecting a performance-sensitive change: compiled client, isolated data, and CDP. |

Never compare different levels or substitute smoke/dev results for a release
after-run.

### Before editing runtime source

1. Read [Performance History](references/performance-history.md), search for the
   affected subsystem, and use applicable retained/rejected findings as starting
   evidence unless the code path or measurement conditions materially changed.
2. If retrying a rejected approach, state what changed and remeasure the same
   affected scenarios.
3. Name the runtime mechanism, select the exact scenario filters, then build and
   measure the current worktree at the chosen level.
4. Record the source state, build profile, filters, run count, window size, book
   source, data setup, command, and baseline artifact path.
5. Inspect result metadata and samples. A launched client, screenshot, passing
   smoke test, or after-only result is not a baseline.

Preserve unrelated user changes in both source states. A clean `HEAD` is not a
valid baseline when existing worktree changes reach the measured path.

If no reliable baseline can be produced, do not edit performance-sensitive
source; report the blocker. If source was already edited, never relabel it as
baseline. Remove only the agent's edit or reconstruct the pre-edit state in an
isolated worktree without disturbing user changes. Stop if neither is safe.

Diagnostics, documentation, test-only work, and measurement-script maintenance
need no runtime baseline unless they also change application runtime code.

## 4. Run Matched Measurements

Run from the repository root:

- Measure:
  [measure-reader-performance-client.mjs](scripts/measure-reader-performance-client.mjs)
- Compare:
  [compare-reader-performance.mjs](scripts/compare-reader-performance.mjs)

The scripts use `process.cwd()` as the app root. After editing either script, run
`node --check` on it.

Configure them through the current shell, CI runner, or a small Node launcher;
do not assume a platform-specific shell:

- `FLOW_READER_PERF_MODE`: `browser`, `tauri`, or `auto`.
- `FLOW_READER_PERF_BOOK_SOURCE`: `mock` or `native`.
- `FLOW_READER_PERF_OUT_DIR`: output directory under `perf-results/`.
- `FLOW_READER_PERF_SCENARIOS`: optional comma-separated scenario filters.
- `FLOW_READER_PERF_RUNS`: run count.
- `FLOW_READER_CDP_URL`: real-client CDP endpoint; default
  `http://127.0.0.1:9351`.
- `FLOW_READER_APP_URL`: browser-smoke URL; default
  `http://127.0.0.1:7127`.
- `FLOW_READER_DATA_DIR`: isolated app data directory; set before launching
  Tauri.

Keep the evidence level, release profile, window size, run count, scenario
filters, book source, data setup, and launch configuration identical across
baseline and after runs.

### Release-client acceptance

Build each source state with the same release profile:

```text
pnpm build
pnpm tauri:build
```

Launch the platform's compiled executable—not `pnpm dev` or `pnpm tauri:dev`—so
that:

- `FLOW_READER_DATA_DIR` points to isolated storage under `perf-results/`;
- `FLOW_READER_CDP_URL` reaches a CDP-compatible debug endpoint;
- baseline and after executables use the same launch configuration.

Platform-specific launch details belong to the local environment. If the Tauri
WebView cannot expose CDP, record that limitation and perform the closest
client/manual check separately; browser smoke is still not final acceptance.

Measure baseline:

```text
node --input-type=module -e "process.env.FLOW_READER_CDP_URL='http://127.0.0.1:9351'; process.env.FLOW_READER_PERF_MODE='tauri'; process.env.FLOW_READER_PERF_OUT_DIR='perf-results/reader-performance-baseline'; await import('./.agents/skills/reader-performance-measurement/scripts/measure-reader-performance-client.mjs')"
```

Measure after, changing only the output directory:

```text
node --input-type=module -e "process.env.FLOW_READER_CDP_URL='http://127.0.0.1:9351'; process.env.FLOW_READER_PERF_MODE='tauri'; process.env.FLOW_READER_PERF_OUT_DIR='perf-results/reader-performance-after'; await import('./.agents/skills/reader-performance-measurement/scripts/measure-reader-performance-client.mjs')"
```

Compare:

```text
node .agents/skills/reader-performance-measurement/scripts/compare-reader-performance.mjs <baseline.json> <after.json> > perf-results/reader-performance-compare.txt
node .agents/skills/reader-performance-measurement/scripts/compare-reader-performance.mjs <baseline.json> <after.json> --json > perf-results/reader-performance-compare.json
```

Treat `perf-results/` as temporary local evidence.

### Browser smoke

Use only to validate script behavior or cross-platform support:

```text
pnpm build
python -m http.server 7127 -d dist
node --input-type=module -e "process.env.FLOW_READER_PERF_MODE='browser'; process.env.FLOW_READER_PERF_BOOK_SOURCE='mock'; process.env.FLOW_READER_PERF_OUT_DIR='perf-results/reader-performance-browser-smoke'; await import('./.agents/skills/reader-performance-measurement/scripts/measure-reader-performance-client.mjs')"
```

## 5. Compare and Decide

Before comparing:

- Use identical scenario filters and matched baseline/after conditions.
- Reject result JSON with the wrong mode, app URL, book source, or missing client
  metadata.
- When changing measurement code, avoid localized UI text, large `innerText`
  snapshots, locale-specific strings, or enough DOM reads/text
  extraction/mutations to distort the operation. Prefer selectors, counts,
  rects, resource IDs, location signatures, reader counters, and timings.

Prefer `steadySummary`; use cold samples only for startup, first open, import, or
first tab adoption. Check:

- `firstFrameMs`, `operationMs`, and `settledMs` p50/p95;
- long-task count, total duration, and maximum duration;
- `display`, `next`, `prev`, `resizeRendition`, and `relayoutCurrentView`
  counters.

A stable p95 regression above 10% requires explicit UX or correctness
justification. Reject a stable regression above 20% unless it fixes necessary
correctness and has a follow-up optimization plan. Treat new long tasks during
rapid tab or page-turn scenarios as high risk even when averages are acceptable.

Do not accept an optimization that merely moves work into another required
scenario unless that product tradeoff is explicit and measured.

## 6. Record and Report

Use [Performance History](references/performance-history.md) only for performance
optimization experiments, not as a changelog or general regression ledger.
Feature/correctness measurements used only as a no-regression gate do not belong
there.

Add an entry only when same-level, matched baseline/after results provide
quantified timing or long-task evidence for a retained or rejected decision.
Record timing metrics as baseline-to-after percentage changes, not absolute
milliseconds. For a count metric whose baseline is zero, record the baseline and
after counts because a percentage is undefined. Exclude after-only results,
smoke passes, correctness outcomes, diagnostics, and unquantified claims.
Include the scenario, metric, percentage change, evidence level, decision, and
relevant run conditions; local `perf-results/` paths are not durable evidence.

Put accepted optimizations under `Retained Approaches`. Put removed or unadopted
attempts under `Rejected Approaches` and state what measurement or code-path
change would justify retrying. Never record one attempt in both sections. If new
evidence reverses a decision, update and move the existing entry.

In the final response, state:

- whether performance measurement was required and why;
- the evidence level;
- key percentage deltas supporting retention or rejection;
- artifact paths only when files were produced and remain useful for handoff;
- why evidence is smoke-only rather than final, when applicable.

Never substitute local artifact paths for the actual comparison.

## Skill Resources

- History: [Performance History](references/performance-history.md)
- Measure:
  [measure-reader-performance-client.mjs](scripts/measure-reader-performance-client.mjs)
- Compare:
  [compare-reader-performance.mjs](scripts/compare-reader-performance.mjs)
