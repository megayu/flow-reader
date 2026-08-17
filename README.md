# Flow Reader

Flow Reader is a fast, smooth, and lightweight desktop reader for EPUB and TXT.
It is built for long, uninterrupted reading: the book stays visually dominant,
the interface remains compact, and frequent actions respond immediately without
breaking concentration.

Page turns are instant, switching among open books does not reload or
repaginate them, and full-book search returns results in milliseconds even for
books containing millions of characters. Work outside the current reading
context stays quiet, so large books, multiple tabs, and long sessions do not
make the app progressively heavier.

## Highlights

### Fast and smooth by design

- The library, every open book, and reading tools stay in one compact, tabbed
  window. Toggle between the library and current page or move among books by
  mouse, wheel, or shortcut, without opening extra windows or waiting for a
  reading view to reopen.
- Each book retains its exact page and layout while inactive. Tabs can be
  reordered by dragging and are ready the moment you return.
- Page content, chapter context, page number, and progress remain synchronized
  through rapid page turns, resizing, sidebar changes, and display adjustments.
- Every workflow is available by mouse, with shortcuts for frequent reading
  actions. Fullscreen and Zen mode remove the remaining interface when only the
  book matters.

### More EPUBs work as they should

- The maintained EPUB engine handles EPUB 2 and EPUB 3 navigation, reflowable
  and fixed-layout books, left-to-right and right-to-left reading order, and
  traditional vertical Chinese and Japanese text.
- Responsive single- and double-page views preserve page order, fixed-page
  placement, and the exact reading position as the reading area changes.
- Import repairs broken navigation and spine metadata, splits oversized
  single-file chapters, restores missing fixed-layout dimensions, and handles
  embedded fonts and archive paths that would otherwise fail on desktop.
- TXT import detects encoding and previews the resulting structure, with
  configurable rules for recognizing chapters and groups.

### Useful tools stay in the reading context

- Select text once to copy it, search the book, open a dictionary, translate,
  add a highlight and note, or save a definition.
- Search the complete book or use chapter find for the current section. Results
  open directly at the matching text.
- Combine online lookup with local StarDict and MDict dictionaries, listen with
  available system voices, and switch between Google and Azure translation
  without leaving the page.
- The illustration browser filters common decorative and duplicate assets by
  default, while still providing access to every image with preview, zoom, fit,
  and rotation controls.
- Correct visible EPUB and TXT text directly in the reader, then export the
  modified book separately from the original.

### The library and reading environment adapt to you

- Organize books by reading status, author, and tags; pin frequent filters; sort
  the library; see progress at a glance; edit metadata; and apply tags or
  deletion in batches.
- Start with a range of carefully balanced light and dark theme presets, or
  create your own from the background and accent colors. Changes appear
  immediately in the app and a live interface preview, making themes quick to
  compare and switch.
- Body-aware typography identifies the main reading text before applying font,
  size, weight, line height, indentation, and alignment. Distinctive typefaces,
  chapter headings, and other intentionally styled elements retain their
  character, so a carefully typeset book can be refined without flattening the
  publisher's design.
- Choose default page view and alignment, then adjust them for each book
  alongside zoom and unframed, card, book, or divider page appearances.
- Books, progress, annotations, and settings remain on the device.

## Project Structure

- `src/` - Vite/React reader UI
- `src-tauri/` - Tauri shell, native commands, storage, import, and search
- `packages/epubjs/` - internal EPUB rendering engine
- `tests/` - unit and browser integration tests

## Development

### Prerequisites

- [Node.js](https://nodejs.org/)
- [pnpm](https://pnpm.io/installation)
- [Rust](https://www.rust-lang.org/tools/install)
- [Tauri](https://v2.tauri.app/start/prerequisites/)

### Install

```bash
pnpm install
```

### Run

```bash
pnpm tauri:dev
```

### Verify

Run the source checks and production frontend build:

```bash
pnpm check
```

Run an individual test layer:

```bash
pnpm test:unit
pnpm test:integration
```

Run one Playwright spec:

```bash
pnpm exec playwright test tests/integration/app-shell.spec.ts
```

Run the complete browser, EPUB engine, and native quality and test suite:

```bash
pnpm check:full
```

### Build

Build the application without creating a distributable package:

```bash
pnpm tauri:build
```

Build the complete local-use package for the current platform. The result is moved to `release/`:

```bash
pnpm bundle:windows:installed
pnpm bundle:macos:installed
pnpm bundle:linux:installed
```

Windows produces an NSIS installer, macOS produces the application bundle, and Linux produces an AppImage. Tagged CI releases use separate release-shape stages so release-only capabilities can be enabled independently in the future.

## Credits

- [pacexy/flow](https://github.com/pacexy/flow)
- [epub.js](https://github.com/futurepress/epub.js/)
- [Tauri](https://tauri.app/)
- [React](https://github.com/facebook/react)
- [Vite](https://vite.dev/)
