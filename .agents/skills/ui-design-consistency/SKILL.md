---
name: ui-design-consistency
description: >-
  Apply Flow Reader's desktop design contract when a task changes visual
  appearance, geometry, control composition, established mouse interaction,
  themes, spacing, typography presentation, shortcuts, UI dependencies, or the
  choice of UI primitive. Do not use for local input validation or normalization,
  parsing, storage, persistence, data flow, or state plumbing that preserves the
  established UI and interaction contract.
---

# Flow Reader Desktop UI

## Scope Gate

Trigger this skill from the mechanism being changed, not from a component name,
screen, or downstream consumer. A task involving a control, sidebar, typography
setting, or reader overlay does not by itself make the task UI design work.

Use this skill only when implementation requires a user-visible design decision or
changes an established visual or mouse-interaction contract. Do not use it for a
focused correctness fix such as numeric validation, parsing, serialization,
persistence, or callback/state plumbing when the intended UI and workflow are
already defined and remain unchanged. If the task also changes presentation,
geometry, dismissal, pointer behavior, or control composition, use the skill for
that part only.

## Read the Specification

Before changing or accepting UI, read
[Flow Reader UI Specification](references/design-system.md). Inspect the real
entry point and current owner as well; the specification defines the product
contract, while code supplies implementation details.

Do not edit this skill or its specification during an ordinary UI task. Update
them only when the user explicitly requests a skill or specification change.
Report a possible missing rule separately.

## Product Premises

Derive every UI decision from these premises, in this order:

1. Flow Reader is a desktop application. Tauri's WebView is an implementation
   detail, not a reason to import browser-product, responsive-web, touch, or mobile
   interaction conventions.
2. Every workflow must be fully usable with a mouse. Keyboard plus mouse is the
   efficient mode; keyboard-only traversal of the complete interface is not a
   product goal.
3. Add shortcuts only for genuinely frequent actions. Prefer a single character
   when it is safe, memorable, scoped, and blocked while the user is editing text.
4. Prioritize low latency, fast response, and low memory use.
5. Keep the UI coherent, polished, and clear, with only interaction effects that
   communicate state or response.
6. Prefer less code, less state, and fewer dependencies when behavior and visual
   quality are equal.

These premises select an implementation. They do not authorize changing an
established workflow or visual contract.

## Interaction Rules

- Keep click, double-click, right-click, wheel, hover, drag, selection, dismissal,
  and persistence behavior intact where the workflow uses them.
- Preserve native text-entry keys and existing product shortcuts.
- Add a shortcut only when the action is frequent, unambiguous in its active
  context, and also reachable by mouse. Define global shortcut metadata in
  `src/shortcuts.ts`, handle it at the narrowest existing feature owner, and use
  the guards in `src/keyboard.ts`. Keep established shortcut actions unless the
  user explicitly asks to remove them.
- Do not add Tab traversal, roving focus, arrow/Home/End control navigation,
  keyboard resizing, or component-local key state merely to make a complex UI
  keyboard-operable. Add such behavior only when the user requests that exact
  interaction or it is already part of the product workflow.
- Use native buttons and text controls for real controls. Do not replace a native
  control merely to suppress its incidental browser keyboard behavior. Conversely,
  do not turn a `div` or row into a keyboard control with `role`, `tabIndex`, and
  Enter/Space simulation unless that exact keyboard interaction is a product
  requirement.
- Do not use generic Web accessibility or ARIA coverage as a reason to replace a
  control, add state synchronization, add locale strings, or expand tests. Leave
  attributes owned by an installed primitive alone, but do not build product logic
  around them unless explicitly requested.
- Treat desktop hover as a normal, available interaction. Essential actions must
  still be directly reachable by mouse and must not move surrounding geometry when
  they appear.

## Choose the Lowest-Cost Correct Implementation

Evaluate a complete workflow, not a component name:

1. Leave a correct working control unchanged when the task does not require it.
2. Fix styling with existing tokens and CSS when behavior is already correct.
3. Reuse or narrowly extend an existing Flow component when it owns the same
   geometry and behavior.
4. Use a platform element or an already-installed primitive only when it preserves
   the exact UI/UX and reduces total maintained code or runtime ownership.
5. Add a UI dependency only with explicit user authorization and evidence that it
   reduces total code and runtime cost without changing behavior or appearance.

shadcn/ui is a source of optional recipes, not the Flow design system and not a
migration target. Radix is an installed implementation tool, not a default answer.
Never replace a working control merely because a library exposes a similarly named
primitive.

Reject an implementation that adds a parallel overlay, focus, keyboard, state, or
styling system. Before accepting a dependency change, verify its exact imports are
tree-shaken, measure production bundle impact, identify the code it deletes, and
account for listeners, portals, observers, state, and memory.

## Preserve the Baseline

Before replacing behavior, structure, layout ownership, or a dependency:

- run the existing control through its real opening route;
- record relevant geometry, default and persisted values, content sizing,
  scrolling, pointer behavior, themes, localization, and window resizing;
- record existing shortcuts only when the affected workflow has them;
- capture both appearance and interaction, not screenshots alone.

For a local visual-state correction, inspect the affected states before editing;
a full application inventory is unnecessary. If a trustworthy behavioral baseline
cannot be obtained, do not perform a structural replacement.

## Implementation Constraints

- Keep state at the narrowest durable owner. Avoid mirrored state and synchronization
  effects.
- Use CSS for hover, pressed, selected, disabled, and simple open/close visuals.
- Do not add observers, global listeners, timers, RAF loops, layout reads, portals,
  or React state for cosmetic behavior.
- Keep hidden or inactive UI from performing layout, animation, polling, or render
  work it does not need.
- Keep geometry stable across interaction states. Center single-line control text
  and icons visually.
- Do not broaden a targeted correction into a component-family migration.
- Apply reader skills from the changed mechanism, independently. Reader geometry,
  pagination inputs, or resize semantics trigger the layout skill. They do not
  trigger performance measurement unless the change also alters the amount,
  timing, frequency, or lifetime of reader runtime work.

## Choose Verification Before Editing

Select one level before changing code. Do not upgrade to a slower level after the
selected evidence passes unless the code changes again, the result is ambiguous,
or a failure reveals a broader mechanism.

### Level 0 — source inspection

Use for a literal class, token, label, icon size, radius, spacing value, or other
single-site presentation edit whose established result is unambiguous and which
changes no behavior, state, ownership, dependency, or layout algorithm.

- Inspect the owner and affected rule, make the narrow edit, and run only a
  targeted formatter or static check when needed.
- Do not add an automated test, launch a client, take a screenshot, or run a
  production/Tauri build by default.

### Level 1 — local visual check

Use when appearance needs judgment: alignment, contrast, hover/selected/disabled
feedback, clipping, or consistency with visible peers, while behavior is unchanged.

- Reuse an already-running page/client and refresh only the affected route.
- Use DOM rectangles only for an exact geometry or overflow claim.
- Use a screenshot only when pixels, contrast, theme, or comparison with a visual
  reference matters. A screenshot is not evidence for interaction correctness.
- Do not add an automated test or rebuild the desktop application for a local CSS
  correction unless the result is production/WebView-only.

### Level 2 — focused interaction check

Use when click, pointer-down, hover actions, drag, popup dismissal, scrolling,
selection, persistence, or state transitions change.

- Exercise only the affected mouse workflow in the fastest representative client.
- Add or change one targeted automated test only when the regression has a stable
  behavioral assertion and can recur silently, such as boundary math, persistence,
  shared state transitions, or a previously broken workflow.
- Do not write tests that merely restate CSS literals or fixed dimensions.
- Use a release client only for behavior known to differ in Tauri/WebView or when a
  reader skill requires that evidence level.

### Level 3 — structural or runtime verification

Use for shared primitive behavior, component replacement, dependency changes,
portals/listeners/observers, production bundling, reader geometry or pagination,
or changes affecting several workflows.

- Run the smallest targeted tests covering the shared mechanism, then the build or
  client checks required by that mechanism.
- Bundle/tree-shaking checks apply only to dependency or production-output changes.
- Reader layout and performance skills define any additional baseline and release
  gates; do not infer one skill from the other.

If a selected check cannot start, diagnose that check once. Do not repeat full
builds, relaunches, or equivalent evidence loops without a concrete reason. Report
the unavailable check and use a cheaper valid check when it can answer the same
question.

## Workflow

1. Identify the exact UI, all real opening methods, and the task it completes.
2. Establish the applicable baseline before structural work.
3. Read the relevant contracts in the specification and inspect analogous Flow UI.
4. Compare the current owner, existing Flow components, platform CSS/elements, and
   installed primitives by behavior, appearance, runtime, memory, and final code.
5. Implement the narrowest complete correction and delete code it truly replaces.
6. Run only the verification level selected above. Exercise shortcuts only when
   the change touches them.
7. Review source growth, dependencies, listeners, and runtime ownership only when
   the implementation can change them.

## Acceptance

Accept the change when its preselected verification level passes. A one-line visual
edit does not require an automated test or packaged client. Pointer, drag, popup,
persistence, window, and WebView-specific changes still require their affected
real workflow, but not unrelated application workflows.

In the final response, list each changed control and how the user opens it, state
what interaction and appearance were verified, disclose code/dependency/runtime
growth when applicable, and name only relevant unverified workflows.
