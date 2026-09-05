---
name: reader-performance-measurement
description: >-
  Measure Flow Reader reader and bookshelf runtime performance with matched
  baselines and real-client evidence. Use for changes to tab switching, page
  turns, sidebars, search, library mount/scroll/filter/sort, virtualization,
  covers, resource lifetime, reader/library switching, or this harness.
---

# Flow Reader Performance Measurement

Accept performance decisions only from comparable client measurements.

## Procedure

1. Trace the changed runtime mechanism and apply the gate below.
2. Read [Reader Measurement](references/reader-measurement.md) or
   [Library Measurement](references/library-measurement.md) for the affected
   surface. Read [React Render Measurement](references/react-render-measurement.md)
   only when the work changes React subscriptions, component ownership, memo
   boundaries, or explicitly investigates repeated renders.
3. For optimizations, search [Performance History](references/performance-history.md)
   for matching retained/rejected work and baseline constraints.
4. When the gate requires measurement, capture the actual worktree before
   editing runtime source.
5. Implement, rebuild with the same profile, and repeat identical conditions.
6. Compare matched results, retain/reject, report, and update history when eligible.

## Measurement Gate

| Work | Measure when |
| --- | --- |
| Feature/correctness | Runtime work changes materially and a bundled scenario executes it. |
| Optimization | Always, unless code proves strictly less work with no replacement, relocation, or runtime tradeoff. |

React render diagnosis is optional and must stay outside routine checks and CI.
Use it to locate component fan-out and verify the same interaction after a
change. Use `tauri-release` evidence for the retain/reject decision.

Material changes affect count, frequency, complexity, resource volume, layout,
subscriptions, timing, decoding, DOM lifetime, or retained resources. Skip cheap
bounded logic, static values, validation, parsing, persistence-only plumbing,
labels, translations, and declarative output with unchanged work. Judge the
mechanism, not its file/component name.

For uncovered optimizations, add/adapt the smallest direct scenario. Never use a
nearby operation as evidence. Harness-only maintenance needs no runtime baseline.

## Evidence

| Level | Use |
| --- | --- |
| `browser-smoke` | Validate harness/fixtures; never accept an optimization. |
| `tauri-dev` | Diagnose real-client behavior; never final evidence. |
| `tauri-release` | Accept/reject runtime optimizations. |

Never compare levels. Match build profile, data, settings, window/DPR, scenarios,
runs, warmup, and launch configuration.

## Baseline Contract

- Measure before editing, including relevant dirty changes; never relabel an
  after-run.
- Record commit/dirty state, profile, scenarios/runs, window/DPR, data, launch,
  and artifact.
- Inspect metadata and samples, not only summaries.
- Preserve expensive baseline binaries and record their build source before
  editing; later repository state cannot identify an old binary.
- Use isolated data and exactly one repository client.
- When measurement is required, stop before runtime edits if no trustworthy
  baseline is possible.

## Decision and Report

- Prefer steady summaries when available; compare matched full burst summaries
  for rapid scenarios without steady exclusion. Use cold samples only for
  explicitly cold work.
- Check operation, first-frame, settled, long tasks, memory, and surface metrics.
- A stable p95 regression above 10% needs explicit UX/correctness justification.
  Reject above 20% unless correctness requires it and a follow-up plan exists.
- Treat new rapid-interaction long tasks as high risk.
- Reject optimizations that move cost into another required path unless both
  paths and the product tradeoff are explicit.
- Comparers report deltas; they do not enforce thresholds, noise review, all
  metadata matches, or long-task policy.

Update history only for matched same-level optimization evidence. Record
percentage changes, level, conditions, and decision; store accepted/rejected
work once and move it if evidence reverses. Do not record feature gates,
after-only results, smoke, or local artifact paths.

Report the gate, level, key deltas, decision, and limitations. Mention artifacts
only when retained for review.

## Resources

- Reader: [reference](references/reader-measurement.md),
  [measure](scripts/measure-reader-performance-client.mjs),
  [compare](scripts/compare-reader-performance.mjs)
- Library: [reference](references/library-measurement.md),
  [data](scripts/generate-library-performance-data.mjs),
  [measure](scripts/measure-library-performance-client.mjs),
  [compare](scripts/compare-library-performance.mjs)
- React render diagnosis: [reference](references/react-render-measurement.md),
  [measure](scripts/measure-react-renders.mjs),
  [compare](scripts/compare-react-renders.mjs)
- [Performance History](references/performance-history.md)
