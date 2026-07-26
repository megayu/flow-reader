---
name: ui-design-consistency
description: >-
  Apply Flow Reader's desktop UI contract when a source change alters visible
  presentation, geometry, control composition, themes, established mouse or
  shortcut behavior, or UI primitive/runtime ownership. Trigger from the changed
  mechanism, not a component or file name. Exclude validation, parsing, storage,
  persistence, data flow, and state plumbing that preserve the established UI.
---

# Flow Reader Desktop UI

## Scope

Use this skill when the implementation requires a UI design decision or changes
an established visual or interaction contract. Do not trigger it merely because
code is in a component, reader, sidebar, settings screen, or overlay.

Apply it only to the UI-changing part of a mixed task. Local correctness work that
preserves presentation and interaction remains outside this skill.

Before editing, read the
[Flow Reader UI Specification](references/design-system.md) and inspect the real
owner and entry point. The specification defines the product contract; source
code defines the current implementation.

Edit this skill or its specification only when the user explicitly requests that
change. Report a possible missing rule separately during ordinary UI work.

## Decision Order

Follow this order:

1. Identify the source mechanism that must change. Do not classify work from nouns
   in the request such as “selection,” “hover,” or “notification.”
2. Identify the exact contract affected: presentation, geometry, interaction,
   state ownership, dependency, or runtime work.
3. Choose the narrowest implementation that satisfies that contract.
4. Choose the lowest verification level that directly proves the implementation.
5. Stop when that evidence passes. Upgrade only for ambiguity, a changed
   implementation, or a failure that exposes a broader mechanism.

Verification follows implementation risk and uncertainty, not the user-visible
behavior name. A deterministic declarative change does not require a runtime
interaction check merely because users perceive it as behavior.

## Implementation

Use the lowest-cost correct option:

1. Leave correct UI unchanged outside the requested scope.
2. Prefer an existing token, CSS rule, or local declarative property when it fully
   defines the result.
3. Reuse or narrowly extend an existing Flow component only when it owns the same
   geometry and behavior.
4. Use a platform element or installed primitive only when it preserves the exact
   workflow and reduces maintained code or runtime ownership.
5. Add a UI dependency only with explicit user authorization and evidence that it
   reduces total cost. Account for bundle output, listeners, portals, observers,
   state, and memory.

Keep state at the narrowest durable owner. Do not add observers, global listeners,
timers, RAF loops, layout reads, portals, or React state for cosmetic behavior.
Do not replace a working component merely because a library has a similarly named
primitive.

Establish a behavioral baseline before replacing structure, layout ownership,
interaction logic, or a dependency. A local declarative correction needs only
inspection of its owner, cascade, and affected state.

Apply reader layout and performance skills independently from their changed
mechanisms. A UI file location alone triggers neither skill.

## Verification Levels

Classify the expected diff after inspecting the owner. If more than one level
applies, use the highest level required by the actual implementation, not by
unrelated behavior on the same surface.

### Level 0 — source inspection

Use when all of these are true:

- the change is local and declarative, such as a literal class, CSS property,
  token, label, icon size, or static prop;
- the owner, selector precedence, and result are unambiguous;
- no event logic, state transition, structure, dependency, or layout algorithm
  changes.

This level may enable a native interaction when the browser contract is
deterministic. For example, adding `select-text` to a notification text container
is Level 0 after confirming its ancestor and selector cascade, even though users
can then select and copy the text.

Inspect the source and affected rule, then run only a targeted formatter or static
check when needed. Do not launch a client, take a screenshot, add a test, or run a
production/Tauri build.

### Level 1 — local visual check

Use when declarative styling needs visual judgment, including alignment, contrast,
clipping, or pure-CSS hover/selected/disabled feedback.

Check only the affected state in the fastest available page or client. Use DOM
rectangles for numeric geometry and screenshots only for pixel, theme, or
reference comparison. Do not add a test or production build for a local visual
decision.

### Level 2 — focused interaction check

Use when correctness depends on runtime event flow or state, such as click
handlers, pointer capture, drag math, popup dismissal, scrolling logic,
persistence, keyboard handling, or scripted/cross-document selection.

Exercise only the affected workflow in the fastest representative client. Do not
promote pure CSS hover or native selection properties to this level. Modify a test
only when the repository testing workflow approves it and the regression has a
stable behavioral assertion.

### Level 3 — structural or runtime verification

Use for shared primitive behavior, component replacement, dependencies,
listeners/portals/observers, production bundling, reader geometry or pagination,
or changes spanning several workflows.

Run the smallest targeted checks for the shared mechanism, plus only the build,
bundle, reader, or client checks that mechanism requires. Use a release client
only for known Tauri/WebView differences or when another applicable skill requires
it.

If a selected check cannot start, diagnose it once. Use cheaper evidence only when
it proves the same claim; otherwise report the unverified item. Do not repeat
builds or relaunch clients without a concrete reason.

## Completion

In the final response, name the changed surface, the verification performed, and
only material unverified workflows. Mention code, dependency, or runtime growth
only when it occurred.
