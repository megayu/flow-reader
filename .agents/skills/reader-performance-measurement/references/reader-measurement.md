# Reader Measurement

Use for reader tabs, page turns, search, sidebars, overlays, EPUB rendering, or
geometry. Run commands from the repository root.

## Contents

[Scenarios](#scenarios) · [Release](#release-workflow) ·
[Smoke](#browser-smoke) · [Results](#interpret-and-limits)

## Scenarios

| Operation | Filters |
| --- | --- |
| `reader.selectTab(...)` | `tab-switch/sidebar-closed`, `tab-switch/sidebar-toc`, `tab-switch/sidebar-search`, `tab-switch/sidebar-annotation`, `tab-switch/sidebar-image` |
| Tab click/adoption | `tab-click/sidebar-closed`, `tab-click/sidebar-toc`, `tab-click/sidebar-search`, `tab-click/sidebar-annotation`, `tab-click/sidebar-image` |
| Repeated tab clicks | `rapid-tab-click/sidebar-closed`, `rapid-tab-click/sidebar-toc` |
| `focusedBookTab.search(...)` | `search-query/sidebar-search` |
| Arrow-key turns | `page-turn/sidebar-closed`, `page-turn/sidebar-toc` |
| `focusedBookTab.next()` / `prev()` | `page-turn-api/sidebar-closed`, `page-turn-api/sidebar-toc` |
| Repeated Arrow-key turns | `rapid-page-turn/sidebar-closed`, `rapid-page-turn/sidebar-toc` |

Select affected operations plus controls for moved work. Import and tab
positioning are untimed. Coverage excludes import/open, first render, initial
pagination, authored EPUB assets, zoom, typography, resize, mode changes,
sidebar scrolling, and overlay interaction; add a direct scenario when needed.

Filters are substring matches. The example below selects single and rapid
closed/TOC page turns. Add `page-turn-api` when `next()`/`prev()` changes; add
closed/TOC tab-switch and tab-click controls when shared listeners, pagination,
or layout ownership changes.

## Release Workflow

Before editing, run `pnpm tauri:build` (it runs the Web build), record the source,
and preserve the binary if needed. Launch it from Bash with a new data directory
and bounded CDP wait:

```bash
set -euo pipefail
export FLOW_READER_DATA_DIR="$PWD/perf-results/reader-performance-data/baseline"
export WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=9351 --js-flags=--expose-gc'
test ! -e "$FLOW_READER_DATA_DIR"
mkdir -p "$FLOW_READER_DATA_DIR"
'./src-tauri/target/release/Flow Reader.exe' &
export FLOW_READER_CLIENT_PID=$!
for _ in {1..30}; do
  curl --fail --silent 'http://127.0.0.1:9351/json/version' > /dev/null && break
  sleep 1
done
curl --fail --silent 'http://127.0.0.1:9351/json/version' > /dev/null || {
  kill "$FLOW_READER_CLIENT_PID"
  exit 1
}
```

Measure; the scenario list is illustrative and must come from the table:

```bash
export FLOW_READER_CDP_URL='http://127.0.0.1:9351'
export FLOW_READER_PERF_MODE='tauri'
export FLOW_READER_PERF_BOOK_SOURCE='native'
export FLOW_READER_PERF_SCENARIOS='page-turn/sidebar-closed,page-turn/sidebar-toc'
export FLOW_READER_PERF_RUNS='12'
export FLOW_READER_PERF_STEADY_SKIP='3'
export FLOW_READER_PERF_OUT_DIR='perf-results/reader-performance-baseline'
node .agents/skills/reader-performance-measurement/scripts/measure-reader-performance-client.mjs
```

Stop the baseline client and verify its CDP/processes exited. Launch the matched
after binary with a different new data directory and output; keep book
source/size, runs, window/DPR, flags, and scenarios unchanged. Compare:

```bash
node .agents/skills/reader-performance-measurement/scripts/compare-reader-performance.mjs \
  perf-results/reader-performance-baseline/<baseline.json> \
  perf-results/reader-performance-after/<after.json>
```

Optional controls: `FLOW_READER_PERF_BURST_RUNS`,
`FLOW_READER_PERF_WINDOW_WIDTH`, `FLOW_READER_PERF_WINDOW_HEIGHT`,
`FLOW_READER_PERF_SKIP_WINDOW_RESIZE`,
`FLOW_READER_PERF_REQUIRE_WINDOW_RESIZE`, `FLOW_READER_CPU_PROFILE`,
`FLOW_READER_PERF_DIAGNOSTICS`, `FLOW_READER_PERF_BOOK_CHAPTERS`,
`FLOW_READER_PERF_BOOK_PARAGRAPHS`, `FLOW_READER_PERF_BROWSER_CHANNEL`,
`FLOW_READER_PERF_HEADLESS`, and `FLOW_READER_PERF_INCLUDE_TEXT_PREFIX`.

## Browser Smoke

Smoke validates the harness, never acceptance:

```bash
pnpm build
python -m http.server 7127 -d dist &
export FLOW_READER_PERF_MODE='browser'
export FLOW_READER_PERF_BOOK_SOURCE='mock'
export FLOW_READER_PERF_OUT_DIR='perf-results/reader-performance-browser-smoke'
node .agents/skills/reader-performance-measurement/scripts/measure-reader-performance-client.mjs
```

The default app URL is `http://127.0.0.1:7127`; override it with
`FLOW_READER_APP_URL`.

## Interpret and Limits

Compare operation/first-frame/settled p50/p95, long-task count/total/max, and
relevant `display`, `next`, `prev`, `resizeRendition`, and
`relayoutCurrentView` counters. Inspect raw results; the comparer omits some
match checks.

- `native` imports deterministic synthetic TXT, not authored EPUB resources.
- Rapid tab clicks assert each step's visibility; rapid page turns assert only
  final settled/render alignment. Rapid bursts have no steady skip/summary; use
  matched full burst summaries.
- JSON lacks durable binary identity; record source plus binary name/hash.
- The comparer does not reject mode, runs, window/DPR, data, flags, or scenario
  mismatches.
- Without Tauri CDP, report the limitation; browser smoke is not final evidence.

After script changes, run `node --check`.
