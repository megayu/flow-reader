# Flow Reader EPUB Engine

## Origin and License

`@flow/epub-engine` is derived from FuturePress's **epub.js**. Flow Reader maintains this fork independently, with application-specific APIs, a reduced feature set, and a TypeScript implementation. It is not a drop-in replacement for upstream epub.js.

The original FuturePress copyright notice and BSD-2-Clause license are retained in [license](./license). Upstream issue and pull-request links in source comments preserve the context of inherited fixes. Internal DOM markers use the `flow-epub-` prefix, while `navigator.epubReadingSystem` reports `Flow Reader EPUB Engine` and the package version.

## Scope

This package is Flow Reader's internal EPUB engine. Its scope follows the capabilities used by the application and the engine's internal call chains; it does not preserve the full upstream epub.js API. Horizontal and vertical text, RTL page progression, fixed layouts, and continuous scrolling are supported reading modes.

## Engine and Application Boundaries

- TypeScript in `src/` owns EPUB parsing, sections and resources, CFI, pagination, iframe layout, zoom adaptation, annotation rendering, and the lifecycle of these objects.
- Package entry points expose types derived from the TypeScript implementation. `public-rendition.ts` restricts the application to the reader contract; managers, queues, request counters, and view pagination internals remain private to the engine. There are no separately maintained implementation declarations.
- Application TypeScript owns reading preferences, content styling policy, editing and dictionary workflows, UI snapshots, history, and persistence. Application layout transactions coordinate container dimensions and UI commits; the engine executes the layout operations within those transactions.

Create and attach a rendering session with `await book.renderTo(element, options)`. Use `rendition.session` for reading operations:

```ts
const operation = rendition.session.display(target)
const location = await operation.finished
```

The engine generates `requestId`, which the application can use to associate an operation with its UI and persistence intent. `finished` returns the location after location reporting completes, resolves to `undefined` when a later request supersedes the operation or the session closes, and rejects on failure. The application does not modify request IDs or invoke manager operations, view pagination caches, or location reporting steps directly.

`refreshSection(section)` handles view layout and location reporting after a content edit. `Section.invalidateRender()` makes the next load read the updated content while retaining the document used by active views. The application clears only its own derived caches, such as search and body text detection caches.

`captureSpread()` determines the spread restoration anchor and reading order. The application converts the result into a record with a storage version and style signature. `layout` and `currentSpread` return descriptors. `ReaderView` exposes the information needed for content extensions and overlays, without exposing view size expansion or pagination cache operations.

## Internal Responsibilities

| Module | Owned state and operations |
| --- | --- |
| `reader-session.ts` | Application operations, completion results, and cancellation on session close |
| `rendition.ts` | Rendering queue, request validity, location events, and extension hooks |
| `managers/default/index.ts` | View collection, pagination across sections, scrolling, and layout state |
| `managers/helpers/section-measurements.ts` | Section page count caches and temporary measurement views |
| `managers/views/iframe.ts` | Loading, layout, sizing, and cleanup of an individual iframe |
| `content-zoom.ts` | Physical dimensions, media constraints, and WebKit adaptation during zoom |
| `page-backgrounds.ts` | Background adaptation, original style restoration, image size caches, and pending image callbacks |
| `managers/helpers/annotation-marks.ts` | Underline shapes and geometry calculations |

`Book.destroy()` closes the rendering session before releasing sections and resources. Closing a rendering session stops its queue, invalidates older location reports, removes hooks and event listeners, and destroys its views, themes, and annotation state. A queue task failure rejects that operation while allowing later tasks to execute. Synchronous hook exceptions and asynchronous rejections follow the same failure contract.

## Verification

Browser tests in `test/` and `vitest.config.ts` are TypeScript. `pnpm check:epub-engine` runs the browser cases and strictly type-checks the engine, test fixtures and mocks, and runner configuration together. `pnpm --filter @flow/epub-engine typecheck` runs only the type check. Application type checking validates the package entry points through real imports and usage.

Run `pnpm check` for application boundary changes and `pnpm check:epub-engine` for engine changes. Changes involving layout, iframes, or lifecycle also require the relevant browser cases and compiled client verification described by the repository skills. Before removing a capability, inspect application calls, engine internals, events, hooks, type declarations, and dedicated tests.
