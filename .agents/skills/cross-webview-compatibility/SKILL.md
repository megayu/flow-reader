---
name: cross-webview-compatibility
description: >-
  Use before changing Flow Reader browser-facing behavior at boundaries that may
  differ between WebView2 and WebKit-family WebViews: DOM events, focus,
  selection, iframe lifecycle or sandboxing, CSS capabilities or intrinsic
  sizing, geometry, and asynchronous UI readiness. Exclude pure business logic,
  storage, native-only code, and engine-independent styling.
---

# Cross-WebView Compatibility

Use this skill during design and implementation, before a platform defect exists.
Its purpose is to keep Chromium-only assumptions out of code that also runs in
macOS WKWebView or Linux WebKitGTK.

Also use `reader-deterministic-layout` when the change affects pagination, reader
geometry, layout transactions, iframe sizing, compositing, or committed reader
snapshots. Keep incident narratives in that skill's failure-pattern reference.

Before changing events, focus, sandboxing, selection, clipboard behavior,
intrinsic sizing, vertical pagination, asynchronous reader state, or test
assertions, read only the matching section of
[confirmed engine patterns](references/confirmed-engine-patterns.md).

## Development Rules

### Preserve shared invariants

- Select behavior by observable capability, such as `CSS.supports` or API
  presence, rather than user agent or operating system. Standard and prefixed
  implementations may be different models; preserve the same user-visible,
  physical invariant and audit every consumer of the affected capability.
- Define callback freshness, event-document ownership, listener lifetime, and
  overlay ordering separately. Do not mask an ownership or timing defect with
  forced focus, duplicate listeners, synthetic replacement events, retries, or
  engine-specific delays.
- Treat sandbox changes as security changes. Preserve script blocking through an
  independently enforced policy that covers every serialized document shape.
- Measure the rendered physical invariant, not a convenient engine-specific
  property. Preserve intrinsic sizing and wait for the complete set of in-flight
  operations at stable-state boundaries.
- Prefer the smallest deterministic production correction that expresses the
  shared invariant. A broad speculative diff is evidence to recheck the
  diagnosis.

## Verification Workflow

1. Prefer an existing focused integration scenario unchanged. If none covers the
   risk, follow the repository testing policy before adding one. Run the same
   scenario in the configured Chromium and Playwright WebKit projects.
2. Trace the changed mechanism to its direct consumers and choose the smallest
   relevant scenario set that exercises the corrected state and those consumers.
   Run that same set in both engines. Do not include unrelated specs merely
   because they share the integration suite.
3. Treat Chromium-green/WebKit-red as compatibility evidence until a small
   standalone reproduction or confirmed upstream issue proves a driver or
   browser limitation. Trace the first divergent production state.
4. Make one small production-code correction. Do not weaken assertions or create
   an engine-specific test path to obtain a pass.
5. Re-run the focused scenario and the affected scenario set in both projects.
   Run the complete integration suite only when the change affects shared
   cross-cutting infrastructure used broadly by the suite, the impact boundary
   cannot be established from code and focused evidence, focused failures reveal
   a wider blast radius, or the user explicitly requests it. Isolated annotation
   geometry, one overlay, or one selection action does not justify unrelated
   library, import, settings, or dictionary scenarios.
6. Use a real Tauri client for final claims about WKWebView, WebView2,
   WebKitGTK, native menus, compositor behavior, or desktop window integration.
   Playwright WebKit is a strong development proxy for WebKit differences, not a
   substitute for the system WKWebView binary.

## Completion Report

State why the selected scenarios match the changed mechanism, which engines and
evidence levels ran, their exact pass/fail totals, any test-identity changes,
which broader suites were intentionally omitted, and the remaining real-client
gap. Do not describe a Playwright WebKit pass as proof that macOS WKWebView was
exercised.
