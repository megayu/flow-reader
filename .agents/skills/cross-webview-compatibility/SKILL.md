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
2. Treat Chromium-green/WebKit-red as compatibility evidence until a small
   standalone reproduction or confirmed upstream issue proves a driver or
   browser limitation. Trace the first divergent production state.
3. Make one small production-code correction. Do not weaken assertions or create
   an engine-specific test path to obtain a pass.
4. Re-run the focused scenario, then the complete integration suite, in both
   projects. Compare exact test identities as well as totals. Record which prior
   failures recovered and explain their shared production path before grouping
   them under one cause.
5. Use a real Tauri client for final claims about WKWebView, WebView2,
   WebKitGTK, native menus, compositor behavior, or desktop window integration.
   Playwright WebKit is a strong development proxy for WebKit differences, not a
   substitute for the system WKWebView binary.

## Completion Report

State which engines and evidence levels ran, their exact pass/fail totals, any
test-identity changes, and the remaining real-client gap. Do not describe a
Playwright WebKit pass as proof that macOS WKWebView was exercised.
