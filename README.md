# Flow Reader

Local-first ePub reader based on Next.js and a vendored ePub.js package.

## Features

- Grid reader layout
- Local library import/export
- Search in book
- Image preview
- Custom typography
- Highlights and annotations
- Theme settings
- Open ePub files from local disk or URL

## Project Structure

- `src/` - Next.js reader application source
- `locales/` - application translations
- `public/` - static assets and install metadata
- `packages/epubjs/` - vendored ePub rendering engine
- `packages/tailwind/` - shared Tailwind preset

## Development

### Prerequisites

- [Node.js](https://nodejs.org)
- [pnpm](https://pnpm.io/installation)
- [Git](https://git-scm.com/downloads)

### Install

```bash
pnpm install
```

### Run

```bash
pnpm dev
```

The reader starts at `http://localhost:7127`.

### Verify

```bash
pnpm lint
pnpm build
pnpm --filter @flow/epubjs test
```

## Credits

- [Epub.js](https://github.com/futurepress/epub.js/)
- [React](https://github.com/facebook/react)
- [Next.js](https://nextjs.org/)
- [TypeScript](https://www.typescriptlang.org)
