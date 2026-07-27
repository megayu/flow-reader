import fs from 'node:fs'
import path from 'node:path'
import { chromium } from '@playwright/test'

const CDP_URL = process.env.FLOW_READER_CDP_URL ?? 'http://127.0.0.1:9351'
const DATA_DIR =
  process.env.FLOW_READER_DATA_DIR ??
  path.join(process.cwd(), 'test-results', 'external-epub-promotion-data')
const OUT_DIR =
  process.env.FLOW_READER_EXTERNAL_EPUB_OUT_DIR ??
  path.join(process.cwd(), 'test-results', 'external-epub-promotion-client')

function assert(condition, message, detail) {
  if (!condition) {
    const error = new Error(message)
    error.detail = detail
    throw error
  }
}

async function invoke(page, command, args = {}) {
  return page.evaluate(
    ({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args),
    { command, args },
  )
}

async function waitForRenderedFocusedBook(page, id) {
  await page.waitForFunction(
    (id) => {
      const tab = window.reader.focusedBookTab
      return (
        tab?.book?.id === id &&
        tab.iframes?.some(
          (win) => (win.document?.body?.innerText ?? '').trim().length > 0,
        )
      )
    },
    id,
    { timeout: 30000 },
  )
}

function testAnnotation(bookId) {
  return {
    id: 'client-annotation',
    bookId,
    cfi: 'epubcfi(/6/4!/4/2)',
    spine: {
      index: 0,
      href: 'chapter_001.xhtml',
      title: 'Client chapter',
    },
    createAt: 1,
    updatedAt: 1,
    type: 'highlight',
    color: 'yellow',
    text: 'note',
  }
}

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function assertPromotedOnDisk({
  imported,
  external,
  expectedTitle,
  expectedCfi,
}) {
  const bookDir = path.join(DATA_DIR, 'books', imported.id)
  assert(imported.scope === 'library', 'imported book is not a library book', {
    imported,
  })
  assert(
    imported.id !== external.id,
    'external id was reused for library book',
    {
      imported,
      external,
    },
  )
  assert(
    fs.existsSync(path.join(bookDir, 'book.epub')),
    'library EPUB is missing',
    {
      bookDir,
    },
  )
  assert(
    !fs.existsSync(path.join(DATA_DIR, 'external-books', external.id)),
    'external book directory still exists',
    { external },
  )

  const externalIndex = readJson(
    path.join(DATA_DIR, 'external-books', 'index.json'),
    { books: [] },
  )
  assert(
    Array.isArray(externalIndex.books) && externalIndex.books.length === 0,
    'external index still has books',
    externalIndex,
  )

  const metadata = readJson(path.join(bookDir, 'metadata.json'), {})
  assert(metadata.title === expectedTitle, 'metadata title was not migrated', {
    metadata,
    expectedTitle,
  })
  assert(
    metadata.clientPromotionMarker === 'kept',
    'metadata marker was lost',
    {
      metadata,
    },
  )

  const state = readJson(path.join(bookDir, 'state.json'), {})
  if (expectedCfi) {
    assert(state.cfi === expectedCfi, 'state cfi was not migrated', {
      state,
      expectedCfi,
    })
  } else {
    assert(typeof state.cfi === 'string' && state.cfi, 'state cfi is missing', {
      state,
    })
  }
  assert(
    typeof state.percentage === 'number',
    'state percentage was not migrated',
    state,
  )
  assert(
    Array.isArray(state.definitions) &&
      state.definitions.includes('client-term'),
    'definitions were not migrated',
    state,
  )
  assert(
    Array.isArray(state.annotations) &&
      state.annotations.some(
        (item) =>
          item.id === 'client-annotation' && item.bookId === imported.id,
      ),
    'annotations were not migrated to the library book id',
    state,
  )
  assert(
    state.configuration?.theme === 'sepia',
    'configuration was not migrated',
    {
      state,
    },
  )
}

async function createExternal(page, epubPath, title, cfi) {
  const openResult = await invoke(page, 'open_external_epub_paths', {
    paths: [epubPath],
  })
  assert(
    openResult.failures.length === 0,
    'open external EPUB failed',
    openResult,
  )
  const external = openResult.books[0]
  assert(
    external?.scope === 'external',
    'open did not create an external book',
    {
      openResult,
    },
  )

  const updated = await invoke(page, 'update_book', {
    id: external.id,
    changes: {
      metadata: {
        ...(external.metadata ?? {}),
        title,
        clientPromotionMarker: 'kept',
      },
      cfi,
      percentage: 0.42,
      definitions: ['client-term'],
      annotations: [testAnnotation(external.id)],
      configuration: { theme: 'sepia', spread: { page: 2 } },
    },
  })
  assert(
    updated?.id === external.id,
    'external update did not return the book',
    {
      updated,
      external,
    },
  )
  await invoke(page, 'flush_storage')
  return updated
}

async function importAndVerify(page, external, epubPath, title, cfi) {
  const importResult = await invoke(page, 'import_epub_paths', {
    paths: [epubPath],
    replaceExisting: true,
    importId: null,
  })
  assert(importResult.failures.length === 0, 'import EPUB failed', importResult)
  const imported = importResult.books[0]
  assert(imported?.id, 'import did not return a book', importResult)

  await page.evaluate(
    (books) => window.reader.promoteExternalBooks(books),
    [imported],
  )
  await invoke(page, 'flush_storage')

  const tabState = await page.evaluate(
    ({ contentHash, externalId }) => {
      const tabs = window.reader.groups.flatMap((group) => group.bookTabs)
      return {
        matchingLibraryTabs: tabs.filter(
          (tab) =>
            tab.book.scope === 'library' &&
            tab.book.contentHash === contentHash,
        ).length,
        externalTabs: tabs.filter((tab) => tab.book.id === externalId).length,
        tabIds: tabs.map((tab) => tab.book.id),
      }
    },
    { contentHash: imported.contentHash, externalId: external.id },
  )
  assert(
    tabState.matchingLibraryTabs <= 1,
    'promotion created duplicate tabs',
    {
      tabState,
    },
  )
  assert(tabState.externalTabs === 0, 'external tab remained after promotion', {
    tabState,
  })

  assertPromotedOnDisk({
    imported,
    external,
    expectedTitle: title,
    expectedCfi: cfi,
  })

  const loaded = await invoke(page, 'get_book', { id: imported.id })
  assert(loaded?.scope === 'library', 'promoted book cannot be loaded', loaded)
  assert(
    loaded.metadata?.title === title,
    'loaded book metadata is stale',
    loaded,
  )
  if (cfi) assert(loaded.cfi === cfi, 'loaded book state is stale', loaded)
  return imported
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  assert(
    fs.existsSync(DATA_DIR),
    'data dir does not exist; launch Tauri with it',
    {
      DATA_DIR,
    },
  )

  const browser = await chromium.connectOverCDP(CDP_URL)
  const context = browser.contexts()[0]
  const page =
    context
      .pages()
      .find((candidate) => candidate.url().includes('localhost:7127')) ??
    context.pages()[0]

  await page.waitForFunction(
    () =>
      Boolean(
        window.__TAURI_INTERNALS__?.invoke &&
        window.reader &&
        document.querySelector('#layout'),
      ),
    null,
    { timeout: 30000 },
  )

  const openPath = path.join(
    process.cwd(),
    'packages',
    'epubjs',
    'test',
    'fixtures',
    'alice.epub',
  )
  const closedPath = path.join(
    process.cwd(),
    'packages',
    'epubjs',
    'test',
    'fixtures',
    'alice_without_cover.epub',
  )

  const openExternal = await createExternal(
    page,
    openPath,
    'Client Open Promotion',
    'epubcfi(/6/4!/4/2)',
  )
  await page.evaluate((book) => {
    window.reader.closeAllTabs?.()
    window.reader.addTab(book)
  }, openExternal)
  await waitForRenderedFocusedBook(page, openExternal.id)
  const openImported = await importAndVerify(
    page,
    openExternal,
    openPath,
    'Client Open Promotion',
    undefined,
  )
  await waitForRenderedFocusedBook(page, openImported.id)

  await page.evaluate(() => window.reader.closeAllTabs?.())
  const closedExternal = await createExternal(
    page,
    closedPath,
    'Client Closed Promotion',
    'epubcfi(/6/6!/4/2)',
  )
  await invoke(page, 'cleanup_external_book', { id: closedExternal.id })
  await importAndVerify(
    page,
    closedExternal,
    closedPath,
    'Client Closed Promotion',
    'epubcfi(/6/6!/4/2)',
  )

  fs.writeFileSync(
    path.join(OUT_DIR, 'result.json'),
    JSON.stringify(
      {
        dataDir: DATA_DIR,
        openImportedId: openImported.id,
        closedExternalId: closedExternal.id,
      },
      null,
      2,
    ),
  )

  await browser.close()
}

main().catch((error) => {
  console.error(error)
  if (error.detail) console.error(JSON.stringify(error.detail, null, 2))
  process.exit(1)
})
