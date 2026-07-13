# @flow/epubjs

Flow Reader's internal EPUB parser and renderer. The application consumes the
source in `src/` directly through the pnpm workspace; this package is not
published and does not produce a standalone distribution bundle.

The code originated from Epub.js and remains available under the BSD 2-Clause
license in `license`. It is maintained as part of Flow Reader and is not kept in
sync with the upstream project.

## Tests

The package suite runs in real headless Chromium using Vitest Browser Mode and
the Playwright provider. Install the matching browser after the first dependency
install or a Playwright upgrade:

```sh
pnpm exec playwright install chromium
```

Run the suite from the repository root:

```sh
pnpm --filter @flow/epubjs test
```

Use watch mode during development:

```sh
pnpm --filter @flow/epubjs test:watch
```

Test EPUBs, XHTML documents, stylesheets, and related resources live under
`test/fixtures/`.
