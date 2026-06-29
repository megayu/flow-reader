# Flow Reader

Flow Reader is a local-first Tauri desktop reader for EPUB and TXT books.
It is based on [pacexy/flow](https://github.com/pacexy/flow) and has been
heavily reworked for the desktop app, native storage, TXT import, and reader
workflow used in this repository.

## Features

- Fast, smooth desktop reading with Tauri native storage, cached book state, and optimized page rendering.
- EPUB import with OS file-open support, plus TXT import with encoding detection, preview, and configurable chapter/group rules.
- Customizable library with cover sizing, sorting, batch delete, batch tagging, editable metadata, reading progress, and reading status.
- Three library filter groups: reading status, author, and tag, including pinned author/tag filters.
- Tabbed reader with split layout, restore-last-reading support, fullscreen, Zen mode, and quick switching between library and reader.
- Global and per-book typography controls for page view, alignment, zoom, font family, font size, weight, line height, and text indent.
- Theme system with accent color, background presets, custom background color, light/dark/system modes, and contrast options.
- Search tools for full-book search and current-chapter find, including selected-text find from the reader.
- Highlights, annotations, definitions, copy-as-Markdown, and a reusable text selection menu with optional right-click triggering.
- In-place text correction while reading, with export support for edited EPUB and TXT files.
- Image panel with illustration filtering, image gallery, preview, zoom, fit, and rotate controls.
- Keyboard shortcuts for navigation, tabs, display, panels, search, library filters, fullscreen, Zen mode.

## Project Structure

- `src/` - Next.js/React reader UI
- `src-tauri/` - Tauri shell, native commands, storage, import, and search
- `locales/` - application translations
- `packages/epubjs/` - vendored EPUB rendering engine

## Development

### Prerequisites

- [Node.js](https://nodejs.org)
- [pnpm](https://pnpm.io/installation)
- [Rust](https://www.rust-lang.org/tools/install)
- [Git](https://git-scm.com/downloads)

### Install

```bash
pnpm install
```

### Run

```bash
pnpm dev
```

The web UI starts at `http://localhost:7127`.

For the desktop shell:

```bash
pnpm tauri:dev
```

### Verify

```bash
pnpm lint
pnpm build
pnpm test:smoke
pnpm --filter @flow/epubjs test
cargo test --manifest-path src-tauri/Cargo.toml
```

## Credits

- [pacexy/flow](https://github.com/pacexy/flow)
- [Epub.js](https://github.com/futurepress/epub.js/)
- [Tauri](https://tauri.app/)
- [React](https://github.com/facebook/react)
- [Next.js](https://nextjs.org/)
- [TypeScript](https://www.typescriptlang.org)
