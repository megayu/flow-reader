---
name: reader-deterministic-layout
description: >-
  Use when a Flow Reader source change can alter pagination inputs, reader
  geometry, layout transactions, iframe sizing or compositing, committed
  body/header/footer snapshots, or size-dependent reader rendering. Do not use
  merely because code is located in a reader, typography, sidebar, or zoom UI;
  local validation, formatting, persistence, and state plumbing are excluded when
  they only constrain values before the existing layout API and do not change its
  update timing or layout semantics.
---

# Reader Deterministic Layout

Use this skill before implementing or accepting any Flow Reader change that can alter reader layout, pagination inputs, or user-visible alignment between body, header, footer, page number, and progress.

## Required Reference First

Before EPUB layout or pagination work, read
[EPUB Layout Policy](references/epub-layout-policy.md) for the product rules and
deliberate compatibility limits. EPUB conformance alone does not define a bug.

Before diagnosing, implementing, or accepting deterministic layout work, read [Failure Patterns](references/failure-patterns.md). Search it for the touched subsystem and use the recorded symptoms, root causes, and rejected approaches to choose the reproduction path and verification gates.

If a new bug resembles an existing pattern, reproduce the recorded path before adding new fallback logic. If a rejected approach now looks viable, first state what changed since the rejection.

Treat [Failure Patterns](references/failure-patterns.md) as a curated reusable reference, not a changelog. Update an existing entry when the current work changes its conclusion. Add a new entry only when the finding is non-obvious and likely to guide multiple future books, code paths, or layout changes. Do not record one-off implementation omissions, localized visual tweaks, issue-specific prose, or fixes already explained completely by a focused regression test. Put reusable successful patterns under `Known Failure Patterns` and reusable failed strategies under `Rejected Approaches`.

Before editing the reference, name the future engineering decision the entry would change beyond the current bug or fixture. If there is no such decision, do not edit the reference.

## Decide Whether This Skill Applies

Classify the changed mechanism, not the feature label or the eventual consumer of
the value. Writing a setting that the reader later consumes is not enough. The
workflow applies only when the change can alter layout inputs after validation,
the timing or ownership of layout work, geometry, pagination, compositing, or the
committed visible snapshot.

Run this workflow for changes touching:

- Zoom behavior, single-page mode, spread mode, page width, typography layout, or responsive reader sizing.
- Sidebar open/close behavior when it changes reader width or active layout.
- Window resize, maximize/restore, viewport measurement, `ResizeObserver`, or layout invalidation.
- Tab activation, tab switching, hidden/inactive pane geometry, visibility, opacity, z-index, iframe lifecycle, or pane mounting.
- Header, footer, percentage, page number, chapter path, visible section indexes, or pagination snapshot commits.
- `packages/epubjs` display, relocation, rendition, view manager, spread, resize, or event ownership.
- Annotation and definition overlays when they redraw, align to text, respond to page turns, or depend on active iframe geometry.
- Generated TXT/EPUB package, XHTML, CSS, images, metadata, or resource structure when it can change pagination, iframe DOM, section count, or reader dimensions.
- Cover or SVG cover behavior when the requested change is about user-visible responsive layout, text wrapping, size adaptation, or client display correctness.

Do not run the full reader deterministic layout workflow for:

- Local input validation, number normalization, parsing, or persistence that feeds
  the same valid value type into the same existing layout update path.
- Pure storage, path, permission, logging, or error-text changes.
- Rust changes that only store or copy cover resources without changing the generated content consumed by reader layout or the UI surface under test.
- Translation-only changes.
- Non-reader library list styling that does not affect opening or reading layout.
- Test-only or script-only changes unless the verification script itself is changed.

If a change is about cover generation, classify the surface. Cover thumbnail/list rendering needs visual verification of that surface. It does not need reader tab/page-turn layout verification unless the generated cover is loaded in a reader workflow or affects pagination resources.

## Correctness Standard

A render is correct only when all of these are true:

- The active body shows the expected committed page or spread.
- Header chapter path belongs to the active body content.
- Footer page number, total pages, and percentage belong to the same committed body content.
- Visible section indexes match the body views.
- Spread mode shows only the expected left and right pages, never a mixed three-page partial state.
- No blank iframe remains after tab switch, resize, sidebar, zoom, or mode changes.
- Hidden tabs do not leak pixels, accept input, or commit stale layout events into the active tab.
- A tab switch with unchanged reader width, spread mode, and typography signature does not call `display`, `next`, `prev`, `resizeRendition`, or `relayoutCurrentView`.
- Repeating the same layout state reproduces the same body/header/footer/progress when no book-position operation happened.

Do not add broad fallback logic to hide incorrect state. In particular, do not fall back from runtime layout state to persisted CFI, jump to the first section, accept stale events because they look valid, or retry display loops that are not tied to the same transaction inputs.

## Required Verification Matrix

Choose the smallest set that covers the changed path, but final acceptance for shared layout code should include:

- Unchanged-size keyboard tab switching across at least three tabs.
- Unchanged-size wheel or mouse tab switching across at least three tabs.
- Single-tab repeated sidebar close/open.
- Single-tab repeated maximize/restore.
- Single-tab randomized resize/sidebar/maximize/restore operations.
- Multi-tab randomized resize/sidebar/maximize/restore/tab-switch operations.
- Chapter start, chapter middle, final page, and cross-section spread states when pagination code is touched.
- Pending page-turn state where the iframe body has advanced before the pagination snapshot commits; the next body must be covered until header/footer/body can commit together.
- Annotation or definition redraw on the right page or active page when overlay geometry is touched.
- No hidden pane pixel leak and no hidden-tab input handling.
- No tab-strip geometry drift during pure tab switching.

## Evidence Levels

- `browser-smoke`: useful for fast deterministic fixture checks and cross-platform script validation. Not enough for final client-only layout acceptance.
- `tauri-dev`: useful for debugging WebView behavior and desktop automation. Better than browser, but still dev build.
- `tauri-release`: compiled executable with isolated storage and CDP enabled. Use this for final acceptance when the change affects real reader layout, window behavior, iframe compositing, or performance-sensitive layout sequencing.

Do not compare or substitute across evidence levels. If only browser-smoke was run, say so.

## Bundled Script

Run this script from the repository root. It uses `process.cwd()` as the app root.

- Verify layout: `.agents/skills/reader-deterministic-layout/scripts/verify-reader-layout-client.mjs`

Use `node --check` on this script after editing it.

## Environment Contract

Configure the script with environment variables. Set them using the current shell, CI runner, or a small Node launcher; do not assume PowerShell, Bash, or any one platform.

Core variables:

- `FLOW_READER_LAYOUT_MODE`: `browser`, `tauri`, or `auto`.
- `FLOW_READER_LAYOUT_OUT_DIR`: output directory under `test-results/`.
- `FLOW_READER_CDP_URL`: CDP endpoint for a real Tauri/WebView client, default `http://127.0.0.1:9351`.
- `FLOW_READER_APP_URL`: browser-smoke app URL, default `http://127.0.0.1:7127`.
- `FLOW_READER_DATA_DIR`: isolated app data directory. Set this before launching the Tauri client.
- `FLOW_READER_LAYOUT_WINDOW_WIDTH`, `FLOW_READER_LAYOUT_WINDOW_HEIGHT`, `FLOW_READER_LAYOUT_MAXIMIZED_WIDTH`, and `FLOW_READER_LAYOUT_MAXIMIZED_HEIGHT`: optional geometry inputs.

The current real-client automation connects through CDP. Use it on platforms where the built app exposes a CDP-compatible debug endpoint. If the current platform cannot expose CDP for its Tauri WebView, browser-smoke is still useful but is not final proof for client-only layout, compositor, or desktop window behavior.

## Release Client Procedure

Build the app:

```text
pnpm build
pnpm tauri:build
```

Launch the compiled executable for the current platform with isolated storage and a CDP-compatible debug endpoint. Use the actual executable path for that platform.

Platform-specific launch details belong to the local environment, not this skill. The launch must satisfy:

- `FLOW_READER_DATA_DIR` points to an isolated directory under `test-results/`.
- A debug endpoint is reachable at `FLOW_READER_CDP_URL`.
- The client is the compiled release executable when final acceptance is required.

Run the verifier:

```text
node --input-type=module -e "process.env.FLOW_READER_CDP_URL='http://127.0.0.1:9351'; process.env.FLOW_READER_LAYOUT_MODE='tauri'; process.env.FLOW_READER_LAYOUT_OUT_DIR='test-results/reader-layout-release'; await import('./.agents/skills/reader-deterministic-layout/scripts/verify-reader-layout-client.mjs')"
```

Keep screenshots and `result.json` under `test-results/`.

## Browser Smoke Procedure

Use this only to validate script behavior or a cross-platform layout fixture:

```text
pnpm build
python -m http.server 7127 -d dist
node --input-type=module -e "process.env.FLOW_READER_LAYOUT_MODE='browser'; process.env.FLOW_READER_LAYOUT_HEADLESS='1'; process.env.FLOW_READER_LAYOUT_OUT_DIR='test-results/reader-layout-browser-smoke'; await import('./.agents/skills/reader-deterministic-layout/scripts/verify-reader-layout-client.mjs')"
```

Do not use browser-smoke as final proof for hidden iframe compositing, desktop window behavior, or release-client acceptance.

## Implementation Rules

- Preserve the invariant that inactive reader panes keep the same reader geometry as the active pane when they stay mounted.
- Hide inactive panes without letting them composite over the active pane or receive input.
- Treat tab activation with unchanged layout inputs as a visibility/state activation path, not a pagination path.
- Keep runtime layout state separate from persisted progress. Persisted progress is an initial-open input and background output, not a resize or tab-switch recovery source.
- Gate layout commits by current transaction inputs. Stale relocated/rendered events must not overwrite the active committed snapshot.
- Header, footer, body, percentage, and visible indexes must be committed from the same pagination snapshot.
- Do not change tab-strip geometry through selected-state transitions during rapid switching.
- Do not fix deterministic layout bugs by masking them with delayed retries, first-page fallback, or persisted CFI fallback.

## Choosing Additional Tests

Run targeted automated checks before client verification when available:

- Reader tab/layout specs for tab switching, stale layout cache, inactive pane geometry, final-page stability, and pagination no-op paths.
- EPUB engine tests when `packages/epubjs` behavior changes.
- UI interaction tests when annotations, definitions, hover, pointer, or tooltip behavior changes.
- `cargo test --manifest-path src-tauri/Cargo.toml` for native changes that alter generated resources, storage, or commands used by reader setup.

Then run client verification for the relevant evidence level.

## Final Response Requirements

State:

- Whether deterministic layout verification was required.
- Which evidence level was used.
- The verifier output directory and `result.json` path.
- The main scenario coverage.
- Any remaining gap, such as browser-smoke only, dev-client only, or a surface-specific cover check instead of full reader layout verification.

## Skill Resources

- Product policy: [EPUB Layout Policy](references/epub-layout-policy.md)
- Reference: [Failure Patterns](references/failure-patterns.md)
- Verifier script: [verify-reader-layout-client.mjs](scripts/verify-reader-layout-client.mjs)
