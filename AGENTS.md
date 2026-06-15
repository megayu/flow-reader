# Repository Guidelines

## Project Structure & Module Organization

- Single Next.js reader app at the repository root.
- App source lives in `src/`; pages are in `src/pages`, reusable UI is in `src/components`, hooks are in `src/hooks`, and reader state/models are in `src/models` and `src/state.ts`.
- Translations live in `locales/`; static assets and install metadata live in `public/`.
- Workspace packages remain under `packages/`: `packages/epubjs` for the vendored reader engine and `packages/tailwind` for the Tailwind preset.
- Root configs (`next.config.js`, `tsconfig.json`, `tailwind.config.js`, `prettier.config.js`) govern the app directly.

## Build, Test, and Development Commands

- `pnpm install` - bootstrap dependencies; rerun after updating workspace packages.
- `pnpm dev` - launch the local reader on port 7127 with hot reload.
- `pnpm build` - run the production Next.js build.
- `pnpm lint` - run Next.js ESLint checks.
- `pnpm --filter @flow/epubjs test` - execute the Karma/Mocha suite for the vendored engine; Chrome headless is required.

## Coding Style & Naming Conventions

- TypeScript-first; prefer `.ts` and `.tsx` files.
- Prettier enforces 2-space indentation, single quotes, trailing commas, and no semicolons (`prettier.config.js`).
- ESLint extends Next.js defaults; fix warnings instead of suppressing unless documented.
- Components use PascalCase, hooks use camelCase with a `use` prefix, route files follow path-based kebab-case.

## Testing Guidelines

- UI work relies on manual verification through `pnpm dev`; note smoke steps for reader changes until automated tests land.
- Write descriptive test names, for example `should render highlights menu`, and keep them deterministic across browsers.

## Commit & Pull Request Guidelines

- Use Conventional Commits (`feat:`, `fix:`, `chore:`).
- PRs should summarize UX changes and attach screenshots or recordings for reader tweaks.
- Run `pnpm build`, `pnpm lint`, and targeted tests before opening a PR; call out known gaps or platform caveats.
