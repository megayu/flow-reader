# Repository Guidelines

## Project Structure

- App code lives in `src/`: pages in `src/pages`, UI in `src/components`, hooks in `src/hooks`, reader models in `src/models`, shared app state in `src/state.ts`.
- Translations live in `locales/`.
- Tauri native shell and storage code lives in `src-tauri/`.
- Workspace packages live in `packages/`; currently `packages/epubjs` is the vendored reader engine.
- Desktop icons live in `src-tauri/icons/`; Tauri permissions live in `src-tauri/capabilities/`.

## Commands

- `pnpm install` - install dependencies after checkout or lockfile/package changes.
- `pnpm dev` - run the Next.js app on port 7127.
- `pnpm tauri:dev` - run the desktop app with devtools enabled.
- `pnpm lint` - run ESLint across app, locale, script, repository skill, and test files.
- `pnpm build` - run the production Next.js build.
- `pnpm check` - run theme/reader optimization tests, lint, and build.
- `pnpm test:smoke` - run the app smoke suite.
- `pnpm exec playwright test <spec>` - run targeted Playwright tests; set `PLAYWRIGHT_PORT` if 7127 is busy.
- `pnpm doctor:lines` - run after non-trivial React component/hook changes to catch render, hook, and state-flow issues on changed lines.
- `pnpm --filter @flow/epubjs test` - run the vendored EPUB engine Karma/Mocha suite; Chrome headless is required.
- `cargo test --manifest-path src-tauri/Cargo.toml` - run native storage/Tauri tests.

## Repository Skills

- Repository-specific skills live in `.agents/skills/`.
- Before changing reader runtime performance, tab switching, page turns, sidebar reader interactions, annotation/definition overlays, EPUB rendering, or generated content that can affect pagination cost, read `.agents/skills/reader-performance-measurement/SKILL.md` and follow it.
- Before changing deterministic reader layout, zoom, single/spread mode, tab isolation, sidebar/window resize behavior, iframe pane geometry, reader header/footer/page alignment, or generated content that can affect reader layout, read `.agents/skills/reader-deterministic-layout/SKILL.md` and follow it.

## Coding Style & Naming Conventions

- TypeScript-first; prefer `.ts` and `.tsx` files.
- Prettier enforces 2-space indentation, single quotes, trailing commas, and no semicolons (`prettier.config.js`).
- ESLint extends Next.js defaults; fix warnings instead of suppressing unless documented.
- Components use PascalCase, hooks use camelCase with a `use` prefix, route files follow path-based kebab-case.
- Code comments must explain durable behavior, constraints, or non-obvious decisions; never include session context, revision history.

## Testing Guidelines

- Prefer targeted automated checks for changed behavior: Playwright for UI flows, `pnpm lint` for TS/React rules, `pnpm build` for production type/build coverage.
- For reader rendering, selection, keyboard, layout, or performance-sensitive changes, use the repository skills above to choose the required client checks.

## Commit & Pull Request Guidelines

- Use Conventional Commits (`feat:`, `fix:`, `chore:`).
- Run the smallest relevant checks before committing; use `pnpm check` or `pnpm check:full` for broader validation.
- PRs should summarize UX changes and include screenshots or recordings for visual reader tweaks.
