const BOOK_CHAPTERS = 24
const BOOK_PARAGRAPHS = 10

export function createRenderAuditBooks(count = 3) {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error('render audit book count must be positive')
  return Array.from({ length: count }, (_, index) => {
    const name = index < 3 ? String.fromCharCode(65 + index) : String(index + 1).padStart(2, '0')
    return {
      id: `flow-render-${name.toLowerCase()}`,
      name: `FLOW_RENDER_${name}.epub`,
      size: BOOK_CHAPTERS * BOOK_PARAGRAPHS * 512,
      scope: 'library',
      sourceFormat: 'epub',
      generatedCover: true,
      sourceHash: `flow-render-${name.toLowerCase()}`,
      sourceRevision: 1,
      revision: 1,
      editable: false,
      managed: true,
      sourcePath: `FLOW_RENDER_${name}.epub`,
      metadata: {
        title: `Flow Render ${name}`,
        creator: 'Flow Render Audit',
        language: 'en-US',
      },
      createdAt: index + 1,
      updatedAt: index + 1,
      cfi: 'chapter_001.xhtml',
      definitions: [],
      annotations: [],
      packageUrl: `/flow-render/${name}/OPS/package.opf`,
      renderPrefix: `FLOW-RENDER-${name}`,
    }
  })
}

function renderBookResource(pathname, book) {
  const normalized = pathname.replace(/^\/flow-render\/[^/]+\/OPS\//, '')
  const chapterMatch = /^chapter_(\d{3})\.xhtml$/.exec(normalized)

  if (normalized === 'package.opf') {
    const manifest = Array.from({ length: BOOK_CHAPTERS }, (_, index) => {
      const number = String(index + 1).padStart(3, '0')
      return `<item id="chapter_${number}" href="chapter_${number}.xhtml" media-type="application/xhtml+xml"/>`
    }).join('\n')
    const spine = Array.from({ length: BOOK_CHAPTERS }, (_, index) => {
      const number = String(index + 1).padStart(3, '0')
      return `<itemref linear="yes" idref="chapter_${number}"/>`
    }).join('\n')

    return {
      contentType: 'application/oebps-package+xml',
      body: `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="pub-id">${book.id}</dc:identifier>
    <dc:title>${book.metadata.title}</dc:title>
    <dc:creator>Flow Render Audit</dc:creator>
    <dc:language>en-US</dc:language>
    <meta property="dcterms:modified">2026-09-05T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="toc" properties="nav" href="toc.xhtml" media-type="application/xhtml+xml"/>
    <item id="style" href="style.css" media-type="text/css"/>
    ${manifest}
  </manifest>
  <spine>${spine}</spine>
</package>`,
    }
  }

  if (normalized === 'toc.xhtml') {
    const items = Array.from({ length: BOOK_CHAPTERS }, (_, index) => {
      const number = String(index + 1).padStart(3, '0')
      return `<li><a href="chapter_${number}.xhtml">${book.renderPrefix}-${number}</a></li>`
    }).join('\n')
    return {
      contentType: 'application/xhtml+xml',
      body: `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
  <head><title>${book.metadata.title}</title></head>
  <body><nav epub:type="toc"><ol>${items}</ol></nav></body>
</html>`,
    }
  }

  if (normalized === 'style.css') {
    return { contentType: 'text/css', body: 'body{font-family:serif}p{margin:1em 0}' }
  }

  if (chapterMatch) {
    const number = String(Number(chapterMatch[1])).padStart(3, '0')
    const paragraphs = Array.from({ length: BOOK_PARAGRAPHS }, (_, index) => {
      const marker = `${book.renderPrefix}-${number}-${String(index).padStart(2, '0')}`
      return `<p>${marker} deterministic synthetic reader content for render measurement. ${marker} ${marker}</p>`
    }).join('\n')
    return {
      contentType: 'application/xhtml+xml',
      body: `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head><title>${book.renderPrefix}-${number}</title><link rel="stylesheet" href="style.css" type="text/css"/></head>
  <body><section><h1>${book.renderPrefix}-${number}</h1>${paragraphs}</section></body>
</html>`,
    }
  }
}

export async function installRenderAuditFixture(context, books) {
  await context.route('**/flow-render/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname
    const book = books.find((candidate) =>
      pathname.startsWith(candidate.packageUrl.slice(0, candidate.packageUrl.lastIndexOf('/') + 1)),
    )
    const resource = book ? renderBookResource(pathname, book) : undefined
    if (!resource) {
      await route.fulfill({ status: 404, contentType: 'text/plain', body: 'not found' })
      return
    }
    await route.fulfill(resource)
  })

  await context.addInitScript((fixtureBooks) => {
    const globalWindow = window
    const bookStore = new Map(fixtureBooks.map((book) => [book.id, book]))
    const settingsStore = { locale: 'en-US', showRecentBooks: false, enableTextSelectionMenu: true }
    let nextCallbackId = 1
    let nextEventId = 1
    const internals = (globalWindow.__TAURI_INTERNALS__ ??= {})
    const eventInternals = (globalWindow.__TAURI_EVENT_PLUGIN_INTERNALS__ ??= {})
    const callbacks = (internals.callbacks ??= {})

    globalWindow.__FLOW_RENDER_AUDIT__ = { bookStore, settingsStore }
    internals.metadata = {
      currentWebview: { label: 'main' },
      currentWindow: { label: 'main' },
    }
    internals.convertFileSrc = (filePath) => filePath
    internals.transformCallback = (callback) => {
      const id = nextCallbackId++
      callbacks[id] = callback
      return id
    }
    internals.unregisterCallback = (id) => delete callbacks[id]
    internals.runCallback = (id, ...args) => callbacks[id]?.(...args)
    eventInternals.unregisterListener = () => undefined
    internals.invoke = async (command, args = {}) => {
      if (command === 'get_window_ui_state') {
        return {
          readerSidebarOpen: false,
          readerSidebarWidth: 260,
          librarySidebarOpen: false,
          librarySidebarWidth: 260,
          panes: {},
        }
      }
      if (command === 'get_settings') {
        return {
          settings: { ...settingsStore },
          textImportRuleDefaults: { groupPatterns: [], chapterPatterns: [], filenamePatterns: [] },
        }
      }
      if (command === 'update_settings') {
        Object.assign(settingsStore, args.settings ?? {})
        return null
      }
      if (command === 'list_books') return Array.from(bookStore.values())
      if (command === 'list_tags') return []
      if (command === 'get_library_pins') return { authors: [], tags: [] }
      if (command === 'get_recent_book_ids') return []
      if (command === 'get_book') return bookStore.get(String(args.id)) ?? null
      if (command === 'update_book') {
        const id = String(args.id)
        const current = bookStore.get(id)
        if (!current) return null
        const updated = { ...current, ...(args.changes ?? {}) }
        bookStore.set(id, updated)
        return updated
      }
      if (command === 'list_covers') return []
      if (command === 'get_cover') return null
      if (command === 'get_book_package_path') return bookStore.get(String(args.id))?.packageUrl ?? ''
      if (command === 'get_book_reader_source') {
        return { mode: 'opf', path: bookStore.get(String(args.id))?.packageUrl ?? '' }
      }
      if (command === 'take_pending_open_paths') return []
      if (command === 'flush_storage' || command === 'set_book_cache_active') return null
      if (command === 'search_book_text') return []
      if (command === 'list_system_fonts') return []
      if (command === 'plugin:event|listen') return nextEventId++
      if (command === 'plugin:event|unlisten') return null
      if (command.startsWith('plugin:window|is_')) return false
      if (command.startsWith('plugin:window|') || command.startsWith('plugin:webview|')) return null
      return null
    }
  }, books)
}
