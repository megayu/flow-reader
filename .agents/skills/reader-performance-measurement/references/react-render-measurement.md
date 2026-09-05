# React Render Measurement

Collect per-interaction component render evidence from an optimized diagnostic
browser build.

## Evidence boundary

React Doctor 0.9.13 rejects an existing non-blank CDP page, creates a new page,
and closes scanned pages. It therefore cannot safely attach to Flow Reader's
initialized Tauri WebView2 page.

The runner opens an isolated browser profile, installs deterministic Tauri and
EPUB fixtures before navigation, injects the React Doctor probe, and records one
action. It checks probe support and event loss around the action. React 19.2
summaries expose generic `Mount` and `Unmount` labels, so named component events
come from trace entries that start inside the action and settle window. Raw
evidence remains beside the filtered result.

Treat the result as `browser-smoke` diagnosis. Accept or reject production
optimizations with matched `tauri-release` reader or library measurements.
Never compare timing across evidence levels.

## Commands

List implemented scenarios and the feature-family catalog:

```bash
pnpm perf:render:list
```

The profiling build uses React DOM's profiling entry and preserves function
names. It is not distributable. Build it before invoking the runner directly:

```bash
pnpm build:render-profile
node .agents/skills/reader-performance-measurement/scripts/measure-react-renders.mjs \
  --scenario reader.page-turn-keyboard --runs 1
```

Run the pilot scenario set with three independent recordings each:

```bash
pnpm perf:render:pilot
```

Run every implemented scenario:

```bash
pnpm perf:render:measure -- --runs 3
```

Use `--headed` for live React Doctor outlines. Use `--app-url` only with a
running profiling build. `--out-dir` must be an empty directory under
`perf-results/react-render`.

`reader.tab-click-large` opens 20 books and clicks the final tab. Its setup cost
is outside the action window; keep it separate from the three-tab control.

Results are written under `perf-results/react-render/<run-id>/`:

| File | Use |
| --- | --- |
| `manifest.json` | Source, build, browser, data, collector, selection, and hashes. |
| `coverage.json` | Feature families, implemented scenarios, selection, and completion. |
| `results.json` | Action outcomes, quality status, component events and summaries. |
| `quality.json` | Invalid/failed samples, capture issues, and the Tauri compatibility boundary. |
| `summary.md` | Mechanical hotspot table for diagnosis. |
| `raw/<scenario>/<sample>/` | React Doctor trace/report/stdout/stderr and probe snapshots. |

All project-owned schemas use version `1`.
Do not migrate an old result after the contract changes; record it again.

## Quality gate

A sample is valid only when the action completes, React is detected, non-control
actions support component tracks, React Doctor exits successfully, its JSON
parses, every captured component event is classified, and the action window
drops no events.

A completed action may contain zero render events when the recording proves
track support and the business outcome changed. Treat its warning as requiring
review. An idle control may contain zero events without track support.

Do not analyze invalid samples.
Do not replace missing values with zero.
Do not call a feature family covered merely because one neighboring scenario passed.
The initial catalog intentionally shows unimplemented families until direct scenarios exist.

## Comparison

Record the baseline before changing runtime source. Keep scenario, browser,
viewport, fixture, collector, and sample count identical. The comparer rejects
mismatches and invalid samples:

```bash
pnpm perf:render:compare -- \
  perf-results/react-render/<baseline-run> \
  perf-results/react-render/<after-run>
```

The output reports median render count and trace-duration deltas. The trace range
is not component self time. The comparer neither declares defects nor enforces
thresholds. Inspect raw samples and pair them with matched Tauri release evidence.

## Extending coverage

Add a scenario only for a direct interaction that existing scenarios do not
measure. Declare its feature, source entries, preparation, single action,
completion condition, and outcome. Use deterministic content and an independent
recording.

Native dialogs, updater behavior, external dictionaries, and other unavailable platform surfaces must remain explicit `unimplemented` or manual coverage.
Do not invoke a lower-level API and report it as coverage of a native user interaction.

After script changes, run:

```bash
node --check .agents/skills/reader-performance-measurement/scripts/react-render-fixture.mjs
node --check .agents/skills/reader-performance-measurement/scripts/react-render-scenarios.mjs
node --check .agents/skills/reader-performance-measurement/scripts/react-doctor-driver.mjs
node --check .agents/skills/reader-performance-measurement/scripts/measure-react-renders.mjs
node --check .agents/skills/reader-performance-measurement/scripts/compare-react-renders.mjs
pnpm check:skills
```
