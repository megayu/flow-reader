import path from 'node:path'

import { expect, test, type Page } from '@playwright/test'

import type { BookRecord } from '../src/db'

const aliceEpubPath = path.resolve('packages/epubjs/test/fixtures/alice.epub')
const alicePackageUrl = '/test-assets/alice.epub'
const longPackageUrl = '/test-assets/long/OPS/package.opf'

function createBook(id: string, title: string): BookRecord {
  return {
    id,
    name: `${title}.epub`,
    size: 128000,
    metadata: {
      title,
      creator: 'Lewis Carroll',
      language: 'en',
    },
    createdAt: 1,
    updatedAt: 1,
    cfi: 'chapter_001.xhtml',
    definitions: [],
    annotations: [],
    stateLoaded: true,
  } as BookRecord
}

async function installReaderBooksMock(
  page: Page,
  titles = ['Tab Layout A', 'Tab Layout B', 'Tab Layout C'],
  packageUrl = alicePackageUrl,
) {
  const books = titles.map((title, index) =>
    createBook(`tab-layout-${String.fromCharCode(97 + index)}`, title),
  )

  if (packageUrl === alicePackageUrl) {
    await page.route(`**${alicePackageUrl}`, (route) =>
      route.fulfill({
        path: aliceEpubPath,
        contentType: 'application/epub+zip',
      }),
    )
  } else {
    await installLongBookRoutes(page)
  }

  await page.addInitScript(
    ({ fixtureBooks, packageUrl }) => {
      type TauriInternals = {
        callbacks?: Record<number, (...args: unknown[]) => unknown>
        convertFileSrc?: (filePath: string) => string
        invoke?: (command: string, args?: Record<string, unknown>) => unknown
        metadata?: {
          currentWebview: { label: string }
          currentWindow: { label: string }
        }
        runCallback?: (id: number, ...args: unknown[]) => unknown
        transformCallback?: (
          callback: (...args: unknown[]) => unknown,
        ) => number
        unregisterCallback?: (id: number) => void
      }
      type TauriEventInternals = {
        unregisterListener?: (event: string, eventId: number) => void
      }

      const globalWindow = window as typeof window & {
        __TAURI_EVENT_PLUGIN_INTERNALS__?: TauriEventInternals
        __FLOW_TEST_TAURI__?: {
          settingsStore: Record<string, unknown>
        }
        __TAURI_INTERNALS__?: TauriInternals
      }
      const bookStore = new Map<string, BookRecord>(
        fixtureBooks.map((book) => [book.id, book]),
      )
      const settingsStore: Record<string, unknown> = { locale: 'en-US' }
      let nextCallbackId = 1
      let nextEventId = 1

      const internals = (globalWindow.__TAURI_INTERNALS__ ??= {})
      const eventInternals = (globalWindow.__TAURI_EVENT_PLUGIN_INTERNALS__ ??=
        {})
      const callbacks = (internals.callbacks ??= {})

      globalWindow.__FLOW_TEST_TAURI__ = { settingsStore }
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
      internals.unregisterCallback = (id) => {
        delete callbacks[id]
      }
      internals.runCallback = (id, ...args) => callbacks[id]?.(...args)
      eventInternals.unregisterListener = () => undefined
      internals.invoke = async (command, args) => {
        if (command === 'get_settings') return { ...settingsStore }
        if (command === 'update_settings') {
          Object.assign(settingsStore, args?.settings ?? {})
          return null
        }
        if (command === 'list_books') return Array.from(bookStore.values())
        if (command === 'get_book') {
          return bookStore.get(String(args?.id)) ?? null
        }
        if (command === 'update_book') {
          const id = String(args?.id)
          const current = bookStore.get(id)
          if (!current) return null
          const updated = {
            ...current,
            ...((args?.changes ?? {}) as Partial<BookRecord>),
          }
          bookStore.set(id, updated)
          return updated
        }
        if (command === 'list_covers') return []
        if (command === 'get_cover') return null
        if (command === 'get_book_package_path') return packageUrl
        if (command === 'take_pending_open_paths') return []
        if (command === 'flush_storage') return null
        if (command === 'search_book_text') return []
        if (command === 'unload_book_search_text') return null
        if (command === 'plugin:event|listen') return nextEventId++
        if (command === 'plugin:event|unlisten') return null
        if (command.startsWith('plugin:window|is_')) return false
        if (command.startsWith('plugin:window|')) return null
        if (command.startsWith('plugin:webview|')) return null

        return null
      }
    },
    { fixtureBooks: books, packageUrl },
  )
}

function longChapterName(index: number) {
  return `FLOW-CHAPTER-${String(index + 1).padStart(3, '0')}`
}

function longBookResource(pathname: string) {
  const normalized = pathname.replace(/^\/test-assets\/long\/OPS\//, '')
  const chapterMatch = /^chapter_(\d{3})\.xhtml$/.exec(normalized)

  if (normalized === 'package.opf') {
    const manifest = Array.from({ length: 620 }, (_, index) => {
      const number = String(index + 1).padStart(3, '0')
      return `<item id="chapter_${number}" href="chapter_${number}.xhtml" media-type="application/xhtml+xml"/>`
    }).join('\n')
    const spine = Array.from({ length: 620 }, (_, index) => {
      const number = String(index + 1).padStart(3, '0')
      return `<itemref linear="yes" idref="chapter_${number}"/>`
    }).join('\n')

    return {
      contentType: 'application/oebps-package+xml',
      body: `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="pub-id">flow.reader.long-layout</dc:identifier>
    <dc:title>Long Layout Test</dc:title>
    <dc:language>en-US</dc:language>
    <meta property="dcterms:modified">2026-06-27T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="toc" properties="nav" href="toc.xhtml" media-type="application/xhtml+xml"/>
    <item id="style" href="style.css" media-type="text/css"/>
    ${manifest}
  </manifest>
  <spine>
    ${spine}
  </spine>
</package>`,
    }
  }

  if (normalized === 'toc.xhtml') {
    const items = Array.from({ length: 620 }, (_, index) => {
      const number = String(index + 1).padStart(3, '0')
      return `<li><a href="chapter_${number}.xhtml">${longChapterName(index)}</a></li>`
    }).join('\n')

    return {
      contentType: 'application/xhtml+xml',
      body: `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
  <head><title>Long Layout Test</title></head>
  <body>
    <nav epub:type="toc"><ol>${items}</ol></nav>
  </body>
</html>`,
    }
  }

  if (normalized === 'style.css') {
    return {
      contentType: 'text/css',
      body: 'body{font-family:serif;} p{margin:1em 0;}',
    }
  }

  if (chapterMatch) {
    const number = Number(chapterMatch[1])
    const title = longChapterName(number - 1)
    const paragraphs = Array.from({ length: 18 }, (_, index) => {
      return `<p>${title} paragraph ${index + 1}. The deterministic layout marker for this chapter is ${title}. This text is deliberately repeated to create several columns and stable pagination for stress testing.</p>`
    }).join('\n')

    return {
      contentType: 'application/xhtml+xml',
      body: `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head>
    <title>${title}</title>
    <link rel="stylesheet" href="style.css" type="text/css"/>
  </head>
  <body>
    <section><h1>${title}</h1>${paragraphs}</section>
  </body>
</html>`,
    }
  }
}

async function installLongBookRoutes(page: Page) {
  await page.route('**/test-assets/long/OPS/**', (route) => {
    const resource = longBookResource(new URL(route.request().url()).pathname)

    if (!resource) {
      return route.fulfill({
        status: 404,
        contentType: 'text/plain',
        body: 'not found',
      })
    }

    return route.fulfill(resource)
  })
}

async function openFixtureBook(page: Page, index: number) {
  await page.locator('ul.grid [role="button"]').nth(index).click()
}

async function expectRightEdgeNavigation(page: Page) {
  const nav = page.locator('[data-flow-reader-edge-nav]')
  const panel = page.locator('[data-flow-reader-edge-nav-panel]')
  await page.mouse.move(100, 100)
  await expect(nav).toBeVisible()
  await expect(nav.getByRole('button')).toHaveCount(4)
  await expect(panel).toHaveCSS('opacity', '0')
  await expect(panel).toHaveCSS('transition-duration', '0s')

  const metrics = await nav.evaluate((element) => {
    const rect = element.getBoundingClientRect()

    return {
      right: Math.round(rect.right),
      width: Math.round(rect.width),
      viewportRight: window.innerWidth,
    }
  })

  expect(Math.abs(metrics.viewportRight - metrics.right)).toBeLessThanOrEqual(1)
  expect(metrics.width).toBe(24)

  await nav.hover()
  await expect(panel).toHaveCSS('opacity', '1')
}

async function readReaderLayout(page: Page) {
  return page.evaluate(() => {
    function isVisible(el: Element) {
      if (el.closest('[aria-hidden="true"]')) return false

      const htmlEl = el as HTMLElement
      if (
        typeof htmlEl.checkVisibility === 'function' &&
        !htmlEl.checkVisibility({ checkVisibilityCSS: true })
      ) {
        return false
      }

      const rect = el.getBoundingClientRect()
      const style = getComputedStyle(el)
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== 'none' &&
        style.visibility !== 'hidden'
      )
    }

    const frames = Array.from(document.querySelectorAll('iframe'))
      .filter(isVisible)
      .map((frame) => {
        const rect = frame.getBoundingClientRect()
        const iframe = frame as HTMLIFrameElement
        let maxTextBlockWidth = 0
        let bodyText = ''

        try {
          const doc = iframe.contentDocument
          bodyText = doc?.body?.innerText?.slice(0, 240) ?? ''
          const blocks = doc
            ? Array.from(doc.querySelectorAll('body, section, p, h1, h2'))
            : []
          for (const block of blocks) {
            if (!block.textContent?.trim()) continue
            const blockRect = block.getBoundingClientRect()
            maxTextBlockWidth = Math.max(maxTextBlockWidth, blockRect.width)
          }
        } catch {}

        return {
          left: rect.left,
          right: rect.right,
          top: rect.top,
          bottom: rect.bottom,
          width: rect.width,
          height: rect.height,
          stamp: iframe.dataset.testStamp ?? '',
          maxTextBlockWidth,
          bodyText,
        }
      })

    const footerMatches = [0.35, 0.5, 0.75].flatMap((xRatio) => {
      const el = document.elementFromPoint(
        window.innerWidth * xRatio,
        window.innerHeight - 12,
      )
      const text = el?.textContent?.replace(/\s+/g, ' ').trim() ?? ''
      return text.match(/\d+\s*·\s*\d+(?:\s*\([^)]+\))?/g) ?? []
    })
    const footer = Array.from(new Set(footerMatches)).join('|')
    const header = Array.from(document.querySelectorAll('.ReaderGroup button'))
      .filter(isVisible)
      .map((el) => el.textContent?.replace(/\s+/g, ' ').trim() ?? '')
      .join(' ')
    const sidebar =
      document
        .querySelector('.SideBar')
        ?.textContent?.replace(/\s+/g, ' ')
        .trim() ?? ''
    const sidebarEl = document.querySelector('.SideBar')
    const sidebarVisible = sidebarEl ? isVisible(sidebarEl) : false
    const activePane = document.querySelector(
      '[data-flow-reader-pane][aria-hidden="false"]',
    )
    const activePaneRect = activePane?.getBoundingClientRect()
    const overlappingHiddenPanes = Array.from(
      document.querySelectorAll('[data-flow-reader-pane][aria-hidden="true"]'),
    ).filter((el) => {
      const style = getComputedStyle(el)
      if (style.display === 'none' || style.opacity === '0') return false

      const rect = el.getBoundingClientRect()
      return (
        rect.right > 0 &&
        rect.left < window.innerWidth &&
        rect.bottom > 0 &&
        rect.top < window.innerHeight
      )
    }).length
    const tabs = Array.from(document.querySelectorAll('[role="tab"]')).map(
      (tab) => ({
        label: tab.getAttribute('aria-label') ?? '',
        visible: isVisible(tab),
        selected: tab.className.includes('!text-foreground'),
      }),
    )

    return {
      frames,
      footer,
      header,
      layoutSize: {
        height: Math.round(activePaneRect?.height ?? 0),
        width: Math.round(activePaneRect?.width ?? 0),
      },
      hiddenPanePaintStates: Array.from(
        document.querySelectorAll(
          '[data-flow-reader-pane][aria-hidden="true"]',
        ),
      ).map((el) => {
        const style = getComputedStyle(el)
        return {
          opacity: style.opacity,
          visibility: style.visibility,
        }
      }),
      overlappingHiddenPanes,
      sidebar,
      sidebarVisible,
      tabs,
    }
  })
}

async function readReaderPaneGeometry(page: Page) {
  return page.evaluate(() => {
    return Array.from(document.querySelectorAll('[data-flow-reader-pane]')).map(
      (pane, index) => {
        const rect = pane.getBoundingClientRect()

        return {
          index,
          hidden: pane.getAttribute('aria-hidden') === 'true',
          left: Math.round(rect.left),
          top: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        }
      },
    )
  })
}

function expectStablePaneGeometry(
  panes: Awaited<ReturnType<typeof readReaderPaneGeometry>>,
) {
  const activePane = panes.find((pane) => !pane.hidden)
  expect(activePane).toBeDefined()

  for (const pane of panes) {
    expect(pane).toMatchObject({
      left: activePane!.left,
      top: activePane!.top,
      width: activePane!.width,
      height: activePane!.height,
    })
  }
}

async function stampVisibleFrames(page: Page, stamp: string) {
  await page.evaluate((value) => {
    function isVisible(el: Element) {
      if (el.closest('[aria-hidden="true"]')) return false

      const htmlEl = el as HTMLElement
      if (
        typeof htmlEl.checkVisibility === 'function' &&
        !htmlEl.checkVisibility({ checkVisibilityCSS: true })
      ) {
        return false
      }

      const rect = el.getBoundingClientRect()
      const style = getComputedStyle(el)
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== 'none' &&
        style.visibility !== 'hidden'
      )
    }

    Array.from(document.querySelectorAll('iframe'))
      .filter(isVisible)
      .forEach((frame) => {
        ;(frame as HTMLIFrameElement).dataset.testStamp = value
      })
  }, stamp)
}

async function waitForHealthyReaderLayout(
  page: Page,
  options: { header?: RegExp | false; sidebarVisible?: boolean } = {},
) {
  await expect
    .poll(async () => {
      const layout = await readReaderLayout(page)
      const sidebarOk =
        options.sidebarVisible === undefined
          ? true
          : layout.sidebarVisible === options.sidebarVisible &&
            (!options.sidebarVisible ||
              (layout.sidebar.includes('TOC') &&
                layout.sidebar.includes('Tab Layout A') &&
                layout.sidebar.includes('Tab Layout B')))
      const headerOk =
        options.header === false
          ? true
          : (options.header ?? /Down The Rabbit-Hole/).test(layout.header)

      return (
        layout.frames.length > 0 &&
        layout.frames.every(
          (frame) =>
            frame.width > 250 &&
            frame.maxTextBlockWidth > 180 &&
            frame.maxTextBlockWidth <= frame.width + 4,
        ) &&
        headerOk &&
        layout.hiddenPanePaintStates.every(
          (state) => state.opacity === '0' && state.visibility === 'hidden',
        ) &&
        layout.overlappingHiddenPanes === 0 &&
        sidebarOk &&
        /\d+\s*·\s*\d+/.test(layout.footer)
      )
    })
    .toBe(true)

  return readReaderLayout(page)
}

async function expectVisibleFrameStamp(page: Page, stamp: string) {
  await expect
    .poll(async () => {
      const layout = await readReaderLayout(page)
      return layout.frames.some((frame) => frame.stamp === stamp)
    })
    .toBe(true)
}

async function countVisibleReaderMarks(page: Page, ref: string) {
  return page.evaluate((markRef) => {
    function isInActivePane(el: Element) {
      return !el.closest('[data-flow-reader-pane][aria-hidden="true"]')
    }

    return Array.from(document.querySelectorAll(`[ref="${markRef}"]`)).filter(
      isInActivePane,
    ).length
  }, ref)
}

async function expectVisibleReaderMarks(
  page: Page,
  ref: string,
  minimum: number,
) {
  await expect
    .poll(() => countVisibleReaderMarks(page, ref))
    .toBeGreaterThanOrEqual(minimum)
}

async function addVisibleAnnotation(page: Page) {
  return page.evaluate(() => {
    const tab = (window as any).reader.focusedBookTab
    if (!tab?.iframe?.document?.body) {
      throw new Error('Missing active reader document')
    }

    const doc = tab.iframe.document
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const text = node.textContent ?? ''
        return /\bAlice\b/.test(text)
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_SKIP
      },
    })
    const node = walker.nextNode()
    if (!node?.textContent) throw new Error('Missing visible text target')

    const start = node.textContent.indexOf('Alice')
    const range = doc.createRange()
    range.setStart(node, start)
    range.setEnd(node, start + 'Alice'.length)

    const cfi = tab.rangeToCfi(range)
    const section = tab.sectionForRange(range)
    tab.putAnnotation(
      'highlight',
      cfi,
      'yellow',
      range.toString(),
      undefined,
      section,
    )

    return { cfi, text: range.toString() }
  })
}

async function expectHealthyLayoutWithSidebar(
  page: Page,
  sidebarVisible: boolean,
) {
  const layout = await waitForHealthyReaderLayout(page, { sidebarVisible })
  expect(layout.sidebarVisible).toBe(sidebarVisible)
  return layout
}

async function toggleTocSidebar(page: Page) {
  await page.locator('.ActivityBar button[aria-label="TOC"]').click()
}

async function ensureTocSidebarVisibility(
  page: Page,
  visible: boolean,
  options: { header?: RegExp | false } = {},
) {
  for (let i = 0; i < 3; i++) {
    const layout = await readReaderLayout(page)
    if (layout.sidebarVisible === visible) {
      return waitForStableReaderLayout(page, {
        ...options,
        sidebarVisible: visible,
      })
    }

    await toggleTocSidebar(page)
    await page.waitForTimeout(250)
  }

  return waitForStableReaderLayout(page, {
    ...options,
    sidebarVisible: visible,
  })
}

async function readFocusedTabState(page: Page) {
  return page.evaluate(() => {
    const tab = (window as any).reader.focusedBookTab
    const location = tab?.paginationSnapshot?.location

    return {
      tabId: tab?.id,
      tabTitle: tab?.title,
      atEnd: !!location?.atEnd,
      footerPercentage: tab?.paginationSnapshot?.percentage,
      header: tab?.paginationSnapshot?.headerPath
        ?.map((item: { label?: string }) => item.label ?? '')
        .join(' '),
      bookCfi: tab?.book?.cfi,
      currentTarget: tab?.getCurrentDisplayTarget?.(),
      renditionStartCfi: tab?.rendition?.location?.start?.cfi,
      renditionEndCfi: tab?.rendition?.location?.end?.cfi,
      rejectedLocationEventCount: tab?.rejectedLocationEventCount ?? 0,
      startCfi: location?.start?.cfi,
      endCfi: location?.end?.cfi,
      startIndex: location?.start?.index,
      endIndex: location?.end?.index,
      visibleSectionIndexes: [...(tab?.visibleSectionIndexes ?? [])],
    }
  })
}

async function readFocusedRenderSignature(page: Page) {
  const layout = await readReaderLayout(page)
  const state = await readFocusedTabState(page)

  return {
    tabId: state.tabId,
    currentTarget: state.currentTarget,
    startCfi: state.startCfi,
    startIndex: state.startIndex,
    endIndex: state.endIndex,
    visibleSectionIndexes: state.visibleSectionIndexes,
    header: state.header,
    footer: layout.footer,
    layoutSize: layout.layoutSize,
    sidebarVisible: layout.sidebarVisible,
    frames: layout.frames.map((frame) => ({
      text: frame.bodyText.replace(/\s+/g, ' ').trim().slice(0, 180),
      width: Math.round(frame.width),
    })),
  }
}

async function expectFocusedTabId(page: Page, tabId: string) {
  await expect
    .poll(async () => (await readFocusedTabState(page)).tabId)
    .toBe(tabId)
}

async function readAllBookTabStates(page: Page) {
  return page.evaluate(() => {
    const group = (window as any).reader.focusedGroup

    return (group?.bookTabs ?? []).map((tab: any) => {
      const location = tab?.paginationSnapshot?.location

      return {
        id: tab.id,
        rendered: tab.rendered,
        turning: tab.turning,
        bookCfi: tab.book?.cfi,
        currentTarget: tab.getCurrentDisplayTarget?.(),
        renditionStartCfi: tab.rendition?.location?.start?.cfi,
        rejectedLocationEventCount: tab.rejectedLocationEventCount ?? 0,
        startCfi: location?.start?.cfi,
        endCfi: location?.end?.cfi,
        startIndex: location?.start?.index,
        endIndex: location?.end?.index,
        visibleSectionIndexes: [...(tab?.visibleSectionIndexes ?? [])],
      }
    })
  })
}

async function advanceFocusedTabPages(page: Page, count: number) {
  await page.evaluate(async (pageCount) => {
    const tab = (window as any).reader.focusedBookTab
    if (!tab) throw new Error('Missing focused book tab')

    for (let i = 0; i < pageCount; i++) {
      await tab.next()
      await new Promise((resolve) => window.setTimeout(resolve, 30))
    }
  }, count)
}

async function installBookTabRuntimeCounters(page: Page) {
  await page.evaluate(() => {
    const group = (window as any).reader.focusedGroup

    for (const tab of group?.bookTabs ?? []) {
      if (tab.__flowRuntimeCounterInstalled) continue

      const counters = {
        display: 0,
        next: 0,
        prev: 0,
        relayoutCurrentView: 0,
        resizeRendition: 0,
        setActive: 0,
      }
      tab.__flowRuntimeCounters = counters

      for (const name of Object.keys(counters)) {
        const original = tab[name]
        if (typeof original !== 'function') continue

        tab[name] = function (...args: unknown[]) {
          counters[name as keyof typeof counters] += 1
          return original.apply(this, args)
        }
      }

      tab.__flowRuntimeCounterInstalled = true
    }
  })
}

async function resetBookTabRuntimeCounters(page: Page) {
  await page.evaluate(() => {
    const group = (window as any).reader.focusedGroup

    for (const tab of group?.bookTabs ?? []) {
      const counters = tab.__flowRuntimeCounters
      if (!counters) continue

      counters.display = 0
      counters.next = 0
      counters.prev = 0
      counters.relayoutCurrentView = 0
      counters.resizeRendition = 0
      counters.setActive = 0
    }
  })
}

async function readBookTabRuntimeCounters(page: Page) {
  return page.evaluate(() => {
    const group = (window as any).reader.focusedGroup

    return (group?.bookTabs ?? []).map((tab: any) => ({
      id: tab.id,
      ...(tab.__flowRuntimeCounters ?? {}),
    }))
  })
}

async function readTabStripMotion(page: Page) {
  return page.evaluate(async () => {
    const motionProperties = new Set([
      'all',
      'height',
      'inset',
      'inset-block',
      'inset-inline',
      'left',
      'margin',
      'margin-left',
      'margin-right',
      'padding',
      'padding-left',
      'padding-right',
      'right',
      'top',
      'transform',
      'translate',
      'width',
    ])
    const parseSeconds = (value: string) =>
      value
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) =>
          part.endsWith('ms')
            ? Number(part.slice(0, -2)) / 1000
            : Number(part.replace(/s$/, '')),
        )
        .filter((value) => Number.isFinite(value))

    function hasMotionTransition(style: CSSStyleDeclaration) {
      const durations = parseSeconds(style.transitionDuration)
      if (!durations.some((duration) => duration > 0)) return false

      const properties = style.transitionProperty
        .split(',')
        .map((property) => property.trim())
      return properties.some((property) => motionProperties.has(property))
    }

    function tabMetrics() {
      return Array.from(document.querySelectorAll('[role="tab"]')).map(
        (tab) => {
          const rect = tab.getBoundingClientRect()
          return {
            label: tab.getAttribute('aria-label') ?? '',
            height: Math.round(rect.height * 100) / 100,
            left: Math.round(rect.left * 100) / 100,
            top: Math.round(rect.top * 100) / 100,
            width: Math.round(rect.width * 100) / 100,
          }
        },
      )
    }

    const tabElements = Array.from(
      document.querySelectorAll('[role="tab"]'),
    ) as HTMLElement[]
    const animated = tabElements.flatMap((tab) => {
      const label = tab.getAttribute('aria-label') ?? ''
      const items: Array<{ label: string; target: string }> = []
      const targets: Array<[string, Element | HTMLElement]> = [
        ['self', tab],
        ...Array.from(tab.querySelectorAll('*')).map(
          (element, index) => [`child:${index}`, element] as const,
        ),
      ]

      for (const [target, element] of targets) {
        const style = getComputedStyle(element)
        if (hasMotionTransition(style)) items.push({ label, target })
      }

      for (const pseudo of ['::before', '::after']) {
        const style = getComputedStyle(tab, pseudo)
        if (hasMotionTransition(style)) {
          items.push({ label, target: pseudo })
        }
      }

      return items
    })

    const frames = [tabMetrics()]
    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => requestAnimationFrame(resolve))
      frames.push(tabMetrics())
    }

    return { animated, frames }
  })
}

async function traceTabSwitchInteraction(page: Page, tabLabel: string) {
  return page.evaluate(async (targetLabel) => {
    const tabElements = () =>
      Array.from(document.querySelectorAll('[role="tab"]')) as HTMLElement[]
    const tabMetrics = () =>
      tabElements().map((tab) => {
        const rect = tab.getBoundingClientRect()
        return {
          label: tab.getAttribute('aria-label') ?? '',
          height: Math.round(rect.height * 100) / 100,
          left: Math.round(rect.left * 100) / 100,
          top: Math.round(rect.top * 100) / 100,
          width: Math.round(rect.width * 100) / 100,
        }
      })
    const runtimeCounters = () => {
      const group = (window as any).reader.focusedGroup

      return (group?.bookTabs ?? []).map((tab: any) => ({
        id: tab.id,
        ...(tab.__flowRuntimeCounters ?? {}),
      }))
    }
    const frames: Array<{
      counters: ReturnType<typeof runtimeCounters>
      focusedTabId?: string
      metrics: ReturnType<typeof tabMetrics>
      phase: string
      t: number
    }> = []
    const start = performance.now()
    const sample = (phase: string) => {
      frames.push({
        counters: runtimeCounters(),
        focusedTabId: (window as any).reader.focusedBookTab?.id,
        metrics: tabMetrics(),
        phase,
        t: Math.round((performance.now() - start) * 100) / 100,
      })
    }

    const target = tabElements().find(
      (tab) => tab.getAttribute('aria-label') === targetLabel,
    )
    if (!target) throw new Error(`Missing tab ${targetLabel}`)

    sample('before')
    const frameSampling = new Promise<void>((resolve) => {
      let count = 0
      const tick = () => {
        sample(`raf-${count}`)
        count += 1
        if (count >= 8) {
          resolve()
          return
        }
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    target.click()
    sample('after-click')
    await frameSampling

    return frames
  }, tabLabel)
}

async function goToLastPage(page: Page) {
  await page.evaluate(async () => {
    const tab = (window as any).reader.focusedBookTab
    if (!tab) throw new Error('Missing focused book tab')

    for (let i = 0; i < 80; i++) {
      if (tab.paginationSnapshot?.location?.atEnd) return
      await tab.next()
      await new Promise((resolve) => window.setTimeout(resolve, 30))
    }

    throw new Error('Unable to reach final page')
  })
}

async function goToCrossSectionSpread(page: Page) {
  return page.evaluate(async () => {
    const tab = (window as any).reader.focusedBookTab
    if (!tab) throw new Error('Missing focused book tab')

    for (let i = 0; i < 80; i++) {
      const location = tab.paginationSnapshot?.location
      if (
        location?.start?.index !== undefined &&
        location?.end?.index !== undefined &&
        location.start.index !== location.end.index &&
        tab.visibleSectionIndexes?.includes(location.end.index)
      ) {
        return {
          leftSectionIndex: location.start.index,
          rightSectionIndex: location.end.index,
        }
      }

      await tab.next()
      await new Promise((resolve) => window.setTimeout(resolve, 30))
    }

    throw new Error('Unable to find a cross-section spread')
  })
}

async function addRightPageDefinitionAndAnnotation(
  page: Page,
  sectionIndex: number,
) {
  return page.evaluate((targetSectionIndex) => {
    const tab = (window as any).reader.focusedBookTab
    const views = tab?.rendition?.manager?.views?._views ?? []
    const view = views.find(
      (candidate: any) => candidate?.section?.index === targetSectionIndex,
    )
    const doc = view?.document ?? view?.contents?.document
    if (!tab || !view || !doc?.body) {
      throw new Error('Missing target right-page view')
    }

    const viewportWidth = doc.documentElement.clientWidth || window.innerWidth
    const viewportHeight =
      doc.documentElement.clientHeight || window.innerHeight
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        return /[A-Za-z]{4,}/.test(node.textContent ?? '')
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_SKIP
      },
    })

    let node = walker.nextNode()
    while (node?.textContent) {
      const match = /[A-Za-z]{4,}/.exec(node.textContent)
      if (!match) {
        node = walker.nextNode()
        continue
      }

      const range = doc.createRange()
      range.setStart(node, match.index)
      range.setEnd(node, match.index + match[0].length)
      const rect = range.getBoundingClientRect()
      const visible =
        rect.width > 0 &&
        rect.height > 0 &&
        rect.right > 0 &&
        rect.left < viewportWidth &&
        rect.bottom > 0 &&
        rect.top < viewportHeight

      if (visible) {
        const cfi = tab.rangeToCfi(range)
        const section = tab.sectionForRange(range)
        tab.define([match[0]])
        tab.putAnnotation(
          'highlight',
          cfi,
          'yellow',
          range.toString(),
          undefined,
          section,
        )

        return {
          cfi,
          sectionIndex: section?.index,
          text: range.toString(),
        }
      }

      node = walker.nextNode()
    }

    throw new Error('Missing visible right-page word')
  }, sectionIndex)
}

async function waitForStableReaderLayout(
  page: Page,
  options: { header?: RegExp | false; sidebarVisible?: boolean } = {},
) {
  let previous = await waitForHealthyReaderLayout(page, options)
  const deadline = Date.now() + 5000

  while (Date.now() < deadline) {
    await page.waitForTimeout(250)
    const next = await waitForHealthyReaderLayout(page, options)
    const previousWidths = previous.frames.map((frame) =>
      Math.round(frame.width),
    )
    const nextWidths = next.frames.map((frame) => Math.round(frame.width))

    if (
      next.frames.length === previous.frames.length &&
      next.footer === previous.footer &&
      JSON.stringify(nextWidths) === JSON.stringify(previousWidths)
    ) {
      return next
    }

    previous = next
  }

  return previous
}

test.beforeEach(async ({ page }, testInfo) => {
  await installReaderBooksMock(
    page,
    undefined,
    testInfo.title.includes('long-book') ? longPackageUrl : alicePackageUrl,
  )
  await page.goto('/')
  await page.addStyleTag({
    content:
      'nextjs-portal{display:none!important;pointer-events:none!important}',
  })
  await expect(page.locator('#layout')).toBeVisible()
  await expect(page.locator('ul.grid [role="button"]')).toHaveCount(3)
})

async function displayFocusedSectionIndex(page: Page, sectionIndex: number) {
  await page.evaluate(async (targetIndex) => {
    const tab = (window as any).reader.focusedBookTab
    const section = tab?.sections?.find(
      (candidate: { index?: number }) => candidate.index === targetIndex,
    )
    if (!tab || !section) throw new Error(`Missing section ${targetIndex}`)

    await tab.displaySectionStart(section)
  }, sectionIndex)
}

async function readFocusedLongBookIntegrity(page: Page) {
  return page.evaluate(() => {
    const tab = (window as any).reader.focusedBookTab
    const location = tab?.paginationSnapshot?.location
    const activeFrames = Array.from(document.querySelectorAll('iframe')).filter(
      (frame) => !frame.closest('[aria-hidden="true"]'),
    ) as HTMLIFrameElement[]
    const markerNumbers = new Set<number>()
    const frameTexts = activeFrames.map((frame) => {
      const text = frame.contentDocument?.body?.innerText ?? ''
      for (const match of text.matchAll(/FLOW-CHAPTER-(\d{3})/g)) {
        markerNumbers.add(Number(match[1]))
      }
      return text.replace(/\s+/g, ' ').slice(0, 160)
    })
    const spread = tab?.rendition?.manager?.currentReflowableSpread
    const spreadIndexes = [
      spread?.left?.section?.index,
      spread?.right?.section?.index,
    ].filter((index): index is number => typeof index === 'number')

    return {
      activeTabId: tab?.id,
      bodySectionIndexes: [...markerNumbers]
        .map((number) => number - 1)
        .sort((a, b) => a - b),
      frameCount: activeFrames.length,
      frameTexts,
      rendered: tab?.rendered,
      atEnd: location?.atEnd === true,
      renditionIndexes: [
        tab?.rendition?.location?.start?.index,
        tab?.rendition?.location?.end?.index,
      ].filter((index): index is number => typeof index === 'number'),
      snapshotIndexes: [location?.start?.index, location?.end?.index].filter(
        (index): index is number => typeof index === 'number',
      ),
      spreadIndexes,
      turning: tab?.turning,
      visibleSectionIndexes: [...(tab?.visibleSectionIndexes ?? [])],
    }
  })
}

async function readLongBookIntegrityByTabId(page: Page, tabId: string) {
  return page.evaluate((targetTabId) => {
    const tabs = (window as any).reader.focusedGroup?.bookTabs ?? []
    const tab = tabs.find((candidate: any) => candidate.id === targetTabId)
    if (!tab) throw new Error(`Missing tab ${targetTabId}`)

    const location = tab.paginationSnapshot?.location
    const spread = tab.rendition?.manager?.currentReflowableSpread

    return {
      atEnd: location?.atEnd === true,
      bookCfi: tab.book?.cfi,
      currentLocationIndexes: [
        tab.currentLocation?.start?.index,
        tab.currentLocation?.end?.index,
      ].filter((index: unknown): index is number => typeof index === 'number'),
      rendered: tab.rendered,
      renditionIndexes: [
        tab.rendition?.location?.start?.index,
        tab.rendition?.location?.end?.index,
      ].filter((index: unknown): index is number => typeof index === 'number'),
      snapshotIndexes: [location?.start?.index, location?.end?.index].filter(
        (index: unknown): index is number => typeof index === 'number',
      ),
      spreadIndexes: [
        spread?.left?.section?.index,
        spread?.right?.section?.index,
      ].filter((index: unknown): index is number => typeof index === 'number'),
      visibleSectionIndexes: [...(tab.visibleSectionIndexes ?? [])],
    }
  }, tabId)
}

async function expectLongBookTabSection(
  page: Page,
  tabId: string,
  expectedSectionIndex: number,
) {
  await expect
    .poll(async () => {
      const state = await readLongBookIntegrityByTabId(page, tabId)

      return (
        state.rendered === true &&
        state.currentLocationIndexes.includes(expectedSectionIndex) &&
        state.snapshotIndexes.includes(expectedSectionIndex) &&
        state.renditionIndexes.includes(expectedSectionIndex) &&
        state.spreadIndexes.includes(expectedSectionIndex) &&
        state.visibleSectionIndexes.includes(expectedSectionIndex)
      )
    })
    .toBe(true)
}

async function expectFocusedLongBookSection(
  page: Page,
  expectedSectionIndex: number,
) {
  await expect
    .poll(async () => {
      const state = await readFocusedLongBookIntegrity(page)
      const visible = new Set([
        ...state.visibleSectionIndexes,
        ...state.snapshotIndexes,
        ...state.spreadIndexes,
      ])

      return (
        state.rendered === true &&
        state.turning === false &&
        state.frameCount > 0 &&
        state.bodySectionIndexes.includes(expectedSectionIndex) &&
        state.snapshotIndexes.includes(expectedSectionIndex) &&
        state.renditionIndexes.includes(expectedSectionIndex) &&
        state.bodySectionIndexes.every((index) => visible.has(index))
      )
    })
    .toBe(true)
}

async function expectFocusedLongBookStateConsistent(page: Page) {
  await expect
    .poll(async () => {
      const state = await readFocusedLongBookIntegrity(page)
      const committed = new Set([
        ...state.visibleSectionIndexes,
        ...state.snapshotIndexes,
        ...state.spreadIndexes,
      ])
      const hasCommittedBody =
        state.bodySectionIndexes.length > 0 &&
        state.bodySectionIndexes.every((index) => committed.has(index))
      const locationStillAligned =
        !state.snapshotIndexes.length ||
        !state.renditionIndexes.length ||
        state.snapshotIndexes.some((index) =>
          state.renditionIndexes.includes(index),
        )

      return (
        state.rendered === true &&
        state.turning === false &&
        state.frameCount > 0 &&
        hasCommittedBody &&
        locationStillAligned
      )
    })
    .toBe(true)
}

async function goFocusedLongBookToEnd(page: Page) {
  await page.evaluate(async () => {
    const tab = (window as any).reader.focusedBookTab
    if (!tab) throw new Error('Missing focused book tab')

    for (let i = 0; i < 20; i++) {
      if (tab.paginationSnapshot?.location?.atEnd) return
      await tab.next()
    }

    throw new Error('Unable to reach long-book final page')
  })
}

test('keeps inactive reader panes at the active reader geometry', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1400, height: 900 })

  await openFixtureBook(page, 0)
  await waitForStableReaderLayout(page)
  await page.locator('.SideBar button[aria-label*="Tab Layout B"]').click()
  await waitForStableReaderLayout(page)

  expectStablePaneGeometry(await readReaderPaneGeometry(page))

  await page.getByRole('tab', { name: 'Tab Layout A' }).click()
  expectStablePaneGeometry(await readReaderPaneGeometry(page))

  await ensureTocSidebarVisibility(page, false)
  expectStablePaneGeometry(await readReaderPaneGeometry(page))

  await page.getByRole('tab', { name: 'Tab Layout B' }).click()
  expectStablePaneGeometry(await readReaderPaneGeometry(page))
})

test('keeps tab layout stable across repeated tab and sidebar changes', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1400, height: 900 })

  await openFixtureBook(page, 0)
  await expect(page.getByRole('tab', { name: 'Tab Layout A' })).toBeVisible()
  await expectRightEdgeNavigation(page)
  const initialA = await waitForStableReaderLayout(page)
  expect(initialA.sidebarVisible).toBe(true)
  await stampVisibleFrames(page, 'tab-a-wide')

  await page.locator('.SideBar button[aria-label*="Tab Layout B"]').click()
  await expect(page.getByRole('tab', { name: 'Tab Layout B' })).toBeVisible()
  const initialB = await waitForStableReaderLayout(page)
  expect(initialB.sidebarVisible).toBe(true)
  await stampVisibleFrames(page, 'tab-b-wide')

  await page.getByRole('tab', { name: 'Tab Layout A' }).click()
  const unchangedA = await expectHealthyLayoutWithSidebar(page, true)
  expect(unchangedA.footer).toBe(initialA.footer)
  await expectVisibleFrameStamp(page, 'tab-a-wide')

  await page.getByRole('tab', { name: 'Tab Layout B' }).click()
  const unchangedB = await expectHealthyLayoutWithSidebar(page, true)
  expect(unchangedB.footer).toBe(initialB.footer)
  await expectVisibleFrameStamp(page, 'tab-b-wide')

  await toggleTocSidebar(page)
  const hiddenB = await waitForStableReaderLayout(page, {
    sidebarVisible: false,
  })
  await stampVisibleFrames(page, 'tab-b-hidden')

  await page.getByRole('tab', { name: 'Tab Layout A' }).click()
  const hiddenA = await waitForStableReaderLayout(page, {
    sidebarVisible: false,
  })
  await stampVisibleFrames(page, 'tab-a-hidden')

  expect(hiddenA.frames.every((frame) => frame.width > 250)).toBe(true)
  expect(hiddenB.frames.every((frame) => frame.width > 250)).toBe(true)

  await page.getByRole('tab', { name: 'Tab Layout B' }).click()
  await expectHealthyLayoutWithSidebar(page, false)
  await expectVisibleFrameStamp(page, 'tab-b-hidden')

  await page.getByRole('tab', { name: 'Tab Layout A' }).click()
  await expectHealthyLayoutWithSidebar(page, false)
  await expectVisibleFrameStamp(page, 'tab-a-hidden')

  await page.getByRole('tab', { name: 'Tab Layout B' }).click()
  await expectHealthyLayoutWithSidebar(page, false)
  await expectVisibleFrameStamp(page, 'tab-b-hidden')

  await toggleTocSidebar(page)
  await waitForStableReaderLayout(page, { sidebarVisible: true })
  await stampVisibleFrames(page, 'tab-b-wide-again')

  await page.getByRole('tab', { name: 'Tab Layout A' }).click()
  await waitForStableReaderLayout(page, { sidebarVisible: true })
  await stampVisibleFrames(page, 'tab-a-wide-again')

  await page.getByRole('tab', { name: 'Tab Layout B' }).click()
  await expectHealthyLayoutWithSidebar(page, true)
  await expectVisibleFrameStamp(page, 'tab-b-wide-again')

  await page.getByRole('tab', { name: 'Tab Layout A' }).click()
  await expectHealthyLayoutWithSidebar(page, true)
  await expectVisibleFrameStamp(page, 'tab-a-wide-again')

  await page.setViewportSize({ width: 900, height: 900 })
  const resizedA = await waitForStableReaderLayout(page, {
    sidebarVisible: true,
  })
  await stampVisibleFrames(page, 'tab-a-narrow')

  await page.getByRole('tab', { name: 'Tab Layout B' }).click()
  const resizedB = await waitForStableReaderLayout(page, {
    sidebarVisible: true,
  })
  await stampVisibleFrames(page, 'tab-b-narrow')

  await page.getByRole('tab', { name: 'Tab Layout A' }).click()
  await expectHealthyLayoutWithSidebar(page, true)
  await expectVisibleFrameStamp(page, 'tab-a-narrow')

  expect(resizedA.footer).not.toBe(initialA.footer)
  expect(resizedB.footer).not.toBe(initialB.footer)
  expect(resizedA.frames.every((frame) => frame.width > 250)).toBe(true)
  expect(resizedA.frames.every((frame) => frame.maxTextBlockWidth > 180)).toBe(
    true,
  )
})

test('replays single-tab layout states without drifting', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 })

  await openFixtureBook(page, 0)
  await waitForStableReaderLayout(page, { sidebarVisible: true })
  await advanceFocusedTabPages(page, 3)
  await waitForStableReaderLayout(page, {
    header: false,
    sidebarVisible: true,
  })

  const seen = new Map<
    string,
    Awaited<ReturnType<typeof readFocusedRenderSignature>>
  >()

  async function visitLayoutState(
    viewport: { width: number; height: number },
    sidebarVisible: boolean,
  ) {
    await page.setViewportSize(viewport)
    await ensureTocSidebarVisibility(page, sidebarVisible, { header: false })
    const signature = await readFocusedRenderSignature(page)
    const key = `${signature.layoutSize.width}x${signature.layoutSize.height}:${sidebarVisible}`
    const previous = seen.get(key)

    if (previous) {
      expect(signature).toEqual(previous)
    } else {
      seen.set(key, signature)
    }
  }

  await visitLayoutState({ width: 1400, height: 900 }, true)
  await visitLayoutState({ width: 1400, height: 900 }, false)
  await visitLayoutState({ width: 1400, height: 900 }, true)
  await visitLayoutState({ width: 1100, height: 820 }, true)
  await visitLayoutState({ width: 1100, height: 820 }, false)
  await visitLayoutState({ width: 1400, height: 900 }, false)
  await visitLayoutState({ width: 1400, height: 900 }, true)
})

test('replays multi-tab mixed layout states deterministically', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1400, height: 900 })

  await openFixtureBook(page, 0)
  await waitForStableReaderLayout(page, { sidebarVisible: true })
  await advanceFocusedTabPages(page, 1)
  await waitForStableReaderLayout(page, {
    header: false,
    sidebarVisible: true,
  })

  await page.locator('.SideBar button[aria-label*="Tab Layout B"]').click()
  await waitForStableReaderLayout(page, { sidebarVisible: true })
  await advanceFocusedTabPages(page, 3)
  await waitForStableReaderLayout(page, {
    header: false,
    sidebarVisible: true,
  })

  await page.locator('.SideBar button[aria-label*="Tab Layout C"]').click()
  await waitForStableReaderLayout(page, { sidebarVisible: true })
  await advanceFocusedTabPages(page, 5)
  await waitForStableReaderLayout(page, {
    header: false,
    sidebarVisible: true,
  })

  const seen = new Map<
    string,
    Awaited<ReturnType<typeof readFocusedRenderSignature>>
  >()

  async function visitMixedState(
    tabName: string,
    viewport: { width: number; height: number },
    sidebarVisible: boolean,
  ) {
    await page.getByRole('tab', { name: tabName }).click()
    await expectFocusedTabId(
      page,
      tabName === 'Tab Layout A'
        ? 'tab-layout-a'
        : tabName === 'Tab Layout B'
          ? 'tab-layout-b'
          : 'tab-layout-c',
    )
    await page.setViewportSize(viewport)
    await ensureTocSidebarVisibility(page, sidebarVisible, { header: false })
    const signature = await readFocusedRenderSignature(page)
    const key = `${signature.tabId}:${signature.layoutSize.width}x${signature.layoutSize.height}:${sidebarVisible}`
    const previous = seen.get(key)

    if (previous) {
      expect(signature).toEqual(previous)
    } else {
      seen.set(key, signature)
    }
  }

  await visitMixedState('Tab Layout A', { width: 1400, height: 900 }, true)
  await visitMixedState('Tab Layout B', { width: 1400, height: 900 }, true)
  await visitMixedState('Tab Layout C', { width: 1400, height: 900 }, false)
  await visitMixedState('Tab Layout A', { width: 1100, height: 820 }, false)
  await visitMixedState('Tab Layout B', { width: 1100, height: 820 }, true)
  await visitMixedState('Tab Layout C', { width: 1100, height: 820 }, true)
  await visitMixedState('Tab Layout A', { width: 1400, height: 900 }, true)
  await visitMixedState('Tab Layout B', { width: 1400, height: 900 }, true)
  await visitMixedState('Tab Layout C', { width: 1400, height: 900 }, false)
})

test('keeps committed locations stable during rapid tab switches', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1400, height: 900 })

  await openFixtureBook(page, 0)
  await waitForStableReaderLayout(page, { sidebarVisible: true })

  await page.locator('.SideBar button[aria-label*="Tab Layout B"]').click()
  await waitForStableReaderLayout(page, { sidebarVisible: true })
  await advanceFocusedTabPages(page, 2)
  await waitForStableReaderLayout(page, { sidebarVisible: true })

  await page.getByRole('tab', { name: 'Tab Layout A' }).click()
  await waitForStableReaderLayout(page, { sidebarVisible: true })
  const before = await readAllBookTabStates(page)

  for (let i = 0; i < 12; i++) {
    await page
      .getByRole('tab', { name: i % 2 ? 'Tab Layout A' : 'Tab Layout B' })
      .click()
  }

  await waitForStableReaderLayout(page, { sidebarVisible: true })
  const after = await readAllBookTabStates(page)

  expect(after).toHaveLength(before.length)
  for (const previous of before) {
    const current = after.find((state) => state.id === previous.id)
    expect(current).toBeTruthy()
    expect(current?.startCfi).toBe(previous.startCfi)
    expect(current?.endCfi).toBe(previous.endCfi)
    expect(current?.currentTarget).toBe(previous.currentTarget)
    expect(current?.visibleSectionIndexes).toEqual(
      previous.visibleSectionIndexes,
    )
    expect(current?.rendered).toBe(true)
    expect(current?.turning).toBe(false)
  }
})

test('switches adjacent tabs immediately with wheel and keyboard input', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1400, height: 900 })

  await openFixtureBook(page, 0)
  await waitForStableReaderLayout(page, { sidebarVisible: true })

  await page.locator('.SideBar button[aria-label*="Tab Layout B"]').click()
  await waitForStableReaderLayout(page, { sidebarVisible: true })
  await page.locator('.SideBar button[aria-label*="Tab Layout C"]').click()
  await waitForStableReaderLayout(page, { sidebarVisible: true })
  await expectFocusedTabId(page, 'tab-layout-c')

  await page.getByRole('tab', { name: 'Tab Layout A' }).click()
  await expectFocusedTabId(page, 'tab-layout-a')

  await page.getByRole('tab', { name: 'Tab Layout A' }).hover()
  await page.mouse.wheel(0, 80)
  await expectFocusedTabId(page, 'tab-layout-b')
  await page.mouse.wheel(0, 80)
  await expectFocusedTabId(page, 'tab-layout-c')

  await page.getByRole('tab', { name: 'Tab Layout A' }).click()
  await expectFocusedTabId(page, 'tab-layout-a')

  await page.keyboard.press('Control+ArrowRight')
  await expectFocusedTabId(page, 'tab-layout-b')
  await page.keyboard.press('Control+ArrowRight')
  await expectFocusedTabId(page, 'tab-layout-c')
})

test('does not paginate during unchanged-size tab switches', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1400, height: 900 })

  await openFixtureBook(page, 0)
  await waitForStableReaderLayout(page, { sidebarVisible: true })
  await page.locator('.SideBar button[aria-label*="Tab Layout B"]').click()
  await waitForStableReaderLayout(page, { sidebarVisible: true })
  await page.locator('.SideBar button[aria-label*="Tab Layout C"]').click()
  await waitForStableReaderLayout(page, { sidebarVisible: true })

  await installBookTabRuntimeCounters(page)
  await page.waitForTimeout(250)
  await resetBookTabRuntimeCounters(page)
  const beforeMotion = await readTabStripMotion(page)
  expect(beforeMotion.animated).toEqual([])

  for (let i = 0; i < 2; i++) {
    const framesA = await traceTabSwitchInteraction(page, 'Tab Layout A')
    await expectFocusedTabId(page, 'tab-layout-a')
    expect(framesA.at(-1)?.focusedTabId).toBe('tab-layout-a')
    expect(
      framesA.find((frame) => frame.phase === 'after-click')?.t,
    ).toBeLessThan(24)
    framesA.forEach((frame) =>
      expect(frame.metrics).toEqual(framesA[0].metrics),
    )

    const framesB = await traceTabSwitchInteraction(page, 'Tab Layout B')
    await expectFocusedTabId(page, 'tab-layout-b')
    expect(framesB.at(-1)?.focusedTabId).toBe('tab-layout-b')
    expect(
      framesB.find((frame) => frame.phase === 'after-click')?.t,
    ).toBeLessThan(24)
    framesB.forEach((frame) =>
      expect(frame.metrics).toEqual(framesB[0].metrics),
    )

    const framesC = await traceTabSwitchInteraction(page, 'Tab Layout C')
    await expectFocusedTabId(page, 'tab-layout-c')
    expect(framesC.at(-1)?.focusedTabId).toBe('tab-layout-c')
    expect(
      framesC.find((frame) => frame.phase === 'after-click')?.t,
    ).toBeLessThan(24)
    framesC.forEach((frame) =>
      expect(frame.metrics).toEqual(framesC[0].metrics),
    )
  }

  await page.waitForTimeout(250)
  const counters = await readBookTabRuntimeCounters(page)
  const afterMotion = await readTabStripMotion(page)

  for (const counter of counters) {
    expect(counter.resizeRendition).toBe(0)
    expect(counter.relayoutCurrentView).toBe(0)
    expect(counter.display).toBe(0)
    expect(counter.next).toBe(0)
    expect(counter.prev).toBe(0)
  }
  expect(
    counters.reduce((total, counter) => total + (counter.setActive ?? 0), 0),
  ).toBe(12)
  expect(afterMotion.animated).toEqual([])

  for (const frame of afterMotion.frames) {
    expect(frame).toEqual(afterMotion.frames[0])
  }
})

test('long-book keeps distant chapter bodies tied to their committed tab state', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1500, height: 900 })

  await openFixtureBook(page, 0)
  await waitForStableReaderLayout(page, {
    header: false,
    sidebarVisible: true,
  })
  await displayFocusedSectionIndex(page, 38)
  await expectFocusedLongBookSection(page, 38)

  await page.locator('.SideBar button[aria-label*="Tab Layout B"]').click()
  await waitForStableReaderLayout(page, {
    header: false,
    sidebarVisible: true,
  })
  await displayFocusedSectionIndex(page, 565)
  await expectFocusedLongBookSection(page, 565)

  await page.locator('.SideBar button[aria-label*="Tab Layout C"]').click()
  await waitForStableReaderLayout(page, {
    header: false,
    sidebarVisible: true,
  })
  await displayFocusedSectionIndex(page, 300)
  await expectFocusedLongBookSection(page, 300)

  const expectedByTab = new Map([
    ['Tab Layout A', 38],
    ['Tab Layout B', 565],
    ['Tab Layout C', 300],
  ])

  async function switchToExpected(tabName: string) {
    await page.getByRole('tab', { name: tabName }).click()
    await expectFocusedLongBookSection(page, expectedByTab.get(tabName)!)
  }

  for (let i = 0; i < 4; i++) {
    await switchToExpected('Tab Layout A')
    await switchToExpected('Tab Layout B')
    await switchToExpected('Tab Layout C')
  }

  await ensureTocSidebarVisibility(page, false, { header: false })
  await switchToExpected('Tab Layout B')
  await page.setViewportSize({ width: 1180, height: 820 })
  await expectFocusedLongBookSection(page, 565)
  await switchToExpected('Tab Layout A')
  await ensureTocSidebarVisibility(page, true, { header: false })
  await expectFocusedLongBookSection(page, 38)
  await switchToExpected('Tab Layout C')
  await page.setViewportSize({ width: 1500, height: 900 })
  await expectFocusedLongBookSection(page, 300)

  await switchToExpected('Tab Layout B')
  await page.evaluate(async () => {
    await (window as any).reader.focusedBookTab?.next()
  })
  await expectFocusedLongBookStateConsistent(page)
  const afterNext = await readFocusedLongBookIntegrity(page)
  const nextCommittedSection = afterNext.snapshotIndexes[0]
  expect(nextCommittedSection).toBeDefined()
  if (nextCommittedSection === undefined) return
  expect(nextCommittedSection).toBeGreaterThanOrEqual(565)
  expectedByTab.set('Tab Layout B', nextCommittedSection)

  await switchToExpected('Tab Layout A')
  await switchToExpected('Tab Layout B')
  await expectFocusedLongBookSection(page, nextCommittedSection)
})

test('long-book inactive tab does not commit stale relayout after rapid switch', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1500, height: 900 })

  await openFixtureBook(page, 0)
  await waitForStableReaderLayout(page, {
    header: false,
    sidebarVisible: true,
  })
  await displayFocusedSectionIndex(page, 38)
  await expectFocusedLongBookSection(page, 38)

  await page.locator('.SideBar button[aria-label*="Tab Layout B"]').click()
  await waitForStableReaderLayout(page, {
    header: false,
    sidebarVisible: true,
  })
  await displayFocusedSectionIndex(page, 565)
  await expectFocusedLongBookSection(page, 565)

  await page.evaluate(() => {
    const tabs = (window as any).reader.focusedGroup.bookTabs
    const tabA = tabs.find((tab: any) => tab.id === 'tab-layout-a')
    if (!tabA) throw new Error('Missing Tab Layout A')

    const originalDisplay = tabA.rendition.display.bind(tabA.rendition)
    tabA.rendition.display = async (...args: unknown[]) => {
      await new Promise((resolve) => setTimeout(resolve, 120))
      return originalDisplay(...args)
    }
  })

  await page.getByRole('tab', { name: 'Tab Layout A' }).click()
  await page.evaluate(() => {
    const tab = (window as any).reader.focusedBookTab
    void tab.relayoutCurrentView()
  })
  await page.getByRole('tab', { name: 'Tab Layout B' }).click()
  await expectFocusedLongBookSection(page, 565)
  await page.waitForTimeout(250)
  await expectLongBookTabSection(page, 'tab-layout-a', 38)

  const tabAState = await readLongBookIntegrityByTabId(page, 'tab-layout-a')
  expect(tabAState.bookCfi).not.toContain('chapter_566')
  expect(tabAState.visibleSectionIndexes).toEqual(expect.arrayContaining([38]))
})

test('long-book keeps final-page tab stable across switches and relayouts', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1500, height: 900 })

  await openFixtureBook(page, 0)
  await waitForStableReaderLayout(page, {
    header: false,
    sidebarVisible: true,
  })
  await displayFocusedSectionIndex(page, 38)
  await expectFocusedLongBookSection(page, 38)

  await page.locator('.SideBar button[aria-label*="Tab Layout B"]').click()
  await waitForStableReaderLayout(page, {
    header: false,
    sidebarVisible: true,
  })
  await displayFocusedSectionIndex(page, 619)
  await goFocusedLongBookToEnd(page)
  await expectFocusedLongBookSection(page, 619)
  await expect
    .poll(async () => (await readFocusedLongBookIntegrity(page)).atEnd)
    .toBe(true)

  for (let i = 0; i < 3; i++) {
    await page.getByRole('tab', { name: 'Tab Layout A' }).click()
    await expectFocusedLongBookSection(page, 38)
    await page.getByRole('tab', { name: 'Tab Layout B' }).click()
    await expectFocusedLongBookSection(page, 619)
    await expect
      .poll(async () => (await readFocusedLongBookIntegrity(page)).atEnd)
      .toBe(true)
  }

  await ensureTocSidebarVisibility(page, false, { header: false })
  await expectFocusedLongBookSection(page, 619)
  await page.getByRole('tab', { name: 'Tab Layout A' }).click()
  await page.setViewportSize({ width: 1180, height: 820 })
  await expectFocusedLongBookSection(page, 38)
  await page.getByRole('tab', { name: 'Tab Layout B' }).click()
  await expectFocusedLongBookSection(page, 619)
  await expect
    .poll(async () => (await readFocusedLongBookIntegrity(page)).atEnd)
    .toBe(true)
  await ensureTocSidebarVisibility(page, true, { header: false })
  await page.setViewportSize({ width: 1500, height: 900 })
  await expectFocusedLongBookSection(page, 619)
  await expect
    .poll(async () => (await readFocusedLongBookIntegrity(page)).atEnd)
    .toBe(true)
})

test('long-book does not reuse stale sidebar-layout spread after page turns', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1500, height: 900 })

  await openFixtureBook(page, 0)
  await waitForStableReaderLayout(page, {
    header: false,
    sidebarVisible: true,
  })
  await displayFocusedSectionIndex(page, 28)
  await expectFocusedLongBookSection(page, 28)

  await ensureTocSidebarVisibility(page, false, { header: false })
  await page.evaluate(async () => {
    const tab = (window as any).reader.focusedBookTab
    if (!tab) throw new Error('Missing focused book tab')

    for (let i = 0; i < 6; i += 1) {
      await tab.next()
    }
  })
  await expectFocusedLongBookStateConsistent(page)

  const afterTurns = await readFocusedLongBookIntegrity(page)
  const expectedSectionIndex = afterTurns.snapshotIndexes[0]
  expect(expectedSectionIndex).toBeDefined()
  if (expectedSectionIndex === undefined) return

  await ensureTocSidebarVisibility(page, true, { header: false })
  await expectFocusedLongBookSection(page, expectedSectionIndex)
  await expectFocusedLongBookStateConsistent(page)
})

test('keeps three tabs stable and redraws same-chapter overlays immediately', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1360, height: 900 })

  await openFixtureBook(page, 0)
  await waitForStableReaderLayout(page, { sidebarVisible: true })
  await stampVisibleFrames(page, 'tab-a-initial')

  await page.locator('.SideBar button[aria-label*="Tab Layout B"]').click()
  await waitForStableReaderLayout(page, { sidebarVisible: true })
  await stampVisibleFrames(page, 'tab-b-initial')

  await page.locator('.SideBar button[aria-label*="Tab Layout C"]').click()
  await waitForStableReaderLayout(page, { sidebarVisible: true })
  await stampVisibleFrames(page, 'tab-c-initial')

  await page.getByRole('tab', { name: 'Tab Layout A' }).click()
  await expectVisibleFrameStamp(page, 'tab-a-initial')
  await page.getByRole('tab', { name: 'Tab Layout B' }).click()
  await expectVisibleFrameStamp(page, 'tab-b-initial')
  await page.getByRole('tab', { name: 'Tab Layout C' }).click()
  await expectVisibleFrameStamp(page, 'tab-c-initial')

  await toggleTocSidebar(page)
  await waitForStableReaderLayout(page, { sidebarVisible: false })
  await stampVisibleFrames(page, 'tab-c-sidebar-hidden')

  await page.setViewportSize({ width: 960, height: 820 })
  await waitForStableReaderLayout(page, { sidebarVisible: false })
  await stampVisibleFrames(page, 'tab-c-narrow')

  await page.getByRole('tab', { name: 'Tab Layout A' }).click()
  await waitForStableReaderLayout(page, { sidebarVisible: false })
  await stampVisibleFrames(page, 'tab-a-narrow')
  await page.getByRole('tab', { name: 'Tab Layout C' }).click()
  await expectVisibleFrameStamp(page, 'tab-c-narrow')

  await page.evaluate(() => {
    ;(window as any).reader.focusedBookTab?.define(['Alice'])
  })
  await expectVisibleReaderMarks(page, 'flow-definition-underline', 1)

  const annotation = await addVisibleAnnotation(page)
  expect(annotation.text).toBe('Alice')
  await expectVisibleReaderMarks(page, 'epubjs-hl', 1)

  await page.evaluate(() => {
    ;(window as any).reader.focusedBookTab?.undefine(' alice ')
  })
  await expect
    .poll(() => countVisibleReaderMarks(page, 'flow-definition-underline'))
    .toBe(0)

  await page.evaluate((cfi) => {
    ;(window as any).reader.focusedBookTab?.removeAnnotation(cfi)
  }, annotation.cfi)
  await expect.poll(() => countVisibleReaderMarks(page, 'epubjs-hl')).toBe(0)

  await page.getByRole('tab', { name: 'Tab Layout A' }).click()
  await expectVisibleFrameStamp(page, 'tab-a-narrow')
  await page.getByRole('tab', { name: 'Tab Layout C' }).click()
  await expectVisibleFrameStamp(page, 'tab-c-narrow')
})

test('keeps final-page tabs stable across tab switches and sidebar relayouts', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1500, height: 900 })

  await openFixtureBook(page, 0)
  await waitForStableReaderLayout(page, { sidebarVisible: true })
  await stampVisibleFrames(page, 'tab-a-final-test')

  await page.locator('.SideBar button[aria-label*="Tab Layout B"]').click()
  await waitForStableReaderLayout(page, { sidebarVisible: true })
  await expect
    .poll(async () => (await readFocusedTabState(page)).tabId)
    .toBe('tab-layout-b')
  await goToLastPage(page)
  const finalB = await waitForStableReaderLayout(page, {
    header: false,
    sidebarVisible: true,
  })
  await stampVisibleFrames(page, 'tab-b-final')

  const finalState = await readFocusedTabState(page)
  expect(finalState.tabId).toBe('tab-layout-b')
  expect(finalState.atEnd).toBe(true)
  expect(finalState.footerPercentage).toBe(1)
  expect(finalB.footer).toContain('100.00%')

  await page.getByRole('tab', { name: 'Tab Layout A' }).click()
  await waitForStableReaderLayout(page, {
    header: false,
    sidebarVisible: true,
  })
  await expectVisibleFrameStamp(page, 'tab-a-final-test')
  await page.getByRole('tab', { name: 'Tab Layout B' }).click()
  await waitForStableReaderLayout(page, {
    header: false,
    sidebarVisible: true,
  })
  await expectVisibleFrameStamp(page, 'tab-b-final')

  await ensureTocSidebarVisibility(page, false, { header: false })
  await ensureTocSidebarVisibility(page, true, { header: false })
  await ensureTocSidebarVisibility(page, false, { header: false })

  await page.getByRole('tab', { name: 'Tab Layout A' }).click()
  await waitForStableReaderLayout(page, { sidebarVisible: false })
  await page.getByRole('tab', { name: 'Tab Layout B' }).click()
  const stableFinalB = await waitForStableReaderLayout(page, {
    header: false,
    sidebarVisible: false,
  })
  const stableState = await readFocusedTabState(page)

  expect(stableState.atEnd).toBe(true)
  expect(stableFinalB.footer).toContain('100.00%')
  expect(stableFinalB.frames.every((frame) => frame.width > 250)).toBe(true)
})

test('keeps right-page cross-section header and overlays in sync', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1500, height: 900 })

  await openFixtureBook(page, 0)
  await waitForStableReaderLayout(page, { sidebarVisible: true })
  await page.locator('.SideBar button[aria-label*="Tab Layout B"]').click()
  await waitForStableReaderLayout(page, { sidebarVisible: true })

  const spread = await goToCrossSectionSpread(page)
  const crossSectionLayout = await waitForStableReaderLayout(page, {
    header: false,
    sidebarVisible: true,
  })
  expect(crossSectionLayout.footer).toMatch(/\|/)

  const targetHeader = await page.evaluate(async (sectionIndex) => {
    const tab = (window as any).reader.focusedBookTab
    const section = tab?.sections?.find(
      (candidate: { index?: number }) => candidate.index === sectionIndex,
    )
    if (!tab || !section) throw new Error('Missing target section')

    await tab.displaySectionStart(section)
    await new Promise((resolve) => window.setTimeout(resolve, 80))

    return (
      section.navitem?.label ??
      tab.mapSectionToNavItem(section.href)?.label ??
      section.href
    )
  }, spread.rightSectionIndex)

  await waitForStableReaderLayout(page, {
    header: new RegExp(targetHeader.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    sidebarVisible: true,
  })

  const overlaySpread = await goToCrossSectionSpread(page)
  const annotation = await addRightPageDefinitionAndAnnotation(
    page,
    overlaySpread.rightSectionIndex,
  )
  expect(annotation.sectionIndex).toBe(overlaySpread.rightSectionIndex)
  expect(annotation.text.length).toBeGreaterThan(3)

  await expectVisibleReaderMarks(page, 'epubjs-hl', 1)
  await expectVisibleReaderMarks(page, 'flow-definition-underline', 1)

  await page.getByRole('tab', { name: 'Tab Layout A' }).click()
  await waitForStableReaderLayout(page, { sidebarVisible: true })
  await page.getByRole('tab', { name: 'Tab Layout B' }).click()
  await expectVisibleReaderMarks(page, 'epubjs-hl', 1)
  await expectVisibleReaderMarks(page, 'flow-definition-underline', 1)
})
