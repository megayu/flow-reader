# Repository Guidelines

## Project Structure

- App code lives in `src/`; `src/main.tsx` mounts the application from `src/app`.
- Tauri native shell and storage code lives in `src-tauri/`.
- `packages/epubjs` is the internal EPUB rendering engine.
- Node-level unit tests and pure source contracts live in `tests/unit/`; mocked browser integration tests live in `tests/integration/`; shared fixtures, mocks, and test runners live in `tests/support/`.
- Keep tests and test-only helpers under `tests/`, not `scripts/`.

## Commands

- `pnpm check` runs the standard web validation suite; `pnpm check:full` also runs the EPUB engine, Rust, and browser integration suites.
- `pnpm exec playwright test <spec> --grep <pattern>` - run matching integration test cases in the specified Playwright spec; omit `--grep` to run the whole spec. Set `PLAYWRIGHT_PORT` if 7127 is busy.
- `pnpm doctor:lines` - run after non-trivial React component/hook changes to catch render, hook, and state-flow issues on changed lines.
- `pnpm --filter @flow/epubjs test` - run the internal EPUB engine Vitest Browser Mode suite in headless Chromium.
- `pnpm rust:test` - run native storage/Tauri tests.

## Repository Skills

- Repository-specific skills live in `.agents/skills/`.
- Before changing browser-facing behavior that can differ between WebView2 and
  WebKit-family WebViews—including DOM events, focus, selection, iframe
  lifecycle or sandboxing, CSS capabilities or intrinsic sizing, geometry
  measurement, and asynchronous UI readiness—read
  `.agents/skills/cross-webview-compatibility/SKILL.md` and follow it.
- Before changing reader or library runtime performance—including tab switching, page turns, sidebar interactions, EPUB rendering, bookshelf virtualization, cover loading, filtering, sorting, scrolling, or reader/library switching—read `.agents/skills/reader-performance-measurement/SKILL.md` and follow it.
- Before changing deterministic reader layout, zoom, single/spread mode, tab isolation, sidebar/window resize behavior, iframe pane geometry, reader header/footer/page alignment, or generated content that can affect reader layout, read `.agents/skills/reader-deterministic-layout/SKILL.md` and follow it.

## Coding Style & Naming Conventions

- TypeScript-first; prefer `.ts` and `.tsx` files.
- Fix lint warnings instead of suppressing them unless the exception is documented.
- Components use PascalCase; hooks use camelCase with a `use` prefix.
- Code comments must explain durable behavior, constraints, or non-obvious decisions; never include session context, revision history.

## UI Guidelines

- Text inside UI controls, list rows, toolbar items, notifications, and similar interface elements should be vertically centered unless a design or functional requirement explicitly calls for another alignment.

## Localization Guidelines

- Every new or changed i18n key must include Simplified Chinese and English; other locales are optional. Write each idiomatically from the feature semantics rather than translating from the other.
- Insert every new i18n key in the position implied by its full key name, alongside the corresponding namespace and neighboring keys; do not append it at an arbitrary location.

## Testing Guidelines

- Use `msg(...)` for localized UI labels in tests; never hard-code them.
- Use `pnpm check` for standard web validation; it does not include EPUB engine or Rust checks.
- When the EPUB engine or native code is affected, separately run `pnpm check:epubjs` or `pnpm check:rust`, respectively.
- Integration tests are expensive: whenever possible, run only the cases relevant to the change, using spec paths and `--grep`. Run the full integration suite or `pnpm check:full` only when the impact cannot reasonably be narrowed or a full run is explicitly required.
- Use synthetic fixture text in tests; do not copy book text, user-provided context, or investigation-specific prose into test cases unless the exact text is required to reproduce a parser or encoding bug.
- Keep test fixtures platform-neutral. Do not use Windows- or Unix-specific drive letters, absolute paths, path separators, shell syntax, or other operating-system characteristics unless the test explicitly verifies platform-specific path handling or system integration.
- For reader rendering, selection, keyboard, layout, or performance-sensitive changes, use the repository skills above to choose the required client checks.

## Commit & Pull Request Guidelines

- Use Conventional Commits (`feat:`, `fix:`, `chore:`).
- Before committing, follow the validation scope in Testing Guidelines above.
- PRs should summarize UX changes and include screenshots or recordings for visual reader tweaks.
