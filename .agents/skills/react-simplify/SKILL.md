---
name: react-simplify
description: Review or simplify React code with unnecessary hooks, state, effects, memoization, refs, and reactive complexity. Use after React changes or when explicitly requested. This is static code-quality work, not runtime performance profiling.
---

# React Simplification

Reduce React-specific complexity while preserving observable behavior. Prefer
simpler ownership and data flow, not a lower hook count by itself.

## Scope and project gates

Review the final React diff and directly relevant consumers. Audit the whole
repository only when explicitly requested. Include pure TypeScript only when it
participates in React state ownership or reactive identity.

Before changing reader or library runtime mechanics, apply
[reader-performance-measurement](../reader-performance-measurement/SKILL.md)
and honor matching performance-history decisions. Also apply
[reader-deterministic-layout](../reader-deterministic-layout/SKILL.md) when
pagination, geometry, iframe sizing, or layout transaction timing can change.

## Review

1. Trace each candidate from its source through derivation, effects, events, and
   consumers.
2. Check for:
   - state setters called during render
   - render-derivable, duplicated, or manually synchronized state and refs
   - internal derivation effects and avoidable update chains
   - prop-keyed resets better owned by keyed children
   - mutually exclusive booleans better represented by discriminated state
   - state lifted above its persistence boundary
   - custom hooks or abstractions without meaningful reuse or isolation
3. Classify effects before removing them. Treat derivation and normalization as
   candidates; treat DOM/iframe/browser APIs, subscriptions, timers, async work,
   persistence, focus, measurement, and resource lifetime as external
   synchronization.
4. Before changing `useMemo`, `useCallback`, refs, or dependency arrays, inspect
   all identity consumers: effects, contexts, memoized children, subscriptions,
   caches, and imperative APIs.

## Rules and guards

- Preserve reset timing, hidden-view persistence, same-tick semantics, and
  resource lifetime. If simplification requires a product decision, retain the
  code and report the decision instead of guessing.
- Prefer deletion and direct ownership; do not create hooks merely to make a
  component smaller or change memoization for speculative rerenders.
- Do not flag IME/edit drafts, debounce/throttle state, cancellable async state,
  DOM measurement, external subscriptions, same-tick imperative refs, or stable
  context/cache/index inputs merely because they use hooks.
- Use `useEffectEvent` only for effect-installed callbacks that need current
  reactive values. Do not use it for UI handlers or to hide dependencies.
- Preserve `useFrameEvent` listener refs: replacing them with Effect Events
  regressed measured rapid reader interactions. Retry only with new matched
  performance evidence.
- Do not make runtime performance claims from static analysis.

## Verify and report

After changes, repeat this review on the final diff and run formatting, type
checking, and the smallest relevant existing behavior checks. Follow selected
performance or layout skills when their gates require it.

Report meaningful results as fixed, intentionally retained, or unresolved. For
unresolved findings, include priority, confidence, behavior risk, and the
decision or evidence required. Do not report hook counts or speculative
performance improvements as outcomes.
