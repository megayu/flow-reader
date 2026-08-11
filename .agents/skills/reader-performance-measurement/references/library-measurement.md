# Library Measurement

Use for bookshelf grid/virtualization, covers, search/filter/sort, scrolling, or
reader/library switching. Run commands from the repository root.

## Contents

[Platform](#platform) · [Dataset](#dataset) · [Scenarios](#scenarios) ·
[Release](#release-workflow) · [Results](#interpret-and-limits)

## Platform

Authoritative runs require the Windows Tauri/WebView2 release client. The runner
verifies `Flow Reader.exe`, samples its native/WebView2 tree and host pressure,
then shuts it down. Internals use Windows APIs; orchestrate with Bash (Git Bash
works). Bash syntax alone is not cross-platform evidence.

## Dataset

The generator writes deterministic library/settings/covers/manifest data under
`perf-results/library-virtualization/`. No parameter is a universal default.

| Parameter | Choose from |
| --- | --- |
| `--count` | Suspected crossover plus representative small/large cases needed by the decision. |
| `--covers` | `webp` common path; `mixed` format interaction; `svg` real SVG assets; `none` targeted diagnostics only. |
| `--seed` | Any fixed seed, unchanged across matched runs. |
| `--card-width` | Product setting; add 120/160/240 only when size matters. |
| `--show-recent` | Measured feature state, unchanged across runs. |

`mixed` targets 90% WebP, 5% real SVG, and 5% missing assets, with integer
rounding. Its SVG items are not application-generated CSS covers.

## Scenarios

Defaults: `library-mount`, `library-scroll`, `library-filter-apply`,
`library-filter-clear`, `library-sort`, `library-search-apply`,
`library-search-clear`, `library-filtered-scroll`, and
`library-searched-scroll`.

- `library-cover-return`: add for image retention/flash work. It measures
  pending-cover return frames, requires visible real `<img>` covers, and is
  invalid for CSS-only data. Active-library cover work normally needs all
  defaults plus this scenario.
- `library-to-reader`, `reader-to-library`: add for warmed switching. Use pristine
  data, set `FLOW_READER_LIBRARY_PERF_SWITCH_READY=1`, and exclude one warmup that
  opens a real cover and unpacks the EPUB. Cross-mode resource lifetime needs
  separate quick and post-timeout matrices; set
  `FLOW_READER_LIBRARY_PERF_SWITCH_RETURN_DELAY_MS` accordingly. Set
  `FLOW_READER_LIBRARY_PERF_SWITCH_LIBRARY_SCROLL=middle` only for a virtualized
  large-library return that must restore a scrolled position; the default is
  `top`.

Set `FLOW_READER_LIBRARY_PERF_SCENARIOS` to affected operations plus moved-work
controls. Do not rerun unrelated scenarios for a uniform result set.

## Release Workflow

The example values below are not defaults; replace them using the rules above.
Run all blocks in one Bash session. Generate one template, then separate
baseline/after copies:

```bash
set -euo pipefail
export FLOW_PERF_ROOT='.agents/skills/reader-performance-measurement'
export FLOW_LIBRARY_DATA='perf-results/library-virtualization/data/example'
node "$FLOW_PERF_ROOT/scripts/generate-library-performance-data.mjs" \
  --out "${FLOW_LIBRARY_DATA}-template" --count 800 --covers mixed \
  --seed 42 --card-width 160
test ! -e "${FLOW_LIBRARY_DATA}-baseline"
test ! -e "${FLOW_LIBRARY_DATA}-after"
cp -R "${FLOW_LIBRARY_DATA}-template" "${FLOW_LIBRARY_DATA}-baseline"
cp -R "${FLOW_LIBRARY_DATA}-template" "${FLOW_LIBRARY_DATA}-after"
```

Set common measurement parameters and a bounded Bash runner:

```bash
export FLOW_READER_CDP_URL='http://127.0.0.1:9351'
export FLOW_READER_LIBRARY_PERF_RUNS='5'
export FLOW_READER_LIBRARY_PERF_STEADY_SKIP='1'
export FLOW_READER_LIBRARY_PERF_PILOT_RUNS='3'
export FLOW_READER_LIBRARY_PERF_SETTLE_MS='15000'
export FLOW_READER_LIBRARY_PERF_PREFLIGHT_SECONDS='15'
# Example for active-library cover resources; derive from the rules above.
export FLOW_READER_LIBRARY_PERF_SCENARIOS='library-mount,library-scroll,library-filter-apply,'\
'library-filter-clear,library-sort,library-search-apply,library-search-clear,'\
'library-filtered-scroll,library-searched-scroll,library-cover-return'
export WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=9351 --js-flags=--expose-gc'

measure_library_side() {
  local side="$1"
  cp "perf-results/library-virtualization/runtime-binaries/Flow Reader-${side}.exe" \
    'src-tauri/target/release/Flow Reader.exe'
  export FLOW_READER_DATA_DIR="$PWD/${FLOW_LIBRARY_DATA}-${side}"
  export FLOW_READER_LIBRARY_PERF_OUT_DIR="perf-results/library-virtualization/${side}/example"
  './src-tauri/target/release/Flow Reader.exe' &
  local client_pid=$!
  local ready=0
  for _ in {1..30}; do
    if curl --fail --silent 'http://127.0.0.1:9351/json/version' > /dev/null; then
      ready=1
      break
    fi
    sleep 1
  done
  if [ "$ready" -ne 1 ]; then
    kill "$client_pid"
    return 1
  fi
  node "$FLOW_PERF_ROOT/scripts/measure-library-performance-client.mjs"
}
```

Before editing, build, record, preserve, and measure the baseline. Only then edit
runtime source:

```bash
pnpm tauri:build
mkdir -p 'perf-results/library-virtualization/runtime-binaries'
cp 'src-tauri/target/release/Flow Reader.exe' \
  'perf-results/library-virtualization/runtime-binaries/Flow Reader-baseline.exe'
measure_library_side baseline
```

After implementation, repeat the build/profile for the after side. The runner
closes each verified client:

```bash
pnpm tauri:build
cp 'src-tauri/target/release/Flow Reader.exe' \
  'perf-results/library-virtualization/runtime-binaries/Flow Reader-after.exe'
measure_library_side after
```

Compare:

```bash
node "$FLOW_PERF_ROOT/scripts/compare-library-performance.mjs" \
  perf-results/library-virtualization/baseline/example/<baseline.json> \
  perf-results/library-virtualization/after/example/<after.json>
```

## Interpret and Limits

Compare operation/first-frame/settled p50/p95; long-task count/total/max; total
process private/working-set memory; renderer/GPU private memory; mounted/visible
cards; DOM nodes/documents; cover-return pending frames/duration; and switch-cycle
memory.

- Require one repository client and the established 1280×800 Windows/DPR
  geometry; runtime displacement invalidates evidence.
- Intervene only when unrelated load, memory pressure, throttling, or another
  client makes runs non-comparable; an idle desktop is unnecessary.
- The comparer omits some launch flags, actual dimensions, settle/preflight,
  binary identity, and host-pressure checks. It does match the primary dataset,
  settings, requested window/DPR, runs/skip/pilots, and scenario matrix.
- Current repository state does not identify a preserved binary; record it when
  preserving the file.
- Delete temporary `perf-results/` data/binaries unless needed for handoff.

Optional controls include `FLOW_READER_LIBRARY_PERF_CPU_PROFILE`,
`FLOW_READER_LIBRARY_PERF_WINDOW_WIDTH`,
`FLOW_READER_LIBRARY_PERF_WINDOW_HEIGHT`, and
`FLOW_READER_LIBRARY_PERF_SWITCH_RETURN_DELAY_MS`.

After script changes, run `node --check`, generate a small temporary dataset,
verify its manifest distribution, then delete it.
