import { expect, type Locator, type Page, test } from '@playwright/test'

import { createTestBook } from '../support/book-fixtures'
import { epubFixturePackageUrl, installEpubFixtureRoutes } from '../support/epub-fixture'
import { msg } from '../support/i18n'
import { selectReaderTextAndOpenMenu } from '../support/reader-selection'
import { installTauriMock } from '../support/tauri-mock'

const longPackageUrl = '/test-assets/long/OPS/package.opf'
const scrolledPackageUrl = '/test-assets/scrolled/OPS/package.opf'
const verticalPackageUrl = '/test-assets/vertical/OPS/package.opf'
const findShortcut = process.platform === 'darwin' ? 'Meta+F' : 'Control+F'
const dictionaryLayoutHtml = `<!doctype html><html><body>
  <section id="xxjs" data-section="词语解释">
    <div class="xxjs-reading-head">jiǎ yǐ bǐng dīng</div>
    <ol class="xxjs-list"><li class="xxjs-item"><span class="xxjs-item__def">用于浮层布局测试的合成释义。</span></li></ol>
  </section>
</body></html>`

interface BookTabState {
  id: string
  rendered: boolean
  turning: boolean
  bookCfi?: string
  currentTarget?: unknown
  renditionStartCfi?: string
  rejectedLocationEventCount: number
  startCfi?: string
  endCfi?: string
  startIndex?: number
  endIndex?: number
  visibleSectionIndexes: number[]
}

interface BookTabRuntimeCounters {
  id: string
  display?: number
  next?: number
  prev?: number
  relayoutCurrentView?: number
  resizeRendition?: number
  setActive?: number
}

interface TabStripMotion {
  animated: Array<{ label: string; target: string }>
  frames: Array<
    Array<{
      label: string
      height: number
      left: number
      top: number
      width: number
    }>
  >
}

function createBook(id: string, title: string) {
  return createTestBook({
    id,
    name: `${title}.epub`,
    size: 128000,
    metadata: {
      title,
      creator: 'Lewis Carroll',
      identifier: id,
      language: 'en',
    },
    updatedAt: 1,
    cfi: 'chapter_001.xhtml',
  })
}

function readerTabs(page: Page) {
  return page.locator('[data-flow-reader-tab-index]')
}

function readerTab(page: Page, title: string) {
  return readerTabs(page).filter({ hasText: title })
}

function listRow(scope: Page | Locator, text: string) {
  return scope.locator('.list-row').filter({ hasText: text }).first()
}

async function installReaderBooksMock(
  page: Page,
  titles = ['Tab Layout A', 'Tab Layout B', 'Tab Layout C'],
  packageUrl: string | string[] = epubFixturePackageUrl,
) {
  const books = titles.map((title, index) => createBook(`tab-layout-${String.fromCharCode(97 + index)}`, title))
  const packageUrls = Array.isArray(packageUrl) ? packageUrl : books.map(() => packageUrl)

  if (packageUrls.includes(epubFixturePackageUrl)) {
    await installEpubFixtureRoutes(page)
  }
  if (packageUrls.includes(longPackageUrl)) {
    await installLongBookRoutes(page)
  }
  if (packageUrls.includes(scrolledPackageUrl)) {
    await installScrolledBookRoutes(page)
  }
  if (packageUrls.includes(verticalPackageUrl)) {
    await installVerticalBookRoutes(page)
  }

  const imageIndexes = Object.fromEntries(
    books.map((book) => [
      book.id,
      {
        version: 1,
        sourceRevision: book.sourceRevision,
        revision: book.revision,
        sections: [
          {
            index: 0,
            href: 'cover.xhtml',
            images: [
              {
                src: 'images/cover_th.jpg',
                index: 0,
                hiddenByDefault: false,
              },
            ],
          },
        ],
      },
    ]),
  )
  await installTauriMock(page, {
    books,
    bookSearchResults: {
      'VERTICAL-CHAPTER-01-29': [
        {
          id: 'vertical-search-section-1',
          excerpt: 'VERTICAL-CHAPTER-01',
          description: 'Synthetic Vertical Reader',
          expanded: true,
          sectionIndex: 0,
          subitems: [
            {
              id: 'vertical-search-hit-1',
              excerpt: 'VERTICAL-CHAPTER-01-29',
              occurrence: 0,
            },
          ],
        },
      ],
    },
    imageIndexes,
    readerSources: Object.fromEntries(books.map((book, index) => [book.id, packageUrls[index]!])),
    settings: { dictionary: { zdic: { enabled: true } }, enableTextSelectionMenu: true, showLibraryInToc: true },
    zdicResponses: { 乙丙丁戊己庚: dictionaryLayoutHtml },
  })
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
    const searchTitle = `FLOW-SEARCH-TITLE-${String(number).padStart(3, '0')}`
    const paragraphs = Array.from({ length: 18 }, (_, index) => {
      return `<p>${title} paragraph ${index + 1}. The deterministic layout marker for this chapter is ${title}. This text is deliberately repeated to create several columns and stable pagination for stress testing.</p>`
    }).join('\n')

    return {
      contentType: 'application/xhtml+xml',
      body: `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head>
    <title>${title} ${searchTitle}</title>
    <link rel="stylesheet" href="style.css" type="text/css"/>
  </head>
  <body>
    <section><h1>${title} <span>${searchTitle}</span></h1>${paragraphs}</section>
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

function scrolledBookResource(pathname: string) {
  const normalized = pathname.replace(/^\/test-assets\/scrolled\/OPS\//, '')

  if (normalized === 'package.opf') {
    return {
      contentType: 'application/oebps-package+xml',
      body: `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="pub-id">flow.reader.scrolled.synthetic</dc:identifier>
    <dc:title>Synthetic Scrolled Reader</dc:title>
    <dc:language>en</dc:language>
    <meta property="rendition:layout">reflowable</meta>
    <meta property="rendition:flow">scrolled-continuous</meta>
    <meta property="dcterms:modified">2026-07-25T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="toc" properties="nav" href="toc.xhtml" media-type="application/xhtml+xml"/>
    <item id="style" href="style.css" media-type="text/css"/>
    <item id="chapter-1" href="chapter_001.xhtml" media-type="application/xhtml+xml"/>
    <item id="chapter-2" href="chapter_002.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="chapter-1"/>
    <itemref idref="chapter-2"/>
  </spine>
</package>`,
    }
  }

  if (normalized === 'toc.xhtml') {
    return {
      contentType: 'application/xhtml+xml',
      body: `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
  <head><title>Contents</title></head>
  <body><nav epub:type="toc"><ol>
    <li><a href="chapter_001.xhtml">SCROLLED-CHAPTER-01</a></li>
    <li><a href="chapter_002.xhtml">SCROLLED-CHAPTER-02</a></li>
  </ol></nav></body>
</html>`,
    }
  }

  if (normalized === 'style.css') {
    return {
      contentType: 'text/css',
      body: `html, body { margin: 0; }
body { font: 24px/1.6 serif; }
main, svg { display: block; width: 100%; }
svg { height: auto; }`,
    }
  }

  const chapterMatch = /^chapter_(00[12])\.xhtml$/.exec(normalized)
  if (chapterMatch) {
    const chapter = Number(chapterMatch[1])
    const marker = `SCROLLED-CHAPTER-${String(chapter).padStart(2, '0')}`
    const screens =
      chapter === 1
        ? `<div style="height: 1000px">${marker}</div>`
        : Array.from(
            { length: 10 },
            (_, index) =>
              `<svg viewBox="0 0 2 1" role="img" aria-label="${marker} screen ${index + 1}"><text x="0.1" y="0.2">${marker}</text></svg>`,
          ).join('')

    return {
      contentType: 'application/xhtml+xml',
      body: `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head>
    <title>${marker}</title>
    <link rel="stylesheet" href="style.css" type="text/css"/>
  </head>
  <body><main>${screens}</main></body>
</html>`,
    }
  }
}

async function installScrolledBookRoutes(page: Page) {
  await page.route('**/test-assets/scrolled/OPS/**', (route) => {
    const resource = scrolledBookResource(new URL(route.request().url()).pathname)

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

function verticalChapterMarkup(index: number, paragraphCount = 56) {
  const marker = `VERTICAL-CHAPTER-${String(index).padStart(2, '0')}`
  const searchTitle = `VERTICAL-SEARCH-TITLE-${String(index).padStart(2, '0')}`
  const paragraphs = Array.from({ length: paragraphCount }, (_, paragraphIndex) => {
    const token = `${marker}-${String(paragraphIndex + 1).padStart(2, '0')}`
    const note =
      index === 1 && paragraphIndex === 0 ? '<a id="note-ref" epub:type="noteref" href="#note-1">〔1〕</a>' : ''
    const selection =
      index === 1 && paragraphIndex === 1 ? '<span id="vertical-selection-target">甲乙丙丁戊己庚辛</span>' : token

    const anchor = index === 1 && paragraphIndex === 28 ? ' id="vertical-chapter-01-part-2"' : ''

    return `<p${anchor}>${selection}${note}　${token}　天地玄黄宇宙洪荒日月盈昃辰宿列张。${token}</p>`
  }).join('\n')
  const note =
    index === 1
      ? '<aside epub:type="footnote" id="note-1"><p data-flow-note-text="true">注释甲乙丙丁，内容按直排阅读。</p></aside>'
      : ''

  return `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
  <head>
    <title>${marker} ${searchTitle}</title>
    <link rel="stylesheet" href="style.css" type="text/css"/>
  </head>
  <body>
    <section>
      <h1 id="vertical-chapter-${String(index).padStart(2, '0')}-start">${marker}<span id="vertical-punctuation" class="punctuation">（甲）</span><span>${searchTitle}</span></h1>
      ${paragraphs}
      ${note}
    </section>
  </body>
</html>`
}

function verticalBookResource(pathname: string) {
  const normalized = pathname.replace(/^\/test-assets\/vertical\/OPS\//, '')

  if (normalized === 'package.opf') {
    return {
      contentType: 'application/oebps-package+xml',
      body: `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="pub-id">flow.reader.vertical.synthetic</dc:identifier>
    <dc:title>Synthetic Vertical Reader</dc:title>
    <dc:language>zh-Hant</dc:language>
    <meta property="dcterms:modified">2026-07-10T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="toc" properties="nav" href="toc.xhtml" media-type="application/xhtml+xml"/>
    <item id="style" href="style.css" media-type="text/css"/>
    <item id="chapter-1" href="chapter_001.xhtml" media-type="application/xhtml+xml"/>
    <item id="chapter-2" href="chapter_002.xhtml" media-type="application/xhtml+xml"/>
    <item id="chapter-3" href="chapter_003.xhtml" media-type="application/xhtml+xml"/>
    <item id="chapter-4" href="chapter_004.xhtml" media-type="application/xhtml+xml"/>
    <item id="chapter-5" href="chapter_005.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine page-progression-direction="rtl">
    <itemref idref="chapter-1"/>
    <itemref idref="chapter-2"/>
    <itemref idref="chapter-3"/>
    <itemref idref="chapter-4"/>
    <itemref idref="chapter-5"/>
  </spine>
</package>`,
    }
  }

  if (normalized === 'toc.xhtml') {
    return {
      contentType: 'application/xhtml+xml',
      body: `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
  <head><title>Contents</title></head>
  <body><nav epub:type="toc"><ol>
    <li><a href="chapter_001.xhtml#vertical-chapter-01-start">VERTICAL-CHAPTER-01</a><ol>
      <li><a href="chapter_001.xhtml#vertical-chapter-01-part-2">VERTICAL-CHAPTER-01-PART-2</a></li>
    </ol></li>
    <li><a href="chapter_002.xhtml">VERTICAL-CHAPTER-02</a></li>
    <li><a href="chapter_003.xhtml">VERTICAL-CHAPTER-03-SHORT</a></li>
    <li><a href="chapter_004.xhtml">VERTICAL-CHAPTER-04-TWO-PAGES</a></li>
    <li><a href="chapter_005.xhtml">VERTICAL-CHAPTER-05-AFTER</a></li>
  </ol></nav></body>
</html>`,
    }
  }

  if (normalized === 'style.css') {
    return {
      contentType: 'text/css',
      body: `html, body { writing-mode: vertical-rl; }
body { margin: 0; font-family: serif; }
p { margin: 0 0 0 1em; text-indent: 2em; line-height: 1.8; }
.punctuation { text-orientation: upright !important; }`,
    }
  }

  const chapterMatch = /^chapter_(00[1-5])\.xhtml$/.exec(normalized)
  if (chapterMatch) {
    const index = Number(chapterMatch[1])
    const paragraphCounts: Record<number, number> = {
      3: 2,
      4: 6,
      5: 2,
    }
    return {
      contentType: 'application/xhtml+xml',
      body: verticalChapterMarkup(index, paragraphCounts[index]),
    }
  }
}

async function installVerticalBookRoutes(page: Page) {
  await page.route('**/test-assets/vertical/OPS/**', (route) => {
    const resource = verticalBookResource(new URL(route.request().url()).pathname)

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
  await page.locator('ul.grid [data-flow-library-book-card]').nth(index).click()
}

async function openFixtureBookByName(page: Page, title: string) {
  const suffix = title.at(-1)?.toLowerCase()
  if (!suffix) throw new Error(`Missing fixture-book suffix for ${title}`)

  await page.locator(`.SideBar button[aria-label*="${title}"]`).click()
  await expect(readerTab(page, title)).toBeVisible()
  await expectFocusedTabId(page, `tab-layout-${suffix}`)
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
      if (typeof htmlEl.checkVisibility === 'function' && !htmlEl.checkVisibility({ checkVisibilityCSS: true })) {
        return false
      }

      const rect = el.getBoundingClientRect()
      const style = getComputedStyle(el)
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
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
          const blocks = doc ? Array.from(doc.querySelectorAll('body, section, p, h1, h2')) : []
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
      const el = document.elementFromPoint(window.innerWidth * xRatio, window.innerHeight - 12)
      const text = el?.textContent?.replace(/\s+/g, ' ').trim() ?? ''
      return text.match(/\d+\s*·\s*\d+(?:\s*\([^)]+\))?/g) ?? []
    })
    const footer = Array.from(new Set(footerMatches)).join('|')
    const header = Array.from(document.querySelectorAll('[data-flow-reader-header]'))
      .filter(isVisible)
      .map((el) => el.textContent?.replace(/\s+/g, ' ').trim() ?? '')
      .join(' ')
    const sidebar = document.querySelector('.SideBar')?.textContent?.replace(/\s+/g, ' ').trim() ?? ''
    const sidebarEl = document.querySelector('.SideBar')
    const sidebarVisible = sidebarEl ? isVisible(sidebarEl) : false
    const activePane = document.querySelector('[data-flow-reader-pane][aria-hidden="false"]')
    const activePaneRect = activePane?.getBoundingClientRect()
    const overlappingHiddenPanes = Array.from(
      document.querySelectorAll('[data-flow-reader-pane][aria-hidden="true"]'),
    ).filter((el) => {
      const style = getComputedStyle(el)
      if (style.display === 'none' || style.opacity === '0') return false

      const rect = el.getBoundingClientRect()
      return rect.right > 0 && rect.left < window.innerWidth && rect.bottom > 0 && rect.top < window.innerHeight
    }).length
    const tabs = Array.from(document.querySelectorAll('[data-flow-reader-tab-index]')).map((tab) => ({
      label: tab.textContent?.trim() ?? '',
      visible: isVisible(tab),
      selected: tab.className.includes('!text-foreground'),
    }))

    return {
      frames,
      footer,
      header,
      layoutSize: {
        height: Math.round(activePaneRect?.height ?? 0),
        width: Math.round(activePaneRect?.width ?? 0),
      },
      hiddenPanePaintStates: Array.from(document.querySelectorAll('[data-flow-reader-pane][aria-hidden="true"]')).map(
        (el) => {
          const style = getComputedStyle(el)
          return {
            opacity: style.opacity,
            visibility: style.visibility,
          }
        },
      ),
      overlappingHiddenPanes,
      sidebar,
      sidebarVisible,
      tabs,
    }
  })
}

async function readReaderPaneGeometry(page: Page) {
  return page.evaluate(() => {
    return Array.from(document.querySelectorAll('[data-flow-reader-pane]')).map((pane, index) => {
      const rect = pane.getBoundingClientRect()

      return {
        index,
        hidden: pane.getAttribute('aria-hidden') === 'true',
        left: Math.round(rect.left),
        top: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      }
    })
  })
}

function expectStablePaneGeometry(panes: Awaited<ReturnType<typeof readReaderPaneGeometry>>) {
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
      if (typeof htmlEl.checkVisibility === 'function' && !htmlEl.checkVisibility({ checkVisibilityCSS: true })) {
        return false
      }

      const rect = el.getBoundingClientRect()
      const style = getComputedStyle(el)
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
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
              (layout.sidebar.toLocaleLowerCase().includes(msg('toc.title').toLocaleLowerCase()) &&
                layout.sidebar.includes('Tab Layout A') &&
                layout.sidebar.includes('Tab Layout B')))
      const headerOk = options.header === false ? true : (options.header ?? /Down The Rabbit-Hole/).test(layout.header)

      return (
        layout.frames.length > 0 &&
        layout.frames.every(
          (frame) => frame.width > 250 && frame.maxTextBlockWidth > 180 && frame.maxTextBlockWidth <= frame.width + 4,
        ) &&
        headerOk &&
        layout.hiddenPanePaintStates.every((state) => state.opacity === '0' && state.visibility === 'hidden') &&
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

    return Array.from(document.querySelectorAll(`[ref="${markRef}"]`)).filter(isInActivePane).length
  }, ref)
}

async function expectVisibleReaderMarks(page: Page, ref: string, minimum: number) {
  await expect.poll(() => countVisibleReaderMarks(page, ref)).toBeGreaterThanOrEqual(minimum)
}

async function expectReaderMarkCursor(page: Page, ref: string) {
  const point = await page.evaluate((markRef) => {
    const mark = Array.from(document.querySelectorAll(`[ref="${markRef}"]`))
      .filter((candidate) => !candidate.closest('[aria-hidden="true"]'))
      .find((candidate) => {
        const rect = candidate.getBoundingClientRect()
        return rect.width > 0 && rect.height > 0
      })

    if (!mark) return

    const rect = mark.getBoundingClientRect()
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    }
  }, ref)

  if (!point) throw new Error(`Missing visible mark ${ref}`)

  await page.mouse.move(point.x, point.y)
  await expect
    .poll(() =>
      page.evaluate(() => {
        const activeFrames = Array.from(document.querySelectorAll('iframe')).filter(
          (frame) => !frame.closest('[aria-hidden="true"]'),
        )

        return activeFrames.some((frame) => {
          const doc = (frame as HTMLIFrameElement).contentDocument
          return doc?.documentElement?.style.cursor === 'pointer' || doc?.body?.style.cursor === 'pointer'
        })
      }),
    )
    .toBe(true)
}

async function addVisibleAnnotation(page: Page) {
  return page.evaluate(() => {
    const tab = (window as any).reader.focusedBookTab
    if (!tab?.iframe?.document?.body) {
      throw new Error('Missing active reader document')
    }

    const doc = tab.iframe.document
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node: Node) {
        const text = node.textContent ?? ''
        return /\bAlice\b/.test(text) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP
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
    tab.putAnnotation(cfi, 'yellow', range.toString(), undefined, section)

    return { cfi, text: range.toString() }
  })
}

async function expectHealthyLayoutWithSidebar(page: Page, sidebarVisible: boolean) {
  const layout = await waitForHealthyReaderLayout(page, { sidebarVisible })
  expect(layout.sidebarVisible).toBe(sidebarVisible)
  return layout
}

async function toggleTocSidebar(page: Page) {
  await page.locator(`.ActivityBar button[aria-label="${msg('toc.title')}"]`).click()
}

async function ensureTocSidebarVisibility(page: Page, visible: boolean, options: { header?: RegExp | false } = {}) {
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
      header: tab?.paginationSnapshot?.headerPath?.map((item: { label?: string }) => item.label ?? '').join(' '),
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

async function readActiveReaderBodyHeaderState(page: Page) {
  return page.evaluate(() => {
    const tab = (window as any).reader.focusedBookTab
    const activePane = document.querySelector('[data-flow-reader-pane][aria-hidden="false"]')
    const frames = Array.from(activePane?.querySelectorAll('iframe') ?? [])
      .filter((frame) => {
        const rect = frame.getBoundingClientRect()
        const style = getComputedStyle(frame)
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
      })
      .map((frame) => {
        const iframe = frame as HTMLIFrameElement
        return iframe.contentDocument?.body?.innerText ?? ''
      })
    const cover = activePane?.querySelector('[data-flow-reader-loading-cover]')
    const coverVisible = cover
      ? getComputedStyle(cover).display !== 'none' && getComputedStyle(cover).visibility !== 'hidden'
      : false

    return {
      body: frames.join('\n'),
      coverVisible,
      header: tab?.paginationSnapshot?.headerPath?.map((item: { label?: string }) => item.label ?? '').join(' ') ?? '',
      rendered: !!tab?.rendered,
      startIndex: tab?.paginationSnapshot?.location?.start?.index,
      turning: !!tab?.turning,
      visibleFrameCount: frames.length,
    }
  })
}

async function setLongBookAtSectionFinalSpread(page: Page, sectionIndex: number) {
  await page.evaluate(async (index) => {
    const tab = (window as any).reader.focusedBookTab
    const manager = tab?.rendition?.manager
    const section = tab?.sections?.find((candidate: { index?: number }) => candidate.index === index)
    if (!tab || !manager || !section) {
      throw new Error('Missing tab, manager, or section')
    }

    await tab.ensureSectionInfo(section)
    const pageCount = await manager.measureReflowableSectionPageCount(section)
    if (!pageCount) throw new Error('Missing measured page count')

    const requestId = ((tab.rendition._locationRequestId ?? 0) + 1) as number
    tab.rendition._locationRequestId = requestId
    tab.acceptedLocationRequests.set(requestId, { updateAnchor: true })
    await manager.renderReflowableSpread({
      anchor: 'right',
      endsAtSectionEnd: true,
      right: {
        section,
        pageIndex: pageCount - 1,
      },
    })
    await tab.rendition.reportLocation(requestId)
    tab.commitPendingRenditionLocation(requestId)
  }, sectionIndex)
}

async function expectFocusedTabId(page: Page, tabId: string) {
  await expect.poll(async () => (await readFocusedTabState(page)).tabId).toBe(tabId)
}

async function readAllBookTabStates(page: Page): Promise<BookTabState[]> {
  return page.evaluate(() => {
    return (window as any).reader.tabs.map((tab: any) => {
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
    for (const tab of (window as any).reader.tabs) {
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
    for (const tab of (window as any).reader.tabs) {
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

async function readBookTabRuntimeCounters(page: Page): Promise<BookTabRuntimeCounters[]> {
  return page.evaluate(() => {
    return (window as any).reader.tabs.map((tab: any) => ({
      id: tab.id,
      ...(tab.__flowRuntimeCounters ?? {}),
    }))
  })
}

async function installFullTabRuntimeProbe(page: Page) {
  await page.evaluate(() => {
    const tabs = (window as any).reader.tabs
    const valueSignature = (tab: any) => {
      const manager = tab.rendition?.manager
      const spread = manager?.currentReflowableSpread
      const location = tab.paginationSnapshot?.location

      return JSON.stringify({
        active: tab.active,
        activeResultID: tab.activeResultID,
        images: (tab.sections ?? []).map((section: any) =>
          (section.images ?? []).map((image: any) => ({
            hiddenByDefault: image.hiddenByDefault,
            index: image.index,
            reason: image.reason,
            src: image.src,
          })),
        ),
        keyword: tab.keyword,
        layout: {
          columnWidth: manager?.layout?.columnWidth,
          divisor: manager?.layout?.divisor,
          gap: manager?.layout?.gap,
          height: manager?.layout?.height,
          pageWidth: manager?.layout?.pageWidth,
          width: manager?.layout?.width,
          writingMode: manager?.writingMode,
        },
        overlayState: tab.overlayState,
        pagination: tab.paginationSnapshot && {
          endCfi: location?.end?.cfi,
          endIndex: location?.end?.index,
          headerPath: tab.paginationSnapshot.headerPath,
          layoutVersion: tab.paginationSnapshot.layoutVersion,
          paginationVersion: tab.paginationSnapshot.paginationVersion,
          percentage: tab.paginationSnapshot.percentage,
          spreadDivisor: tab.paginationSnapshot.spreadDivisor,
          spreadSlotOrder: tab.paginationSnapshot.spreadSlotOrder,
          startCfi: location?.start?.cfi,
          startIndex: location?.start?.index,
          writingMode: tab.paginationSnapshot.writingMode,
        },
        results: tab.results,
        spread: spread && {
          anchor: spread.anchor,
          endsAtSectionEnd: spread.endsAtSectionEnd,
          leftPageIndex: spread.left?.pageIndex,
          leftSectionIndex: spread.left?.section?.index,
          rightPageIndex: spread.right?.pageIndex,
          rightSectionIndex: spread.right?.section?.index,
        },
        typography: {
          book: tab.book.configuration?.typography,
          runtime: tab.typographyConfiguration,
        },
        versions: {
          layout: tab.layoutVersion,
          overlay: tab.overlayVersion,
          pagination: tab.paginationVersion,
          toc: tab.tocVersion,
          view: tab.viewVersion,
        },
        visibleSectionIndexes: [...(tab.visibleSectionIndexes ?? [])],
      })
    }

    ;(window as any).__flowFullTabRuntimeProbe = {
      tabs: tabs.map((tab: any) => {
        const manager = tab.rendition?.manager
        const views = manager?.views?._views ?? []

        return {
          bodyTextCache: tab.bodyTextCache,
          container: manager?.container,
          currentLocation: tab.currentLocation,
          epub: tab.epub,
          iframe: tab.iframe,
          iframes: tab.iframes,
          iframeItems: [...(tab.iframes ?? [])],
          id: tab.id,
          manager,
          nav: tab.nav,
          overlayState: tab.overlayState,
          paginationSnapshot: tab.paginationSnapshot,
          rendition: tab.rendition,
          results: tab.results,
          section: tab.section,
          sectionImages: (tab.sections ?? []).map((section: any) => section.images),
          sections: tab.sections,
          signature: valueSignature(tab),
          tab,
          typographyConfiguration: tab.typographyConfiguration,
          views,
          viewItems: [...views],
          visibleSections: tab.visibleSections,
        }
      }),
      valueSignature,
    }
  })
}

async function readFullTabRuntimeStability(page: Page) {
  return page.evaluate(() => {
    const tabs = (window as any).reader.tabs
    const probeState = (window as any).__flowFullTabRuntimeProbe
    const probes = probeState?.tabs ?? []
    const valueSignature = probeState?.valueSignature
    const sameItems = (current: any[] | undefined, before: any[]) =>
      !!current && current.length === before.length && current.every((item, index) => item === before[index])
    return probes.map((probe: any) => {
      const tab = tabs.find((candidate: any) => candidate.id === probe.id)
      const manager = tab?.rendition?.manager
      const views = manager?.views?._views ?? []

      return {
        bodyTextCache: tab?.bodyTextCache === probe.bodyTextCache,
        container: manager?.container === probe.container,
        currentLocation: tab?.currentLocation === probe.currentLocation,
        epub: tab?.epub === probe.epub,
        iframe: tab?.iframe === probe.iframe,
        iframes: tab?.iframes === probe.iframes && sameItems(tab?.iframes, probe.iframeItems),
        manager: manager === probe.manager,
        nav: tab?.nav === probe.nav,
        overlayState: tab?.overlayState === probe.overlayState,
        paginationSnapshot: tab?.paginationSnapshot === probe.paginationSnapshot,
        rendition: tab?.rendition === probe.rendition,
        results: tab?.results === probe.results,
        section: tab?.section === probe.section,
        sectionImages:
          tab?.sections?.length === probe.sectionImages.length &&
          tab.sections.every((section: any, index: number) => section.images === probe.sectionImages[index]),
        sections: tab?.sections === probe.sections,
        signature: !!tab && valueSignature(tab) === probe.signature,
        tab: tab === probe.tab,
        typographyConfiguration: tab?.typographyConfiguration === probe.typographyConfiguration,
        views: views === probe.views && sameItems(views, probe.viewItems),
        visibleSections: tab?.visibleSections === probe.visibleSections,
      }
    })
  })
}

async function readTabStripMotion(page: Page): Promise<TabStripMotion> {
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
        .map((part) => (part.endsWith('ms') ? Number(part.slice(0, -2)) / 1000 : Number(part.replace(/s$/, ''))))
        .filter((value) => Number.isFinite(value))

    function hasMotionTransition(style: CSSStyleDeclaration) {
      const durations = parseSeconds(style.transitionDuration)
      if (!durations.some((duration) => duration > 0)) return false

      const properties = style.transitionProperty.split(',').map((property) => property.trim())
      return properties.some((property) => motionProperties.has(property))
    }

    function tabMetrics() {
      return Array.from(document.querySelectorAll('[data-flow-reader-tab-index]')).map((tab) => {
        const rect = tab.getBoundingClientRect()
        return {
          label: tab.textContent?.trim() ?? '',
          height: Math.round(rect.height * 100) / 100,
          left: Math.round(rect.left * 100) / 100,
          top: Math.round(rect.top * 100) / 100,
          width: Math.round(rect.width * 100) / 100,
        }
      })
    }

    const tabElements = Array.from(document.querySelectorAll('[data-flow-reader-tab-index]')) as HTMLElement[]
    const animated = tabElements.flatMap((tab) => {
      const label = tab.textContent?.trim() ?? ''
      const items: Array<{ label: string; target: string }> = []
      const targets: Array<readonly [string, Element]> = [
        ['self', tab],
        ...Array.from(tab.querySelectorAll('*')).map((element, index) => [`child:${index}`, element] as const),
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
    const tabElements = () => Array.from(document.querySelectorAll('[data-flow-reader-tab-index]')) as HTMLElement[]
    const tabMetrics = () =>
      tabElements().map((tab) => {
        const rect = tab.getBoundingClientRect()
        return {
          label: tab.textContent?.trim() ?? '',
          height: Math.round(rect.height * 100) / 100,
          left: Math.round(rect.left * 100) / 100,
          top: Math.round(rect.top * 100) / 100,
          width: Math.round(rect.width * 100) / 100,
        }
      })
    const runtimeCounters = () => {
      return (window as any).reader.tabs.map((tab: any) => ({
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

    const target = tabElements().find((tab) => tab.textContent?.trim() === targetLabel)
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

async function addRightPageDefinitionAndAnnotation(page: Page, sectionIndex: number) {
  return page.evaluate((targetSectionIndex) => {
    const tab = (window as any).reader.focusedBookTab
    const views = tab?.rendition?.manager?.views?._views ?? []
    const view = views.find((candidate: any) => candidate?.section?.index === targetSectionIndex)
    const doc = view?.document ?? view?.contents?.document
    if (!tab || !view || !doc?.body) {
      throw new Error('Missing target right-page view')
    }

    const viewportWidth = doc.documentElement.clientWidth || window.innerWidth
    const viewportHeight = doc.documentElement.clientHeight || window.innerHeight
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node: Node) {
        return /[A-Za-z]{4,}/.test(node.textContent ?? '') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP
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
        tab.putAnnotation(cfi, 'yellow', range.toString(), undefined, section)

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
    const previousWidths = previous.frames.map((frame) => Math.round(frame.width))
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
  const packageUrl = testInfo.title.includes('[vertical-rl]')
    ? [epubFixturePackageUrl, verticalPackageUrl, verticalPackageUrl]
    : testInfo.title.includes('[scrolled-doc]')
      ? scrolledPackageUrl
      : testInfo.title.includes('long-book')
        ? longPackageUrl
        : epubFixturePackageUrl
  await installReaderBooksMock(page, undefined, packageUrl)
  await page.goto('/')
  await expect(page.locator('#layout')).toBeVisible()
  await expect(page.locator('ul.grid [data-flow-library-book-card]')).toHaveCount(3)
})

test('updates the rendered iframe after a mocked book text replacement', async ({ page }) => {
  await openFixtureBook(page, 0)
  await waitForStableReaderLayout(page, { header: false })

  const result = await page.evaluate(async () => {
    const reader = (window as any).reader
    const tab = reader.focusedBookTab
    const frame = Array.from(document.querySelectorAll('iframe')).find(
      (candidate) => !candidate.closest('[aria-hidden="true"]') && Boolean(candidate.contentDocument?.body),
    )
    const frameDocument = frame?.contentDocument
    if (!tab || !frameDocument?.body) {
      throw new Error('Missing active reader frame')
    }

    const walker = frameDocument.createTreeWalker(frameDocument.body, NodeFilter.SHOW_TEXT)
    let textNodeIndex = 0
    let textNode = walker.nextNode() as Text | null
    while ((textNode?.textContent?.trim().length ?? 0) < 10) {
      textNode = walker.nextNode() as Text | null
      textNodeIndex += 1
    }
    if (textNode?.nodeType !== Node.TEXT_NODE || !textNode.textContent) {
      throw new Error('Missing editable reader text')
    }

    const oldText = textNode.textContent
    const newText = 'FLOW-RENDERED-TEXT-EDIT'
    const range = frameDocument.createRange()
    range.selectNodeContents(textNode)
    const section = tab.sectionForRange(range)
    if (!section?.href) throw new Error('Missing active reader section')

    await reader.applyBookContentEdit(
      {
        ...tab.book,
        revision: tab.book.revision + 1,
        updatedAt: tab.book.updatedAt + 1,
      },
      section.href,
      tab,
      {
        target: {
          sectionHref: section.href,
          textNodeIndex,
          textNodeText: oldText,
          startOffset: 0,
          endOffset: oldText.length,
        },
        oldText,
        newText,
        document: frameDocument,
        textNode,
      },
    )

    return {
      renderedText: textNode.textContent,
      revision: tab.book.revision,
    }
  })

  expect(result).toEqual({
    renderedText: 'FLOW-RENDERED-TEXT-EDIT',
    revision: 2,
  })
})

test('allows editing a plain paragraph selected from its trailing paragraph break', async ({ page }) => {
  await openFixtureBook(page, 0)
  await waitForStableReaderLayout(page, { header: false })

  const activeFrame = page
    .locator('[data-flow-reader-pane][aria-hidden="false"] iframe')
    .filter({ visible: true })
    .first()
  const paragraph = activeFrame.contentFrame().locator('p').filter({ visible: true }).first()
  await paragraph.evaluate((element) => {
    element.textContent = 'some'
    const next = element.nextElementSibling
    if (next?.tagName.toLowerCase() === 'p') next.textContent = 'text'
  })
  const selectedText = await paragraph.evaluate((element) => {
    const text = element.firstChild
    const frameWindow = element.ownerDocument.defaultView
    if (!text || !frameWindow) throw new Error('Missing paragraph selection target')
    const next = element.nextElementSibling
    if (next?.tagName.toLowerCase() !== 'p') throw new Error('Missing next paragraph')
    const range = element.ownerDocument.createRange()
    range.setStart(text, 0)
    range.setEnd(next, 0)
    const selection = frameWindow.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    const rect = range.getBoundingClientRect()
    frameWindow.dispatchEvent(
      new frameWindow.MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: rect.right,
        clientY: rect.bottom,
      }),
    )
    return selection?.toString()
  })
  expect(selectedText?.trim()).toBe('some')

  const editText = page.getByRole('button', { name: msg('menu.edit_text') })
  await expect(editText).toBeVisible()
  await expect(editText).toBeEnabled()
  await editText.click()
  await expect(page.getByRole('textbox', { name: msg('menu.edit_text') })).toHaveValue('some')
})

test('refreshes the current table of contents after a generated TXT heading replacement', async ({ page }) => {
  await openFixtureBook(page, 0)
  await waitForStableReaderLayout(page, { header: false })
  await ensureTocSidebarVisibility(page, true, { header: false })

  const result = await page.evaluate(async () => {
    const reader = (window as any).reader
    const tab = reader.focusedBookTab
    const frame = Array.from(document.querySelectorAll('iframe')).find(
      (candidate) => !candidate.closest('[aria-hidden="true"]') && Boolean(candidate.contentDocument?.body),
    )
    const frameDocument = frame?.contentDocument
    if (!tab || !frameDocument?.body) throw new Error('Missing active reader frame')

    const heading = frameDocument.createElement('h1')
    heading.className = 'flow-txt-volume'
    heading.textContent = 'Volume One'
    frameDocument.body.prepend(heading)
    const textNode = heading.firstChild
    if (!(textNode instanceof frameDocument.defaultView!.Text)) throw new Error('Missing generated TXT heading')

    const range = frameDocument.createRange()
    range.selectNodeContents(textNode)
    const section = tab.sectionForRange(range)
    const navItem = section?.navitem ?? tab.mapSectionToNavItem(section?.href)
    if (!section?.href || !navItem) throw new Error('Missing generated TXT navigation item')
    navItem.label = 'Volume One'
    const previousTocVersion = tab.tocVersion

    await reader.applyBookContentEdit(
      {
        ...tab.book,
        sourceFormat: 'txt',
        revision: tab.book.revision + 1,
        updatedAt: tab.book.updatedAt + 1,
      },
      section.href,
      tab,
      {
        target: {
          sectionHref: section.href,
          textNodeIndex: 0,
          textNodeText: 'Volume One',
          startOffset: 7,
          endOffset: 10,
        },
        oldText: 'One',
        newText: 'Two',
        document: frameDocument,
        textNode,
      },
    )

    return {
      heading: heading.textContent,
      navLabel: navItem.label,
      tocVersionDelta: tab.tocVersion - previousTocVersion,
    }
  })

  expect(result).toEqual({
    heading: 'Volume Two',
    navLabel: 'Volume Two',
    tocVersionDelta: 1,
  })
  await expect(page.getByRole('button', { name: 'Volume Two', exact: true })).toBeVisible()
})

test('reloads an imported replacement now for the active tab and on activation for an inactive tab', async ({
  page,
}) => {
  await openFixtureBook(page, 0)
  await waitForStableReaderLayout(page)
  await openFixtureBookByName(page, 'Tab Layout B')
  await waitForStableReaderLayout(page)

  const immediate = await page.evaluate(async () => {
    const reader = (window as any).reader
    const [inactiveTab, activeTab] = reader.tabs
    if (!inactiveTab?.rendition || !activeTab?.rendition) {
      throw new Error('Missing reader renditions')
    }

    ;(window as any).__flowImportReloadRefs = {
      inactiveRendition: inactiveTab.rendition,
      activeRendition: activeTab.rendition,
    }
    const replacements = [
      {
        ...inactiveTab.book,
        sourceHash: 'replacement-a',
        sourceRevision: Math.max(inactiveTab.book.sourceRevision, inactiveTab.book.revision) + 1,
      },
      {
        ...activeTab.book,
        sourceHash: 'replacement-b',
        sourceRevision: Math.max(activeTab.book.sourceRevision, activeTab.book.revision) + 1,
      },
    ]
    const invoke = (window as any).__TAURI_INTERNALS__?.invoke
    if (!invoke) throw new Error('Missing Tauri invoke mock')
    await Promise.all(
      replacements.map((book) =>
        invoke('update_book', {
          id: book.id,
          changes: {
            sourceHash: book.sourceHash,
            sourceRevision: book.sourceRevision,
          },
        }),
      ),
    )
    reader.refreshImportedBooks(replacements)

    return {
      activeRenditionCleared: !activeTab.rendition,
      activeSourceRevision: activeTab.book.sourceRevision,
      inactiveRenditionPreserved: inactiveTab.rendition === (window as any).__flowImportReloadRefs.inactiveRendition,
      inactiveSourceRevision: inactiveTab.book.sourceRevision,
    }
  })

  expect(immediate).toEqual({
    activeRenditionCleared: true,
    activeSourceRevision: 2,
    inactiveRenditionPreserved: true,
    inactiveSourceRevision: 1,
  })

  await waitForStableReaderLayout(page)
  await readerTab(page, 'Tab Layout A').click()
  await waitForStableReaderLayout(page)

  const activated = await page.evaluate(() => {
    const tab = (window as any).reader.focusedBookTab
    return {
      renditionReplaced: tab.rendition !== (window as any).__flowImportReloadRefs.inactiveRendition,
      sourceRevision: tab.book.sourceRevision,
    }
  })

  expect(activated).toEqual({
    renditionReplaced: true,
    sourceRevision: 2,
  })
})

const SIDEBAR_SCROLLBAR_WIDTH = 10
const SIDEBAR_EDGE_EPSILON = 0.5

async function expectFullWidthScroll(scroll: Locator) {
  await expect
    .poll(() => scroll.evaluate((element) => element.clientWidth === (element as HTMLElement).offsetWidth))
    .toBe(true)
}

async function expectFullWidthRow(scroll: Locator, row: Locator, reservedContent?: Locator) {
  await expect
    .poll(async () => {
      const [scrollBox, rowBox, contentBox] = await Promise.all([
        scroll.boundingBox(),
        row.boundingBox(),
        reservedContent?.boundingBox(),
      ])
      if (!scrollBox || !rowBox || (reservedContent && !contentBox)) {
        return false
      }

      const scrollRight = scrollBox.x + scrollBox.width
      const rowRight = rowBox.x + rowBox.width
      const contentRight = contentBox ? contentBox.x + contentBox.width : undefined

      return (
        Math.abs(rowRight - scrollRight) < SIDEBAR_EDGE_EPSILON &&
        (contentRight === undefined || contentRight <= scrollRight - SIDEBAR_SCROLLBAR_WIDTH + SIDEBAR_EDGE_EPSILON)
      )
    })
    .toBe(true)
}

async function expectVisibleOverlayScrollbar(scroll: Locator) {
  await expectFullWidthScroll(scroll)
  const scrollbar = scroll.locator('..').locator('[data-orientation="vertical"]')

  await expect(scrollbar).toHaveCSS('opacity', '1')
  await expect
    .poll(() => scrollbar.evaluate((element) => element.getBoundingClientRect().width))
    .toBe(SIDEBAR_SCROLLBAR_WIDTH)

  return scrollbar
}

test('applies overlay and reserved scrollbar width to the matching sidebars', async ({ page }) => {
  const activityBar = page.locator('.ActivityBar')
  const sidebar = page.locator('.SideBar')

  await page.setViewportSize({ width: 1000, height: 1200 })
  await openFixtureBook(page, 0)
  if (!(await sidebar.isVisible())) {
    await activityBar.getByRole('button', { name: msg('toc.title') }).click()
  }
  await expect(sidebar).toBeVisible()

  const tocPane = sidebar.locator('.Pane').last()
  const tocScroll = tocPane.locator('[data-pane-scroll]')
  await expect
    .poll(() =>
      tocScroll.evaluate((element) => ({
        fullWidth: element.clientWidth === (element as HTMLElement).offsetWidth,
        overflowing: element.scrollHeight > element.clientHeight,
      })),
    )
    .toEqual({ fullWidth: true, overflowing: false })
  await tocPane.hover()
  await expect(tocPane.locator('[data-orientation="vertical"]')).toHaveCount(0)

  await page.setViewportSize({ width: 1000, height: 420 })
  await expect
    .poll(() =>
      tocScroll.evaluate((element) => ({
        fullWidth: element.clientWidth === (element as HTMLElement).offsetWidth,
        overflowing: element.scrollHeight > element.clientHeight,
      })),
    )
    .toEqual({ fullWidth: true, overflowing: true })
  const tocRow = tocScroll.locator('.list-row').first()
  await tocRow.hover()
  const scrollbar = await expectVisibleOverlayScrollbar(tocScroll)
  await expectFullWidthRow(tocScroll, tocRow)
  const thumb = tocPane.locator('[data-pane-scrollbar-thumb]')
  const thumbBox = await thumb.boundingBox()
  if (!thumbBox) throw new Error('Missing TOC scrollbar thumb bounds')
  expect(thumbBox.width).toBe(10)
  const scrollTopBeforeDrag = await tocScroll.evaluate((element) => element.scrollTop)
  await page.mouse.move(thumbBox.x + thumbBox.width / 2, thumbBox.y + thumbBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(thumbBox.x + thumbBox.width / 2, thumbBox.y + thumbBox.height / 2 + 20)
  await page.mouse.up()
  await expect.poll(() => tocScroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(scrollTopBeforeDrag)
  await page.mouse.move(500, 200)
  await expect.poll(() => scrollbar.evaluate((element) => getComputedStyle(element).opacity)).toBe('0')
  await page.setViewportSize({ width: 1000, height: 220 })

  await page.evaluate(() => {
    const tab = (window as any).reader.focusedBookTab
    tab.keyword = 'needle'
    tab.results = Array.from({ length: 8 }, (_, groupIndex) => ({
      id: `group-${groupIndex}`,
      excerpt: `Synthetic group ${groupIndex + 1}`,
      expanded: groupIndex === 0,
      subitems: Array.from({ length: 55 }, (_, resultIndex) => ({
        id: `result-${groupIndex}-${resultIndex}`,
        excerpt: `Synthetic needle result ${resultIndex + 1}`,
      })),
    }))
    tab.activeResultID = 'result-0-0'
  })
  await activityBar.getByRole('button', { name: msg('search.title') }).click()
  const searchScroll = sidebar.locator('[data-pane-scroll]').last()
  const resultCount = searchScroll.getByText('55', { exact: true }).first()
  await expect(resultCount).toBeVisible()
  await resultCount.hover()
  const selectedSearchRow = searchScroll.locator('[aria-current="true"]')
  await expect(selectedSearchRow).toBeVisible()
  await selectedSearchRow.click()
  await expectFullWidthRow(searchScroll, selectedSearchRow, resultCount)
  await expectVisibleOverlayScrollbar(searchScroll)

  await page.evaluate(() => {
    const tab = (window as any).reader.focusedBookTab
    tab.define(Array.from({ length: 20 }, (_, index) => `Synthetic definition ${index + 1}`))
  })
  await activityBar.getByRole('button', { name: msg('annotation.title') }).click()
  for (const scroll of await sidebar.locator('[data-pane-scroll]').all()) {
    await expectFullWidthScroll(scroll)
  }
  const annotationScroll = sidebar.locator('[data-pane-scroll]').first()
  const annotationRow = annotationScroll.locator('.list-row').first()
  const annotationAction = annotationRow.locator('.action')
  await annotationRow.hover()
  await expectFullWidthRow(annotationScroll, annotationRow, annotationAction)
  await expectVisibleOverlayScrollbar(annotationScroll)

  await activityBar.getByRole('button', { name: msg('image.title') }).click()
  const imageScroll = sidebar.locator('[data-pane-scroll]').last()
  const imageRow = imageScroll.locator('.list-row').first()
  const imageBadge = imageRow.locator('.rounded-full')
  await imageRow.hover()
  await expectFullWidthRow(imageScroll, imageRow, imageBadge)
  await imageRow.click()
  const selectedImage = imageScroll.locator('button:has(img)').first()
  await expect(selectedImage).toBeVisible()
  await selectedImage.click()
  await expectFullWidthRow(imageScroll, selectedImage, selectedImage.locator('img'))
})

test('long-book ignores stale fixed height for the flexible TOC pane', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  await page.evaluate(() => {
    window.localStorage.setItem('flow-reader:pane:toc:toc', '1800')
  })
  await page.reload()
  await expect(page.locator('ul.grid [data-flow-library-book-card]')).toHaveCount(3)
  await openFixtureBook(page, 0)
  await expect(page.locator('.SideBar .Pane').last()).toBeVisible()

  const geometry = await page.locator('.SideBar').evaluate((sidebar) => {
    const pane = Array.from(sidebar.querySelectorAll('.Pane')).at(-1)
    const scroll = pane?.querySelector('[data-pane-scroll]')
    const rect = (element: Element | null | undefined) => {
      const value = element?.getBoundingClientRect()
      return value ? { bottom: value.bottom, height: value.height, top: value.top } : undefined
    }
    return {
      pane: rect(pane),
      scroll: rect(scroll),
      sidebar: rect(sidebar),
    }
  })
  expect(geometry.pane?.bottom).toBeLessThanOrEqual((geometry.sidebar?.bottom ?? 0) + 0.5)
  expect(geometry.scroll?.bottom).toBeLessThanOrEqual((geometry.sidebar?.bottom ?? 0) + 0.5)

  const scroll = page.locator('.SideBar .Pane').last().locator('[data-pane-scroll]')
  await expect(scroll.getByRole('button', { name: 'FLOW-CHAPTER-001' })).toBeVisible()
  await expect.poll(() => scroll.evaluate((element) => element.scrollHeight)).toBe(620 * 24)
  await scroll.evaluate((element) => {
    element.scrollTop = element.scrollHeight
  })
  await expect(scroll.getByRole('button', { name: 'FLOW-CHAPTER-620' })).toBeVisible()
})

test('lets TOC and annotation splits reach both bounds without overflowing', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  await openFixtureBook(page, 0)

  const sidebar = page.locator('.SideBar')
  const expectBoundaryDragInBounds = async () => {
    const panes = sidebar.locator('.Pane:visible')
    const sash = sidebar.locator('.sash.cursor-ns-resize:visible')
    await expect(panes).toHaveCount(2)
    await expect(sash).toHaveCount(1)

    const sidebarBox = await sidebar.boundingBox()
    const sashBox = await sash.boundingBox()
    expect(sidebarBox).not.toBeNull()
    expect(sashBox).not.toBeNull()
    if (!sidebarBox || !sashBox) return

    const x = sashBox.x + sashBox.width / 2
    await page.mouse.move(x, sashBox.y + sashBox.height / 2)
    await page.mouse.down()
    await page.mouse.move(x, sidebarBox.y - 200)

    await expect.poll(() => panes.first().evaluate((pane) => pane.getBoundingClientRect().height)).toBeCloseTo(28, 0)

    await page.mouse.move(x, sidebarBox.y + sidebarBox.height + 200)

    const geometry = await sidebar.evaluate((element) => {
      const paneRects = Array.from(element.querySelectorAll('.Pane'))
        .filter((pane) => (pane as HTMLElement).checkVisibility())
        .map((pane) => pane.getBoundingClientRect())
      const sidebarRect = element.getBoundingClientRect()
      return {
        paneHeights: paneRects.map((rect) => rect.height),
        paneBottoms: paneRects.map((rect) => rect.bottom),
        paneTops: paneRects.map((rect) => rect.top),
        sidebarBottom: sidebarRect.bottom,
        sidebarTop: sidebarRect.top,
      }
    })

    await page.mouse.up()

    expect(geometry.paneHeights.at(-1)).toBeCloseTo(28, 0)
    expect(geometry.paneBottoms.at(-1)).toBeCloseTo(geometry.sidebarBottom, 0)
    expect(Math.min(...geometry.paneTops)).toBeGreaterThanOrEqual(geometry.sidebarTop - 0.5)
    expect(Math.max(...geometry.paneBottoms)).toBeLessThanOrEqual(geometry.sidebarBottom + 0.5)
  }

  await expectBoundaryDragInBounds()
  await page.locator(`.ActivityBar button[aria-label="${msg('annotation.title')}"]`).click()
  await expectBoundaryDragInBounds()
})

async function openVerticalFixtureBook(page: Page) {
  await openFixtureBook(page, 0)
  await waitForStableReaderLayout(page, { header: false })
  await openFixtureBookByName(page, 'Tab Layout B')
  await waitForVerticalReaderLoaded(page)
}

async function waitForVerticalReaderLoaded(page: Page) {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const tab = (window as any).reader.focusedBookTab
          const pane = document.querySelector('[data-flow-reader-pane][aria-hidden="false"]')
          const frame = Array.from(pane?.querySelectorAll('iframe') ?? []).find(
            (candidate) => candidate.getBoundingClientRect().width > 0,
          ) as HTMLIFrameElement | undefined

          return Boolean(
            tab?.rendered && tab?.rendition?.manager?.writingMode === 'vertical-rl' && frame?.contentDocument?.body,
          )
        }),
      { timeout: 10000 },
    )
    .toBe(true)
}

test('normalizes typography number fields when editing ends', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  await openFixtureBook(page, 0)
  await waitForStableReaderLayout(page, { header: false })
  await page.locator('.ActivityBar button[aria-label="Typography"]').click()

  const sidebar = page.locator('.SideBar')
  const setAndBlur = async (name: string, input: string, expected: string) => {
    const field = sidebar.locator(`input[name="${name}"]`)
    await field.fill(input)
    await field.blur()
    await expect(field).toHaveValue(expected)
  }

  await setAndBlur(msg('typography.zoom'), '0', '1')
  await setAndBlur(msg('typography.font_size'), '40', '28')
  await setAndBlur(msg('typography.font_weight'), '155', '200')
  await setAndBlur(msg('typography.line_height'), '0.5', '1')
  await setAndBlur(msg('typography.text_indent'), '-2', '0')
})

test('toggles page appearance without changing reader pagination geometry', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  await openFixtureBook(page, 0)
  await waitForStableReaderLayout(page, { header: false })
  await page.locator('.ActivityBar button[aria-label="Typography"]').click()

  const sidebar = page.locator('.SideBar')
  const activePane = page.locator('[data-flow-reader-pane][aria-hidden="false"]')
  const content = activePane.locator('[data-flow-reader-content]')
  const paneRoot = activePane.locator('[data-flow-page-appearance]')

  await expect(sidebar.getByText(msg('typography.page_appearance'), { exact: true })).toBeVisible()
  await expect(paneRoot).toHaveCount(0)
  await installBookTabRuntimeCounters(page)
  await resetBookTabRuntimeCounters(page)

  await sidebar.getByRole('button', { name: msg('typography.page_appearance.cards'), exact: true }).click()
  await expect(paneRoot).toHaveAttribute('data-flow-page-appearance', 'cards')
  await expect(content).toHaveAttribute('data-flow-reader-spread', 'double')

  const cardGeometry = await content.evaluate((element) => {
    const start = element.querySelector('[data-flow-reader-page-frame="start"]')
    const end = element.querySelector('[data-flow-reader-page-frame="end"]')
    if (!start || !end) throw new Error('Missing card page frames')
    const startRect = start.getBoundingClientRect()
    const endRect = end.getBoundingClientRect()
    const style = getComputedStyle(element)

    return {
      actualGap: Math.round(endRect.left - startRect.right),
      expectedGap: Math.round(Number.parseFloat(style.getPropertyValue('--flow-reader-page-gap'))),
      startRadius: getComputedStyle(start).borderRadius,
      endRadius: getComputedStyle(end).borderRadius,
      headerShadow: getComputedStyle(document.querySelector('[data-flow-reader-header]')!).boxShadow,
      footerShadow: getComputedStyle(document.querySelector('[data-flow-reader-footer]')!).boxShadow,
    }
  })
  expect(cardGeometry).toEqual({
    actualGap: cardGeometry.expectedGap,
    expectedGap: cardGeometry.expectedGap,
    startRadius: '16px',
    endRadius: '16px',
    headerShadow: 'none',
    footerShadow: 'none',
  })

  const darkCardGeometry = await content.evaluate((element) => {
    const root = document.documentElement
    const frame = element.querySelector('[data-flow-reader-page-frame="start"]')
    if (!frame) throw new Error('Missing card page frame')
    const lightStyle = getComputedStyle(frame)
    const lightBorderColor = lightStyle.borderColor
    const lightShadow = lightStyle.boxShadow
    root.classList.add('dark')
    const darkStyle = getComputedStyle(frame)
    const result = {
      borderColorChanged: darkStyle.borderColor !== lightBorderColor,
      shadowChanged: darkStyle.boxShadow !== lightShadow,
      shadow: darkStyle.boxShadow,
    }
    root.classList.remove('dark')
    return result
  })
  expect(darkCardGeometry).toMatchObject({
    borderColorChanged: true,
    shadowChanged: true,
  })
  expect(darkCardGeometry.shadow).toContain('0px 6px 18px')

  await sidebar.getByRole('button', { name: msg('typography.page_appearance.cards'), exact: true }).click()
  await expect(paneRoot).toHaveCount(0)
  await expect(content.locator('[data-flow-reader-page-decoration]')).toHaveCount(0)

  await sidebar.getByRole('button', { name: msg('typography.page_appearance.book'), exact: true }).click()
  await expect(paneRoot).toHaveAttribute('data-flow-page-appearance', 'book')
  await expect(content.locator('[data-flow-reader-page-seam]')).toHaveCSS('display', 'block')
  const bookDecoration = await content.evaluate((element) => {
    const frame = element.querySelector('[data-flow-reader-page-frame="start"]')
    const seam = element.querySelector('[data-flow-reader-page-seam]')
    if (!frame || !seam) throw new Error('Missing book decoration')
    const frameStyle = getComputedStyle(frame)
    const seamStyle = getComputedStyle(seam)
    const contentRect = element.getBoundingClientRect()
    const frameRect = frame.getBoundingClientRect()

    return {
      borderTopWidth: frameStyle.borderTopWidth,
      frameInsets: {
        left: frameRect.left - contentRect.left,
        right: contentRect.right - frameRect.right,
      },
      frameBackground: frameStyle.backgroundImage,
      frameBackgroundSize: frameStyle.backgroundSize,
      seamBackground: seamStyle.backgroundImage,
      seamWidth: seamStyle.width,
    }
  })
  expect(bookDecoration.borderTopWidth).toBe('0px')
  expect(bookDecoration.frameInsets.left).toBeCloseTo(0, 5)
  expect(bookDecoration.frameInsets.right).toBeCloseTo(0, 5)
  expect(bookDecoration.frameBackground.match(/linear-gradient/g)).toHaveLength(4)
  expect(bookDecoration.frameBackgroundSize).toContain('12px 100%')
  expect(bookDecoration.seamBackground).toContain('linear-gradient')
  expect(bookDecoration.seamWidth).toBe('96px')

  await sidebar.getByRole('button', { name: msg('typography.page_appearance.divider'), exact: true }).click()
  await expect(paneRoot).toHaveAttribute('data-flow-page-appearance', 'divider')
  const dividerGeometry = await content.evaluate((element) => {
    const seam = element.querySelector('[data-flow-reader-page-seam]')
    if (!seam) throw new Error('Missing divider seam')
    const contentRect = element.getBoundingClientRect()
    const seamRect = seam.getBoundingClientRect()

    return {
      top: Math.round(seamRect.top - contentRect.top),
      bottom: Math.round(contentRect.bottom - seamRect.bottom),
      width: Number.parseFloat(getComputedStyle(seam).width),
    }
  })
  expect(dividerGeometry).toEqual({ top: 0, bottom: 0, width: 1.5 })
  const appearanceCounters = (await readBookTabRuntimeCounters(page)).find((entry) => entry.id === 'tab-layout-a')
  expect(appearanceCounters).toMatchObject({
    display: 0,
    next: 0,
    prev: 0,
    relayoutCurrentView: 0,
    resizeRendition: 0,
  })

  await sidebar.getByRole('button', { name: msg('typography.page_view.single_page'), exact: true }).click()
  await expect(content).toHaveAttribute('data-flow-reader-spread', 'single')
  await expect(content.locator('[data-flow-reader-page-seam]')).toHaveCSS('display', 'none')

  await sidebar.getByRole('button', { name: msg('typography.page_appearance.divider'), exact: true }).click()
  await expect(paneRoot).toHaveCount(0)
})

test('[vertical-rl] page appearance follows actual spread geometry', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  await openVerticalFixtureBook(page)

  await page.evaluate(() => {
    const tab = (window as any).reader.focusedBookTab
    tab.updateConfiguration({
      ...tab.book.configuration,
      typography: {
        ...tab.book.configuration?.typography,
        pageAppearance: 'divider',
      },
    })
  })

  const content = page.locator('[data-flow-reader-pane][aria-hidden="false"] [data-flow-reader-content]')
  await expect(content).toHaveAttribute('data-flow-reader-spread', 'double')
  await expect(content.locator('[data-flow-reader-page-seam]')).toHaveCSS('display', 'block')

  const doubleState = await content.evaluate((element) => {
    const tab = (window as any).reader.focusedBookTab
    const seam = element.querySelector('[data-flow-reader-page-seam]')
    const contentRect = element.getBoundingClientRect()
    const seamRect = seam?.getBoundingClientRect()

    return {
      divisor: tab?.rendition?.manager?.layout?.divisor,
      writingMode: tab?.rendition?.manager?.writingMode,
      seamOffset: seamRect ? Math.round(seamRect.left + seamRect.width / 2 - contentRect.left) : 0,
      contentCenter: Math.round(contentRect.width / 2),
    }
  })
  expect(doubleState).toMatchObject({
    divisor: 2,
    writingMode: 'vertical-rl',
  })
  expect(Math.abs(doubleState.seamOffset - doubleState.contentCenter)).toBeLessThanOrEqual(1)

  await page.evaluate(() => {
    const tab = (window as any).reader.focusedBookTab
    tab.updateConfiguration({
      ...tab.book.configuration,
      typography: {
        ...tab.book.configuration?.typography,
        spread: 'none',
      },
    })
  })

  await expect(content).toHaveAttribute('data-flow-reader-spread', 'single')
  await expect(content.locator('[data-flow-reader-page-seam]')).toHaveCSS('display', 'none')
})

async function readActivePageFrameMetrics(page: Page) {
  return page.evaluate(() => {
    const tab = (window as any).reader.focusedBookTab
    const manager = tab?.rendition?.manager
    const pane = document.querySelector('[data-flow-reader-pane][aria-hidden="false"]')
    const content = pane?.querySelector('[data-flow-reader-content]')
    const frame = Array.from(pane?.querySelectorAll('iframe') ?? []).find((candidate) => {
      const rect = candidate.getBoundingClientRect()
      const style = getComputedStyle(candidate)
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden'
    }) as HTMLIFrameElement | undefined
    const body = frame?.contentDocument?.body
    const bodyStyle = body ? frame.contentWindow?.getComputedStyle(body) : undefined
    const contentRect = content?.getBoundingClientRect()
    const frameRect = frame?.getBoundingClientRect()
    const bodyRect = body?.getBoundingClientRect()
    const vertical = bodyStyle?.writingMode === 'vertical-rl'
    const physicalPageWidth = bodyStyle
      ? Number.parseFloat(vertical ? bodyStyle.getPropertyValue('column-height') : bodyStyle.columnWidth)
      : undefined
    const physicalGap = bodyStyle ? Number.parseFloat(vertical ? bodyStyle.rowGap : bodyStyle.columnGap) : undefined
    let middleGapTextRectCount: number | undefined
    if (body && bodyStyle && bodyRect && Number.isFinite(physicalPageWidth) && Number.isFinite(physicalGap)) {
      const gapStart = bodyRect.left + Number.parseFloat(bodyStyle.paddingLeft) + (physicalPageWidth ?? 0)
      const gapEnd = gapStart + (physicalGap ?? 0)
      const walker = body.ownerDocument.createTreeWalker(body, NodeFilter.SHOW_TEXT)
      let textNode = walker.nextNode()
      middleGapTextRectCount = 0
      while (textNode) {
        if (textNode.textContent?.trim()) {
          const range = body.ownerDocument.createRange()
          range.selectNodeContents(textNode)
          middleGapTextRectCount += Array.from(range.getClientRects()).filter(
            (rect) => rect.left < gapEnd && rect.right > gapStart,
          ).length
        }
        textNode = walker.nextNode()
      }
    }

    return {
      axis: manager?.settings?.axis,
      writingMode: manager?.writingMode,
      layout: {
        width: manager?.layout?.width,
        height: manager?.layout?.height,
        pageWidth: manager?.layout?.pageWidth,
        columnWidth: manager?.layout?.columnWidth,
        gap: manager?.layout?.gap,
        divisor: manager?.layout?.divisor,
      },
      contentRect: contentRect
        ? {
            width: Math.round(contentRect.width),
            height: Math.round(contentRect.height),
          }
        : undefined,
      frameRect: frameRect
        ? {
            width: Math.round(frameRect.width),
            height: Math.round(frameRect.height),
          }
        : undefined,
      body: bodyStyle
        ? {
            writingMode: bodyStyle.writingMode,
            paddingTop: bodyStyle.paddingTop,
            paddingRight: bodyStyle.paddingRight,
            paddingBottom: bodyStyle.paddingBottom,
            paddingLeft: bodyStyle.paddingLeft,
            direction: bodyStyle.direction,
            columnGap: bodyStyle.columnGap,
            columnWidth: bodyStyle.columnWidth,
            columnHeight: bodyStyle.getPropertyValue('column-height'),
            rowGap: bodyStyle.rowGap,
            physicalPageWidth,
            physicalGap,
            middleGapTextRectCount,
          }
        : undefined,
    }
  })
}

async function setSyntheticVerticalFooterSnapshot(
  page: Page,
  start: { page: number; total: number; slot: 'left' | 'right' },
  end: { page: number; total: number; slot: 'left' | 'right' },
  percentage: number,
) {
  await page.evaluate(
    ({ start, end, percentage }) => {
      const tab = (window as any).reader.focusedBookTab
      if (!tab) throw new Error('Missing focused book tab')
      const current = tab.paginationSnapshot
      tab.paginationSnapshot = {
        ...current,
        location: {
          start: {
            cfi: 'epubcfi(/6/2!/4/2:0)',
            href: 'chapter_001.xhtml',
            index: 0,
            displayed: start,
          },
          end: {
            cfi: 'epubcfi(/6/2!/4/2:8)',
            href: 'chapter_001.xhtml',
            index: 0,
            displayed: end,
          },
        },
        percentage,
        spreadDivisor: 2,
        writingMode: 'vertical-rl',
        pageProgressionDirection: 'rtl',
        spreadSlotOrder: 'right-first',
      }
      tab.paginationVersion += 1
    },
    { start, end, percentage },
  )
  await page.waitForTimeout(50)
}

async function readActiveFooterSlots(page: Page) {
  return page.evaluate(() => {
    const pane = document.querySelector('[data-flow-reader-pane][aria-hidden="false"]')
    if (!pane) throw new Error('Missing active reader pane')
    const paneRect = pane.getBoundingClientRect()
    const footer = Array.from(pane.querySelectorAll<HTMLElement>('div')).find((element) => {
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      return (
        style.display === 'grid' &&
        element.children.length === 2 &&
        rect.height > 0 &&
        Math.abs(rect.bottom - paneRect.bottom) <= 2
      )
    })
    if (!footer) throw new Error('Missing two-slot reader footer')

    return Array.from(footer.children).map((element) => (element.textContent ?? '').replace(/\s+/g, ' ').trim())
  })
}

test('[vertical-rl] keeps the horizontal physical page frame', async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 900 })
  await openFixtureBook(page, 0)
  await waitForStableReaderLayout(page, { header: false })
  const horizontal = await readActivePageFrameMetrics(page)

  await openFixtureBookByName(page, 'Tab Layout B')
  await waitForVerticalReaderLoaded(page)
  const vertical = await readActivePageFrameMetrics(page)

  expect(vertical.writingMode).toBe('vertical-rl')
  expect(vertical.axis).toBe('horizontal')
  expect(vertical.layout).toEqual(horizontal.layout)
  expect(vertical.contentRect).toEqual(horizontal.contentRect)
  expect(vertical.frameRect?.height).toBe(horizontal.frameRect?.height)
  expect(vertical.body?.paddingTop).toBe(horizontal.body?.paddingTop)
  expect(vertical.body?.paddingRight).toBe(horizontal.body?.paddingRight)
  expect(vertical.body?.paddingBottom).toBe(horizontal.body?.paddingBottom)
  expect(vertical.body?.paddingLeft).toBe(horizontal.body?.paddingLeft)
  expect(vertical.body?.direction).toBe('ltr')
  expect(vertical.body?.physicalPageWidth).toBe(horizontal.body?.physicalPageWidth)
  expect(vertical.body?.physicalGap).toBe(horizontal.body?.physicalGap)
  expect(vertical.body?.rowGap).toBe(horizontal.body?.columnGap)
  expect(vertical.body?.middleGapTextRectCount).toBe(0)
})

test('[vertical-rl] maps footer pages to physical right-first slots', async ({ page }) => {
  await openVerticalFixtureBook(page)

  await setSyntheticVerticalFooterSnapshot(
    page,
    { page: 1, total: 3, slot: 'right' },
    { page: 2, total: 3, slot: 'left' },
    2 / 3,
  )
  expect(await readActiveFooterSlots(page)).toEqual(['2 · 3 (66.67%)', '1 · 3'])

  await setSyntheticVerticalFooterSnapshot(
    page,
    { page: 3, total: 3, slot: 'right' },
    { page: 3, total: 3, slot: 'right' },
    1,
  )
  expect(await readActiveFooterSlots(page)).toEqual(['', '3 · 3 (100.00%)'])
})

async function readVerticalReadingState(page: Page) {
  return page.evaluate(() => {
    const tab = (window as any).reader.focusedBookTab
    const manager = tab?.rendition?.manager
    const location = tab?.paginationSnapshot?.location
    const spread = manager?.currentReflowableSpread

    return {
      startIndex: location?.start?.index,
      startPage: location?.start?.displayed?.page,
      startTotal: location?.start?.displayed?.total,
      startSlot: location?.start?.displayed?.slot,
      endIndex: location?.end?.index,
      endPage: location?.end?.displayed?.page,
      endTotal: location?.end?.displayed?.total,
      endSlot: location?.end?.displayed?.slot,
      rightIndex: spread?.right?.section?.index,
      rightPageIndex: spread?.right?.pageIndex,
      leftIndex: spread?.left?.section?.index,
      leftPageIndex: spread?.left?.pageIndex,
    }
  })
}

async function readVerticalPhysicalSectionSlots(page: Page) {
  return page.evaluate(() => {
    const tab = (window as any).reader.focusedBookTab
    const manager = tab?.rendition?.manager
    const content = document.querySelector('[data-flow-reader-pane][aria-hidden="false"] [data-flow-reader-content]')
    const contentRect = content?.getBoundingClientRect()
    if (!contentRect) throw new Error('Missing active reader content')

    const visible = (manager?.views?._views ?? [])
      .map((view: any) => {
        const rect = view.element?.getBoundingClientRect()
        if (!rect) return undefined

        const left = Math.max(rect.left, contentRect.left)
        const right = Math.min(rect.right, contentRect.right)
        if (right - left <= 1) return undefined

        return {
          sectionIndex: view.section?.index,
          href: view.section?.href,
          marker: (view.contents?.document?.querySelector('h1')?.textContent ?? '').trim(),
          visibleLeft: left,
          visibleRight: right,
          visibleCenter: (left + right) / 2,
        }
      })
      .filter(Boolean)
      .sort((left: any, right: any) => right.visibleCenter - left.visibleCenter)

    return {
      right: visible[0],
      left: visible.length > 1 ? visible[visible.length - 1] : visible[0],
      visible,
    }
  })
}

test('[vertical-rl] keeps page shortcuts logical and returns to the same right-first spread', async ({ page }) => {
  await openVerticalFixtureBook(page)
  const initial = await readVerticalReadingState(page)

  await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(300)
  const forward = await readVerticalReadingState(page)

  await page.keyboard.press('ArrowLeft')
  await page.waitForTimeout(300)
  const returned = await readVerticalReadingState(page)

  expect(initial.startPage).toBe(1)
  expect(initial.startSlot).toBe('right')
  expect(initial.rightPageIndex).toBe(0)
  expect(initial.leftPageIndex).toBe(1)
  expect(forward.startPage).toBeGreaterThan(initial.startPage ?? 0)
  expect(forward.startSlot).toBe('right')
  expect(returned).toEqual(initial)
})

test('[vertical-rl] places a TOC chapter start in the physical right slot', async ({ page }) => {
  await openVerticalFixtureBook(page)
  const target = page.getByRole('button', {
    name: 'VERTICAL-CHAPTER-02',
    exact: true,
  })
  if (!(await target.isVisible())) {
    await page.locator(`.ActivityBar button[aria-label="${msg('toc.title')}"]`).click()
  }
  await expect(target).toBeVisible()
  await target.click()
  await page.waitForTimeout(400)

  const state = await readVerticalReadingState(page)
  expect(state.startIndex).toBe(1)
  expect(state.startPage).toBe(1)
  expect(state.startSlot).toBe('right')
  expect(state.rightIndex).toBe(1)
  expect(state.rightPageIndex).toBe(0)
})

test('[vertical-rl] keeps one-page chapter jumps physically right and skips a next chapter already visible on the left', async ({
  page,
}) => {
  await openVerticalFixtureBook(page)
  const chapter4 = page.getByRole('button', {
    name: 'VERTICAL-CHAPTER-04-TWO-PAGES',
    exact: true,
  })
  const chapter3 = page.getByRole('button', {
    name: 'VERTICAL-CHAPTER-03-SHORT',
    exact: true,
  })
  await expect(chapter4).toBeVisible()

  await chapter4.click()
  await expect
    .poll(() => readVerticalReadingState(page))
    .toMatchObject({
      startIndex: 3,
      startPage: 1,
      startTotal: 2,
      startSlot: 'right',
      endIndex: 3,
      endPage: 2,
      rightIndex: 3,
      leftIndex: 3,
    })

  await chapter3.click()
  await expect
    .poll(() => readVerticalReadingState(page))
    .toMatchObject({
      startIndex: 2,
      startPage: 1,
      startTotal: 1,
      startSlot: 'right',
      endIndex: 3,
      endPage: 1,
      endSlot: 'left',
      rightIndex: 2,
      leftIndex: 3,
    })
  await expect
    .poll(() => readVerticalPhysicalSectionSlots(page))
    .toMatchObject({
      right: {
        sectionIndex: 2,
        marker: expect.stringContaining('VERTICAL-CHAPTER-03'),
      },
      left: {
        sectionIndex: 3,
        marker: expect.stringContaining('VERTICAL-CHAPTER-04'),
      },
    })

  await page.keyboard.press(']')
  await expect
    .poll(() => readVerticalReadingState(page))
    .toMatchObject({
      startIndex: 4,
      startPage: 1,
      startSlot: 'right',
      rightIndex: 4,
      rightPageIndex: 0,
    })
  await expect
    .poll(() => readVerticalPhysicalSectionSlots(page))
    .toMatchObject({
      right: {
        sectionIndex: 4,
        marker: expect.stringContaining('VERTICAL-CHAPTER-05'),
      },
    })

  await page.keyboard.press('[')
  await expect
    .poll(() => readVerticalReadingState(page))
    .toMatchObject({
      startIndex: 3,
      startPage: 1,
      startSlot: 'right',
      rightIndex: 3,
      rightPageIndex: 0,
    })
})

test('[vertical-rl] resolves nested TOC anchors and chapter shortcuts on the right page', async ({ page }) => {
  await openVerticalFixtureBook(page)
  const parent = page.getByRole('button', {
    name: 'VERTICAL-CHAPTER-01',
    exact: true,
  })
  await expect(parent).toBeVisible()
  await parent.locator('svg').click()
  const target = page.getByRole('button', {
    name: 'VERTICAL-CHAPTER-01-PART-2',
    exact: true,
  })
  await expect(target).toBeVisible()
  await target.click()

  await expect
    .poll(async () => {
      const state = await readVerticalReadingState(page)
      return {
        aligned: state.startPage === (state.rightPageIndex ?? Number.NaN) + 1,
        nested: (state.rightPageIndex ?? 0) > 0,
        rightIndex: state.rightIndex,
        startIndex: state.startIndex,
        startSlot: state.startSlot,
      }
    })
    .toMatchObject({
      aligned: true,
      nested: true,
      rightIndex: 0,
      startIndex: 0,
      startSlot: 'right',
    })
  const nested = await readVerticalReadingState(page)

  await page.keyboard.press(']')
  await expect
    .poll(() => readVerticalReadingState(page))
    .toMatchObject({
      startIndex: 1,
      startPage: 1,
      startSlot: 'right',
      rightIndex: 1,
      rightPageIndex: 0,
    })

  await page.keyboard.press('[')
  await expect
    .poll(() => readVerticalReadingState(page))
    .toMatchObject({
      startIndex: 0,
      startSlot: 'right',
      rightIndex: 0,
      rightPageIndex: nested.rightPageIndex,
    })

  await page.keyboard.press('[')
  await expect
    .poll(() => readVerticalReadingState(page))
    .toMatchObject({
      startIndex: 0,
      startPage: 1,
      startSlot: 'right',
      rightIndex: 0,
      rightPageIndex: 0,
    })
})

test('[vertical-rl] advances chapter find within the visible page before turning', async ({ page }) => {
  await openVerticalFixtureBook(page)
  const initial = await readVerticalReadingState(page)

  await page.keyboard.press(findShortcut)
  const input = page.getByRole('textbox', { name: msg('reader.find_current_chapter') })
  await expect(input).toBeVisible()
  await input.fill('VERTICAL-CHAPTER-01-01')
  await expect(page.getByText('1/3', { exact: true })).toBeVisible()

  await input.press('Enter')
  await expect(page.getByText('2/3', { exact: true })).toBeVisible()
  expect(await readVerticalReadingState(page)).toEqual(initial)

  const activeHighlight = await page.evaluate(() => {
    const content = document.querySelector('[data-flow-reader-pane][aria-hidden="false"] [data-flow-reader-content]')
    const contentRect = content?.getBoundingClientRect()
    if (!contentRect) return false

    return Array.from(document.querySelectorAll('[ref="epubjs-hl"]')).some((mark) => {
      const rect = mark.getBoundingClientRect()
      const fill = mark.getAttribute('fill') ?? getComputedStyle(mark).fill
      return (
        fill.includes('59') &&
        fill.includes('130') &&
        rect.right > contentRect.left &&
        rect.left < contentRect.right &&
        rect.bottom > contentRect.top &&
        rect.top < contentRect.bottom
      )
    })
  })
  expect(activeHighlight).toBe(true)
})

test('[vertical-rl] wraps chapter find navigation in both directions', async ({ page }) => {
  await openVerticalFixtureBook(page)

  await page.keyboard.press(findShortcut)
  const input = page.getByRole('textbox', { name: msg('reader.find_current_chapter') })
  await input.fill('VERTICAL-CHAPTER-01-01')
  await expect(page.getByText('1/3', { exact: true })).toBeVisible()

  await input.press('Shift+Enter')
  await expect(page.getByText('3/3', { exact: true })).toBeVisible()

  await input.press('Enter')
  await expect(page.getByText('1/3', { exact: true })).toBeVisible()
})

test('[vertical-rl] turns to the next spread for an off-page chapter find result', async ({ page }) => {
  await openVerticalFixtureBook(page)
  const query = '天地玄黄宇宙洪荒'
  const search = await page.evaluate(async (value) => {
    const tab = (window as any).reader.focusedBookTab
    const manager = tab.rendition.manager
    const section = manager.currentReflowableSpread.right.section
    const matches = section.find(value)
    const pageIndexes = await Promise.all(
      matches.map((match: { cfi: string }) => tab.pageIndexForCfi(section.index, match.cfi)),
    )
    const visiblePages = [manager.currentReflowableSpread.right, manager.currentReflowableSpread.left]
      .filter((address: { section: { index: number } }) => address?.section?.index === section.index)
      .map((address: { pageIndex: number }) => address.pageIndex)
    const initialIndex = pageIndexes.findIndex((pageIndex) => visiblePages.includes(pageIndex))
    const firstOffPageIndex = pageIndexes.findIndex(
      (pageIndex, index) => index > initialIndex && !visiblePages.includes(pageIndex),
    )

    return { firstOffPageIndex, initialIndex, pageIndexes, visiblePages }
  }, query)
  expect(search.initialIndex).toBeGreaterThanOrEqual(0)
  expect(search.firstOffPageIndex).toBeGreaterThan(search.initialIndex)

  await page.keyboard.press(findShortcut)
  const input = page.getByRole('textbox', { name: msg('reader.find_current_chapter') })
  await input.fill(query)
  await expect(
    page.getByText(`${search.initialIndex + 1}/${search.pageIndexes.length}`, {
      exact: true,
    }),
  ).toBeVisible()

  for (let index = search.initialIndex + 1; index < search.firstOffPageIndex; index += 1) {
    await input.press('Enter')
  }
  const beforeTurn = await readVerticalReadingState(page)
  await input.press('Enter')
  await expect(
    page.getByText(`${search.firstOffPageIndex + 1}/${search.pageIndexes.length}`, { exact: true }),
  ).toBeVisible()
  await expect.poll(() => readVerticalReadingState(page)).not.toEqual(beforeTurn)
  await expectVisibleReaderMarks(page, 'epubjs-hl', 1)
})

test('[vertical-rl] keeps a clicked sidebar search result active and visible', async ({ page }) => {
  await openVerticalFixtureBook(page)
  await page.locator('.ActivityBar button[aria-label="Search"]').click()
  const input = page.getByRole('textbox', { name: msg('search.title'), exact: true })
  await input.fill('VERTICAL-CHAPTER-01-29')

  const result = listRow(page, 'VERTICAL-CHAPTER-01-29')
  await expect(result).toBeVisible()
  await result.click()
  await expect(result).toHaveAttribute('aria-current', 'true')

  const state = await readVerticalReadingState(page)
  expect(state.startIndex).toBe(0)
  expect(state.startSlot).toBe('right')
  expect(state.rightPageIndex).toBeGreaterThan(0)
  await expectVisibleReaderMarks(page, 'epubjs-hl', 1)
})

test('[vertical-rl] locates and expands the current search-result chapter', async ({ page }) => {
  await openVerticalFixtureBook(page)
  await page.locator('.ActivityBar button[aria-label="Search"]').click()

  const setSearchResults = async (targetResultCount: number) => {
    await page.evaluate((resultCount) => {
      const tab = (window as any).reader.focusedBookTab
      const currentSectionIndex = tab.currentSection?.index ?? 0
      const groups = Array.from({ length: 9 }, (_, groupIndex) => ({
        id: `locate-group-${groupIndex}`,
        excerpt: groupIndex === 8 ? 'Current locate chapter' : `Earlier chapter ${groupIndex}`,
        sectionIndex: groupIndex === 8 ? currentSectionIndex : currentSectionIndex + groupIndex + 1,
        expanded: groupIndex !== 8,
        subitems: Array.from({ length: groupIndex === 8 ? resultCount : 2 }, (_, resultIndex) => ({
          id: `locate-result-${groupIndex}-${resultIndex}`,
          excerpt: `Locate result ${groupIndex}-${resultIndex}`,
          occurrence: resultIndex,
        })),
      }))

      tab.keyword = 'Locate result'
      tab.results = groups
    }, targetResultCount)
  }

  const sidebar = page.locator('.SideBar')
  const searchScroll = sidebar.locator('[data-pane-scroll]').last()
  const locate = sidebar.getByRole('button', { name: msg('action.locate_current') })

  await setSearchResults(3)
  await searchScroll.evaluate((element) => {
    element.scrollTop = element.scrollHeight
  })
  await locate.click()

  const lastSmallResult = listRow(searchScroll, 'Locate result 8-2')
  await expect(lastSmallResult).toBeVisible()
  const [viewport, groupRect, resultRect, scrollTop] = await Promise.all([
    searchScroll.boundingBox(),
    listRow(searchScroll, 'Current locate chapter').boundingBox(),
    lastSmallResult.boundingBox(),
    searchScroll.evaluate((element) => element.scrollTop),
  ])
  const smallGroupVisibility =
    viewport && groupRect && resultRect
      ? {
          groupTop: groupRect.y,
          resultBottom: resultRect.y + resultRect.height,
          scrollTop,
          viewportBottom: viewport.y + viewport.height,
          viewportTop: viewport.y,
        }
      : null
  expect(smallGroupVisibility).toMatchObject({
    groupTop: expect.any(Number),
  })
  expect(smallGroupVisibility!.groupTop).toBeGreaterThanOrEqual(smallGroupVisibility!.viewportTop - 1)
  expect(smallGroupVisibility!.resultBottom).toBeLessThanOrEqual(smallGroupVisibility!.viewportBottom + 1)

  await setSearchResults(30)
  await searchScroll.evaluate((element) => {
    element.scrollTop = element.scrollHeight
  })
  await locate.click()

  await expect(listRow(searchScroll, 'Locate result 8-0')).toBeVisible()
  const [largeViewport, largeGroup] = await Promise.all([
    searchScroll.boundingBox(),
    listRow(searchScroll, 'Current locate chapter').boundingBox(),
  ])
  const largeGroupTopOffset = largeViewport && largeGroup ? largeGroup.y - largeViewport.y : Number.POSITIVE_INFINITY
  expect(Math.abs(largeGroupTopOffset)).toBeLessThan(1)
})

test('[vertical-rl] keeps one physical page frame in single-page and zoomed layouts', async ({ page }) => {
  await openVerticalFixtureBook(page)
  await page
    .getByRole('button', {
      name: 'VERTICAL-CHAPTER-04-TWO-PAGES',
      exact: true,
    })
    .click()
  await page
    .getByRole('button', {
      name: 'VERTICAL-CHAPTER-03-SHORT',
      exact: true,
    })
    .click()
  await expect
    .poll(() => readVerticalReadingState(page))
    .toMatchObject({
      rightIndex: 2,
      leftIndex: 3,
    })

  const setTypography = async (spread: 'none' | 'auto', zoom?: number) => {
    await page.evaluate(
      ({ nextSpread, nextZoom }) => {
        const tab = (window as any).reader.focusedBookTab
        tab.updateConfiguration({
          ...tab.book.configuration,
          typography: {
            ...tab.book.configuration?.typography,
            spread: nextSpread,
            zoom: nextZoom,
          },
        })
      },
      { nextSpread: spread, nextZoom: zoom },
    )
  }
  const readGeometry = () =>
    page.evaluate(() => {
      const tab = (window as any).reader.focusedBookTab
      const manager = tab?.rendition?.manager
      const spread = manager?.currentReflowableSpread
      const views = manager?.views?._views ?? []
      const view =
        views.find((candidate: any) => candidate.section?.index === spread?.right?.section?.index) ?? views[0]
      const body = view?.contents?.document?.body ?? view?.document?.body
      const style = body && getComputedStyle(body)
      const bodyRect = body?.getBoundingClientRect()
      const frameWidth = view?.iframe?.contentWindow?.innerWidth
      let textCrossesBodyLeft = 0
      if (body && bodyRect) {
        const walker = body.ownerDocument.createTreeWalker(body, NodeFilter.SHOW_TEXT)
        let textNode = walker.nextNode()
        while (textNode) {
          if (textNode.textContent?.trim()) {
            const range = body.ownerDocument.createRange()
            range.selectNodeContents(textNode)
            textCrossesBodyLeft += Array.from<DOMRect>(range.getClientRects()).filter(
              (rect) => rect.left < bodyRect.left - 1 && rect.right > bodyRect.left + 1,
            ).length
          }
          textNode = walker.nextNode()
        }
      }

      return {
        divisor: manager?.layout?.divisor,
        pageWidth: manager?.layout?.pageWidth,
        pageHeight: manager?.layout?.height,
        displayedViewCount: views.length,
        viewSectionIndexes: views.map((candidate: any) => candidate.section?.index),
        rightPageIndex: spread?.right?.pageIndex,
        hasLeftPage: !!spread?.left,
        bodyInsideFrame:
          !!bodyRect && typeof frameWidth === 'number' && bodyRect.left >= -1 && bodyRect.right <= frameWidth + 1,
        textCrossesBodyLeft,
        body: style && {
          columnWidth: parseFloat(style.columnWidth),
          columnHeight: parseFloat(style.columnHeight),
          columnGap: parseFloat(style.columnGap),
          rowGap: parseFloat(style.rowGap),
          transform: style.transform,
          transformOrigin: style.transformOrigin,
        },
      }
    })

  await setTypography('none')
  await expect.poll(readGeometry).toMatchObject({
    divisor: 1,
    displayedViewCount: 1,
    viewSectionIndexes: [2],
    hasLeftPage: false,
    bodyInsideFrame: true,
    textCrossesBodyLeft: 0,
  })

  await setTypography('auto')
  await expect.poll(readGeometry).toMatchObject({
    divisor: 2,
    displayedViewCount: 2,
    hasLeftPage: true,
  })
  await page.keyboard.press(']')
  await expect.poll(() => readVerticalReadingState(page)).toMatchObject({ rightIndex: 4 })
  await page.keyboard.press('[')
  await expect
    .poll(() => readVerticalReadingState(page))
    .toMatchObject({
      rightIndex: 3,
      rightPageIndex: 0,
    })
  await setTypography('none', 1.5)
  await expect.poll(readGeometry).toMatchObject({
    divisor: 1,
    displayedViewCount: 1,
    viewSectionIndexes: [3],
    hasLeftPage: false,
    bodyInsideFrame: true,
    textCrossesBodyLeft: 0,
  })
  let zoomed: Awaited<ReturnType<typeof readGeometry>> | undefined
  await expect
    .poll(async () => {
      const geometry = await readGeometry()
      const body = geometry.body
      const ready =
        Number.isFinite(body?.columnWidth) && Number.isFinite(body?.columnHeight) && body?.transform !== 'none'
      if (ready) zoomed = geometry
      return ready
    })
    .toBe(true)
  if (!zoomed) throw new Error('Missing stable zoomed geometry')
  expect(zoomed.body?.columnWidth).toBeCloseTo(((zoomed.pageHeight ?? 0) - 20) / 1.5, 1)
  expect(zoomed.body?.columnHeight).toBeCloseTo(((zoomed.pageWidth ?? 0) - 48) / 1.5, 1)
  expect(zoomed.body?.columnGap).toBe(0)
  expect(zoomed.body?.rowGap).toBeCloseTo(48 / 1.5, 1)
  expect(zoomed.body?.transform).not.toBe('none')
})

test('[vertical-rl] restores the committed right-first spread across tab and sidebar changes', async ({ page }) => {
  await openVerticalFixtureBook(page)
  const initial = await readVerticalReadingState(page)
  await installBookTabRuntimeCounters(page)
  await resetBookTabRuntimeCounters(page)

  await readerTab(page, 'Tab Layout A').click()
  await waitForStableReaderLayout(page, { header: false })
  await readerTab(page, 'Tab Layout B').click()
  await waitForVerticalReaderLoaded(page)
  const afterTabSwitch = await readVerticalReadingState(page)
  const counters = (await readBookTabRuntimeCounters(page)).find((entry) => entry.id === 'tab-layout-b')

  await toggleTocSidebar(page)
  await page.waitForTimeout(250)
  await toggleTocSidebar(page)
  await page.waitForTimeout(250)
  const afterSidebar = await readVerticalReadingState(page)

  expect(initial.startSlot).toBe('right')
  expect(afterTabSwitch).toEqual(initial)
  expect(afterSidebar).toEqual(initial)
  expect(counters).toMatchObject({
    display: 0,
    next: 0,
    prev: 0,
    relayoutCurrentView: 0,
    resizeRendition: 0,
  })
})

test('[vertical-rl] overrides punctuation while preserving vertical indent and line height', async ({ page }) => {
  await openVerticalFixtureBook(page)

  const typography = await page.evaluate(() => {
    const pane = document.querySelector('[data-flow-reader-pane][aria-hidden="false"]')
    const frame = Array.from(pane?.querySelectorAll('iframe') ?? []).find(
      (candidate) => candidate.getBoundingClientRect().width > 0,
    ) as HTMLIFrameElement | undefined
    const doc = frame?.contentDocument
    const punctuation = doc?.querySelector('#vertical-punctuation')
    const paragraph = doc?.querySelector('p')
    if (!frame?.contentWindow || !punctuation || !paragraph) {
      throw new Error('Missing vertical typography fixture')
    }
    const punctuationStyle = frame.contentWindow.getComputedStyle(punctuation)
    const paragraphStyle = frame.contentWindow.getComputedStyle(paragraph)

    return {
      punctuationOrientation: punctuationStyle.textOrientation,
      writingMode: paragraphStyle.writingMode,
      textIndent: paragraphStyle.textIndent,
      lineHeight: paragraphStyle.lineHeight,
    }
  })

  expect(typography.writingMode).toBe('vertical-rl')
  expect(typography.punctuationOrientation).toBe('mixed')
  expect(parseFloat(typography.textIndent)).toBeGreaterThan(0)
  expect(parseFloat(typography.lineHeight)).toBeGreaterThan(0)
})

test('[vertical-rl] places note popover on the physical left with vertical content', async ({ page }) => {
  await openVerticalFixtureBook(page)
  const activeFrame = page
    .locator('[data-flow-reader-pane][aria-hidden="false"] iframe')
    .filter({ visible: true })
    .first()
  const noteRef = activeFrame.contentFrame().locator('#note-ref')
  await noteRef.click()
  const popover = page.locator('.flow-note-popover')
  await expect(popover).toBeVisible()

  const geometry = await page.evaluate(() => {
    const pane = document.querySelector('[data-flow-reader-pane][aria-hidden="false"]')
    const frame = Array.from(pane?.querySelectorAll('iframe') ?? []).find(
      (candidate) => candidate.getBoundingClientRect().width > 0,
    ) as HTMLIFrameElement | undefined
    const anchor = frame?.contentDocument?.querySelector('#note-ref')
    const popover = pane?.querySelector('.flow-note-popover')
    const content = popover?.firstElementChild
    if (!frame || !anchor || !popover || !content) {
      throw new Error('Missing note popover geometry')
    }
    const frameRect = frame.getBoundingClientRect()
    const anchorRect = anchor.getBoundingClientRect()
    const popoverRect = popover.getBoundingClientRect()

    return {
      anchorLeft: frameRect.left + anchorRect.left,
      contentClientHeight: content.clientHeight,
      contentClientWidth: content.clientWidth,
      contentOverflowX: getComputedStyle(content).overflowX,
      contentOverflowY: getComputedStyle(content).overflowY,
      contentScrollHeight: content.scrollHeight,
      contentScrollWidth: content.scrollWidth,
      popoverLeft: popoverRect.left,
      popoverRight: popoverRect.right,
      writingMode: getComputedStyle(content).writingMode,
    }
  })

  expect(geometry.popoverRight).toBeLessThan(geometry.anchorLeft)
  expect(geometry.writingMode).toBe('vertical-rl')
  expect(geometry.contentOverflowX).toBe('visible')
  expect(geometry.contentOverflowY).toBe('clip')
  expect(
    Math.max(
      geometry.contentScrollHeight - geometry.contentClientHeight,
      geometry.contentScrollWidth - geometry.contentClientWidth,
    ),
  ).toBeLessThanOrEqual(1)

  await page.evaluate(() => {
    const content = document.querySelector('.flow-note-popover > div') as HTMLElement | null
    if (!content) throw new Error('Missing note popover content')

    const paragraph = document.createElement('p')
    paragraph.textContent = '用于验证长注释滚动能力。'.repeat(500)
    content.appendChild(paragraph)
  })

  await expect
    .poll(() =>
      page.evaluate(() => {
        const content = document.querySelector('.flow-note-popover > div') as HTMLElement | null
        if (!content) throw new Error('Missing note popover content')

        return {
          clientHeight: content.clientHeight,
          overflowX: getComputedStyle(content).overflowX,
          overflowY: getComputedStyle(content).overflowY,
          scrollHeight: content.scrollHeight,
        }
      }),
    )
    .toMatchObject({ overflowX: 'auto', overflowY: 'hidden' })

  const longNoteGeometry = await page.evaluate(() => {
    const content = document.querySelector('.flow-note-popover > div') as HTMLElement | null
    if (!content) throw new Error('Missing note popover content')

    return {
      clientHeight: content.clientHeight,
      clientWidth: content.clientWidth,
      scrollHeight: content.scrollHeight,
      scrollWidth: content.scrollWidth,
    }
  })
  expect(
    Math.max(
      longNoteGeometry.scrollHeight - longNoteGeometry.clientHeight,
      longNoteGeometry.scrollWidth - longNoteGeometry.clientWidth,
    ),
  ).toBeGreaterThan(1)
})

test('does not scroll a horizontal note for glyph overflow inside the available height', async ({ page }) => {
  await openFixtureBook(page, 0)
  await waitForStableReaderLayout(page, { header: false })

  await page.evaluate(() => {
    const pane = document.querySelector('[data-flow-reader-pane][aria-hidden="false"]')
    const frame = Array.from(pane?.querySelectorAll('iframe') ?? []).find(
      (candidate) => candidate.getBoundingClientRect().width > 0,
    ) as HTMLIFrameElement | undefined
    const doc = frame?.contentDocument
    if (!doc?.body) throw new Error('Missing horizontal note fixture')

    const paragraph = doc.createElement('p')
    paragraph.innerHTML = '<a id="horizontal-note-ref" role="doc-noteref" href="#horizontal-note">〔1〕</a>'
    const note = doc.createElement('aside')
    note.id = 'horizontal-note'
    note.setAttribute('role', 'doc-footnote')
    note.style.fontSize = '28px'
    note.style.lineHeight = '10px'
    note.innerHTML = 'Short horizontal note.<a href="#horizontal-note-ref">↩</a>'
    doc.body.prepend(paragraph, note)
  })

  const activeFrame = page
    .locator('[data-flow-reader-pane][aria-hidden="false"] iframe')
    .filter({ visible: true })
    .first()
  await activeFrame.contentFrame().locator('#horizontal-note-ref').click()
  const popover = page.locator('.flow-note-popover')
  await expect(popover).toBeVisible()

  const overflow = await popover
    .locator(':scope > div')
    .first()
    .evaluate((content) => {
      const style = getComputedStyle(content)
      return {
        clientHeight: content.clientHeight,
        clientWidth: content.clientWidth,
        overflowX: style.overflowX,
        overflowY: style.overflowY,
        scrollHeight: content.scrollHeight,
        scrollWidth: content.scrollWidth,
        maxHeight: Number.parseFloat(style.maxHeight),
      }
    })

  expect(overflow.scrollHeight).toBeGreaterThan(overflow.clientHeight + 1)
  expect(overflow.scrollHeight).toBeLessThan(overflow.maxHeight)
  expect(overflow.overflowX).toBe('clip')
  expect(overflow.overflowY).toBe('visible')

  await page.keyboard.press('Escape')
  await expect(popover).toBeHidden()
  await activeFrame
    .contentFrame()
    .locator('#horizontal-note')
    .evaluate((note) => {
      note.removeAttribute('style')
      note.innerHTML = `${'Long horizontal note content. '.repeat(800)}<a href="#horizontal-note-ref">↩</a>`
    })
  await activeFrame.contentFrame().locator('#horizontal-note-ref').click()
  await expect(popover).toBeVisible()

  const longOverflow = await popover
    .locator(':scope > div')
    .first()
    .evaluate((content) => {
      const style = getComputedStyle(content)
      return {
        overflowY: style.overflowY,
        scrollHeight: content.scrollHeight,
        maxHeight: Number.parseFloat(style.maxHeight),
      }
    })
  expect(longOverflow.scrollHeight).toBeGreaterThan(longOverflow.maxHeight)
  expect(longOverflow.overflowY).toBe('auto')
})

test('[vertical-rl] keeps the selection menu beside the selection', async ({ page }) => {
  await openVerticalFixtureBook(page)
  await selectReaderTextAndOpenMenu(page, {
    endOffset: 7,
    startOffset: 1,
    targetSelector: '#vertical-selection-target',
  })

  await expect(page.getByRole('button', { name: msg('menu.copy') })).toBeVisible()
  const result = await page.evaluate((copyLabel) => {
    const pane = document.querySelector('[data-flow-reader-pane][aria-hidden="false"]')
    const frame = Array.from(pane?.querySelectorAll('iframe') ?? []).find(
      (candidate) => candidate.getBoundingClientRect().width > 0,
    ) as HTMLIFrameElement | undefined
    const selection = frame?.contentWindow?.getSelection()
    const selectionRect = selection?.rangeCount ? selection.getRangeAt(0).getBoundingClientRect() : undefined
    const frameRect = frame?.getBoundingClientRect()
    const copyButton = Array.from(pane?.querySelectorAll('button') ?? []).find(
      (button) => button.getAttribute('aria-label') === copyLabel,
    )
    const menu = copyButton?.closest('[data-flow-keyboard-capture="true"]')
    const menuRect = menu?.getBoundingClientRect()
    const contentRect = pane?.querySelector('[data-flow-reader-content]')?.getBoundingClientRect()
    if (!selectionRect || !frameRect || !menuRect || !contentRect) {
      throw new Error('Missing selection menu geometry')
    }
    const outerSelection = {
      left: frameRect.left + selectionRect.left,
      right: frameRect.left + selectionRect.right,
      top: frameRect.top + selectionRect.top,
      bottom: frameRect.top + selectionRect.bottom,
    }
    const overlaps = !(
      menuRect.right <= outerSelection.left ||
      menuRect.left >= outerSelection.right ||
      menuRect.bottom <= outerSelection.top ||
      menuRect.top >= outerSelection.bottom
    )

    return {
      overlaps,
      inside:
        menuRect.left >= contentRect.left &&
        menuRect.right <= contentRect.right &&
        menuRect.top >= contentRect.top &&
        menuRect.bottom <= contentRect.bottom,
      beside: menuRect.right <= outerSelection.left || menuRect.left >= outerSelection.right,
    }
  }, msg('menu.copy'))

  expect(result.inside).toBe(true)
  expect(result.overlaps).toBe(false)
  expect(result.beside).toBe(true)
})

test('[vertical-rl] keeps the dictionary popup inside the reader without repagination', async ({ page }) => {
  await openVerticalFixtureBook(page)
  const before = await readFocusedTabState(page)
  await selectReaderTextAndOpenMenu(page, {
    endOffset: 7,
    startOffset: 1,
    targetSelector: '#vertical-selection-target',
  })

  await page.getByRole('button', { name: msg('menu.dictionary'), exact: true }).click()
  const popup = page.getByRole('dialog')
  await expect(popup).toBeVisible()
  await expect(popup.getByText('用于浮层布局测试的合成释义。', { exact: true })).toBeVisible()

  const geometry = await popup.evaluate((element) => {
    const popupRect = element.getBoundingClientRect()
    const contentRect = element
      .closest('[data-flow-reader-pane]')
      ?.querySelector('[data-flow-reader-content]')
      ?.getBoundingClientRect()
    if (!contentRect) throw new Error('Missing reader content geometry')

    return {
      height: popupRect.height,
      inside:
        popupRect.left >= contentRect.left &&
        popupRect.right <= contentRect.right &&
        popupRect.top >= contentRect.top &&
        popupRect.bottom <= contentRect.bottom,
      width: popupRect.width,
    }
  })
  const after = await readFocusedTabState(page)

  expect(geometry.inside).toBe(true)
  expect(geometry.width).toBe(600)
  expect(geometry.height).toBeGreaterThan(100)
  expect(after.startCfi).toBe(before.startCfi)
  expect(after.endCfi).toBe(before.endCfi)
  expect(after.visibleSectionIndexes).toEqual(before.visibleSectionIndexes)
  expect(after.renditionStartCfi).toBe(before.renditionStartCfi)
  expect(after.renditionEndCfi).toBe(before.renditionEndCfi)
})

test('[vertical-rl] closes the selection menu before opening chapter find', async ({ page }) => {
  await openVerticalFixtureBook(page)
  await selectReaderTextAndOpenMenu(page, {
    endOffset: 7,
    startOffset: 1,
    targetSelector: '#vertical-selection-target',
  })

  await expect(page.getByRole('button', { name: msg('menu.copy') })).toBeVisible()
  await page.keyboard.press(findShortcut)

  await expect(page.getByRole('button', { name: msg('menu.copy') })).toBeHidden()
  await expect(page.getByRole('textbox', { name: msg('reader.find_current_chapter') })).toBeFocused()
})

test('guards reader nav path expansion against cyclic parent links', async ({ page }) => {
  await openFixtureBook(page, 0)
  await waitForStableReaderLayout(page, { header: false })

  const paths = await page.evaluate(() => {
    const tab = (window as any).reader.focusedBookTab
    if (!tab) throw new Error('Missing focused book tab')

    const other = { id: 'other', label: 'Other', subitems: [] }
    const root: any = { id: 'root', label: 'Root', subitems: [] }
    const child: any = {
      id: 'child',
      label: 'Child',
      parent: 'root',
      subitems: [],
    }
    const leaf = { id: 'leaf', label: 'Leaf', parent: 'child', subitems: [] }
    const cyclic = {
      id: 'cyclic',
      label: 'Cyclic',
      parent: 'cyclic',
      subitems: [],
    }
    const fresh = {
      id: 'fresh',
      label: 'Fresh',
      parent: 'fresh',
      subitems: [],
    }
    const group: any = {
      id: 'same.xhtml',
      href: 'same.xhtml',
      label: 'Group',
      subitems: [],
    }
    const duplicate = {
      id: 'same.xhtml',
      href: 'same.xhtml',
      label: 'First duplicate',
      parent: 'same.xhtml',
      subitems: [],
    }
    root.subitems = [child]
    child.subitems = [leaf]
    group.subitems = [duplicate]
    const items: Record<string, unknown> = {
      child,
      cyclic,
      fresh,
      leaf,
      root,
      same: duplicate,
    }
    const previousNav = tab.nav
    const previousSections = tab.sections
    const previousSectionNavIndex = tab.sectionNavIndex

    tab.nav = {
      toc: [other, root, cyclic, fresh, group],
      tocById: {
        child: 0,
        cyclic: 0,
        fresh: 0,
        leaf: 0,
        root: 0,
        'same.xhtml': 0,
      },
      getByIndex(id: string) {
        function findByIndex(index: number, navItems: any[]): unknown {
          if (!navItems?.length) return

          const item = navItems[index]
          if (item && (id === item.id || id === item.href)) return item

          for (const candidate of navItems) {
            const result = findByIndex(index, candidate.subitems)
            if (result) return result
          }
        }

        if (id === 'fresh') {
          return { id: 'fresh', label: 'Fresh duplicate', parent: 'fresh' }
        }
        if (id === 'same.xhtml') {
          return findByIndex(0, this.toc)
        }

        return items[id]
      },
    }
    tab.sections = [{ href: 'same.xhtml', index: 0, length: 1 }]
    tab.sectionNavIndex = undefined

    try {
      tab.expandNavPath(cyclic)
      tab.expandNavPath(leaf)
      tab.expandNavPath(duplicate)
      const anchors = [
        {
          cfi: 'a',
          hash: undefined,
          href: 'same.xhtml',
          item: group,
          order: 0,
          sectionIndex: 0,
        },
        {
          cfi: 'a',
          hash: undefined,
          href: 'same.xhtml',
          item: duplicate,
          order: 1,
          sectionIndex: 0,
        },
      ]
      const previousCompareCfi = tab.compareCfi
      tab.compareCfi = (a: string, b: string) => a.localeCompare(b)
      const pickedDuplicateAnchor = tab.pickNavAnchorForCfi(anchors, 'z')
      tab.compareCfi = previousCompareCfi

      return {
        cyclic: tab.getNavPath(cyclic).map((item: { label: string }) => item.label),
        fresh: tab.getNavPath(fresh).map((item: { label: string }) => item.label),
        regular: tab.getNavPath(leaf).map((item: { label: string }) => item.label),
        duplicate: tab.getNavPath(duplicate).map((item: { label: string }) => item.label),
        mappedDuplicate: tab.mapSectionToNavItem('same.xhtml')?.label ?? undefined,
        pickedDuplicateAnchor: pickedDuplicateAnchor?.item?.label,
        groupExpanded: group.expanded === true,
        rootExpanded: (root as { expanded?: boolean }).expanded === true,
      }
    } finally {
      tab.nav = previousNav
      tab.sections = previousSections
      tab.sectionNavIndex = previousSectionNavIndex
    }
  })

  expect(paths).toEqual({
    cyclic: ['Cyclic'],
    duplicate: ['Group', 'First duplicate'],
    fresh: ['Fresh'],
    groupExpanded: true,
    mappedDuplicate: 'Group',
    pickedDuplicateAnchor: 'Group',
    regular: ['Root', 'Child', 'Leaf'],
    rootExpanded: true,
  })
})

test('reapplies zoom layout when switching from double page to single page', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  await openFixtureBook(page, 0)
  await waitForStableReaderLayout(page, { header: false })

  await page.evaluate(() => {
    const tab = (window as any).reader.focusedBookTab
    tab.updateConfiguration({
      ...tab.book.configuration,
      typography: {
        ...tab.book.configuration?.typography,
        zoom: 1.5,
      },
    })
  })

  await expect
    .poll(async () =>
      page.evaluate(() => {
        const tab = (window as any).reader.focusedBookTab
        return tab?.book?.configuration?.typography?.zoom
      }),
    )
    .toBe(1.5)

  await page.evaluate(() => {
    const tab = (window as any).reader.focusedBookTab
    tab.updateConfiguration({
      ...tab.book.configuration,
      typography: {
        ...tab.book.configuration?.typography,
        spread: 'none',
        zoom: 1.5,
      },
    })
  })

  await expect
    .poll(async () =>
      page.evaluate(() => {
        const tab = (window as any).reader.focusedBookTab
        const manager = tab?.rendition?.manager
        const layout = manager?.layout
        const signature = manager?.viewSettings?.layoutStyleSignature
        const views = manager?.views?._views ?? []
        const frame = Array.from(document.querySelectorAll('iframe')).find(
          (candidate) => !candidate.closest('[aria-hidden="true"]'),
        ) as HTMLIFrameElement | undefined
        const body = frame?.contentDocument?.body
        const bodyStyle = body ? getComputedStyle(body) : undefined
        const bodyColumnWidth = bodyStyle ? Number.parseFloat(bodyStyle.columnWidth) : 0
        const expectedColumnWidth = typeof layout?.columnWidth === 'number' ? layout.columnWidth / 1.5 : 0

        return {
          columnMatches: expectedColumnWidth > 0 && Math.abs(bodyColumnWidth - expectedColumnWidth) <= 1,
          divisor: layout?.divisor,
          signature,
          spread: tab?.rendition?.settings?.spread,
          viewSignatures: views.map((view: any) => view?.settings?.layoutStyleSignature),
        }
      }),
    )
    .toMatchObject({
      columnMatches: true,
      divisor: 1,
      spread: 'none',
      viewSignatures: expect.arrayContaining([expect.stringContaining('none')]),
    })
})

test('keeps zoomed images inside the current page column in double page mode', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  await openFixtureBook(page, 0)
  await waitForStableReaderLayout(page, { header: false })

  await page.evaluate(() => {
    const tab = (window as any).reader.focusedBookTab
    tab.updateConfiguration({
      ...tab.book.configuration,
      typography: {
        ...tab.book.configuration?.typography,
        spread: 'auto',
        zoom: 2,
      },
    })
  })

  await expect
    .poll(async () =>
      page.evaluate(() => {
        const tab = (window as any).reader.focusedBookTab
        const layout = tab?.rendition?.manager?.layout
        return {
          divisor: layout?.divisor,
          zoom: tab?.book?.configuration?.typography?.zoom,
        }
      }),
    )
    .toMatchObject({ divisor: 2, zoom: 2 })

  await expect
    .poll(() =>
      page.evaluate(() =>
        Array.from(document.querySelectorAll('iframe')).some(
          (candidate) => !candidate.closest('[aria-hidden="true"]') && Boolean(candidate.contentDocument?.body),
        ),
      ),
    )
    .toBe(true)

  await page.evaluate(async () => {
    const frame = Array.from(document.querySelectorAll('iframe')).find(
      (candidate) => !candidate.closest('[aria-hidden="true"]') && candidate.contentDocument?.body,
    )
    const doc = frame?.contentDocument
    if (!doc?.body) throw new Error('Missing active reader document')

    const image = doc.createElement('img')
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="2400" height="1200">' +
      '<rect width="2400" height="1200" fill="#334155"/>' +
      '<text x="1200" y="640" text-anchor="middle" font-size="180" fill="#f8fafc">wide image</text>' +
      '</svg>'
    image.src = `data:image/svg+xml,${encodeURIComponent(svg)}`
    image.alt = 'Wide zoom layout target'
    image.style.display = 'block'
    const inlineIcon = doc.createElement('img')
    inlineIcon.src = `data:image/svg+xml,${encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><circle cx="256" cy="256" r="220" fill="#111827"/></svg>',
    )}`
    inlineIcon.alt = 'Inline zoom footnote icon'
    inlineIcon.style.height = '0.9em'
    inlineIcon.style.width = 'auto'
    const inlineAnchor = doc.createElement('a')
    inlineAnchor.appendChild(inlineIcon)
    const inlineSup = doc.createElement('sup')
    inlineSup.appendChild(inlineAnchor)
    doc.body.prepend(image, inlineSup)

    await Promise.all(
      [image, inlineIcon].map(
        (target) =>
          new Promise<void>((resolve, reject) => {
            target.onload = () => resolve()
            target.onerror = () => reject(new Error('Zoom layout test image failed'))
            if (target.complete) resolve()
          }),
      ),
    )
  })

  let metrics:
    | {
        bodyTransform?: string
        columnWidth: number
        imageMaxInlineSize?: string
        imageMaxWidth?: string
        imageWidth: number
        inlineIconHeight: number
        inlineIconMaxHeight: number
        maxVisualWidth: number
      }
    | undefined
  await expect
    .poll(async () => {
      metrics = await page.evaluate(() => {
        const tab = (window as any).reader.focusedBookTab
        const layout = tab?.rendition?.manager?.layout
        const frame = Array.from(document.querySelectorAll('iframe')).find(
          (candidate) => !candidate.closest('[aria-hidden="true"]') && candidate.contentDocument?.body,
        )
        const doc = frame?.contentDocument
        const image = doc?.querySelector('img[alt="Wide zoom layout target"]') as HTMLImageElement | null
        const rect = image?.getBoundingClientRect()
        const inlineIcon = doc?.querySelector('img[alt="Inline zoom footnote icon"]') as HTMLImageElement | null
        const inlineIconRect = inlineIcon?.getBoundingClientRect()
        const inlineIconStyle = inlineIcon ? getComputedStyle(inlineIcon) : undefined
        const style = image ? getComputedStyle(image) : undefined
        const bodyStyle = doc?.body ? getComputedStyle(doc.body) : undefined
        const paddingLeft = bodyStyle ? Number.parseFloat(bodyStyle.paddingLeft) || 0 : 0
        const paddingRight = bodyStyle ? Number.parseFloat(bodyStyle.paddingRight) || 0 : 0
        const zoom = tab?.book?.configuration?.typography?.zoom ?? 1
        const columnWidth = typeof layout?.columnWidth === 'number' ? layout.columnWidth : 0
        const maxVisualWidth = columnWidth - (paddingLeft + paddingRight) * zoom

        return {
          bodyTransform: bodyStyle?.transform,
          columnWidth,
          imageMaxInlineSize: style?.maxInlineSize,
          imageMaxWidth: style?.maxWidth,
          imageWidth: rect?.width ?? 0,
          inlineIconHeight: inlineIconRect?.height ?? 0,
          inlineIconMaxHeight: (Number.parseFloat(inlineIconStyle?.fontSize ?? '') || 0) * 0.9 * zoom,
          maxVisualWidth,
        }
      })
      return metrics.imageWidth > 0 && metrics.maxVisualWidth > 0
    })
    .toBe(true)

  expect(metrics).toBeDefined()
  expect(metrics!.imageWidth, JSON.stringify(metrics)).toBeLessThanOrEqual(metrics!.maxVisualWidth + 1)
  expect(metrics!.inlineIconHeight, JSON.stringify(metrics)).toBeLessThanOrEqual(metrics!.inlineIconMaxHeight + 1)
})

test('long-book does not expose next-chapter body under stale header while page turn is pending', async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 900 })

  await openFixtureBook(page, 0)
  await waitForStableReaderLayout(page, { header: false })
  await setLongBookAtSectionFinalSpread(page, 38)
  await waitForStableReaderLayout(page, {
    header: /FLOW-CHAPTER-039/,
    sidebarVisible: true,
  })

  await page.evaluate(() => {
    const tab = (window as any).reader.focusedBookTab
    const rendition = tab?.rendition
    if (!rendition) throw new Error('Missing rendition')

    const original = rendition.reportLocation.bind(rendition)
    let release: (() => void) | undefined
    ;(window as any).__flowReleaseReportLocation = () => release?.()
    rendition.reportLocation = async (...args: unknown[]) => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return original(...args)
    }
  })

  const turnPromise = page.evaluate(() => (window as any).reader.focusedBookTab.next())

  try {
    await expect
      .poll(async () => {
        const state = await readActiveReaderBodyHeaderState(page)
        return state.body.includes('FLOW-CHAPTER-040')
      })
      .toBe(true)

    const pendingState = await readActiveReaderBodyHeaderState(page)
    expect(pendingState.header).toContain('FLOW-CHAPTER-039')
    expect(pendingState.body).toContain('FLOW-CHAPTER-040')
    expect(pendingState.coverVisible, JSON.stringify(pendingState)).toBe(true)
  } finally {
    await page.evaluate(() => {
      ;(window as any).__flowReleaseReportLocation?.()
    })
    await turnPromise
  }

  await waitForStableReaderLayout(page, {
    header: /FLOW-CHAPTER-040/,
    sidebarVisible: true,
  })
})

test('long-book closes image preview when clicking outside the visible image', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  await openFixtureBook(page, 0)
  await waitForStableReaderLayout(page, { header: false })

  await page.evaluate(async () => {
    const tab = (window as any).reader.focusedBookTab
    const doc = tab?.iframe?.document
    if (!doc?.body) throw new Error('Missing active reader document')

    const image = doc.createElement('img')
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="2400" height="1600">' +
      '<rect width="2400" height="1600" fill="#1d4ed8"/>' +
      '<circle cx="1200" cy="800" r="520" fill="#f8fafc"/>' +
      '</svg>'
    image.src = `data:image/svg+xml,${encodeURIComponent(svg)}`
    image.alt = 'Large preview target'
    doc.body.prepend(image)

    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve()
      image.onerror = () => reject(new Error('Preview test image failed'))
      if (image.complete) resolve()
    })

    image.dispatchEvent(
      new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        composed: true,
      }),
    )
  })

  const preview = page.locator('div[role="dialog"][aria-modal="true"]').filter({ has: page.locator('img') })
  await expect(preview).toBeVisible()

  const image = preview.locator('img')
  await expect.poll(async () => (await image.boundingBox())?.width ?? 0).toBeLessThan(1400)

  const imageBox = await image.boundingBox()
  if (!imageBox) throw new Error('Missing preview image bounds')

  const clickX = imageBox.x > 24 ? imageBox.x - 16 : imageBox.x + imageBox.width + 16
  await page.mouse.click(clickX, imageBox.y + imageBox.height / 2)
  await expect(preview).toBeHidden()
})

test('long-book keeps chapter find bar out of the reading content', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  await openFixtureBook(page, 0)
  await waitForStableReaderLayout(page, { header: false })

  await page.keyboard.press(findShortcut)

  const findInput = page.getByRole('textbox', { name: msg('reader.find_current_chapter') })
  await expect(findInput).toBeVisible()

  const metrics = await page.evaluate(() => {
    const findBar = document.querySelector('[data-flow-chapter-find-bar]')
    const content = document.querySelector('[data-flow-reader-content]')
    const findBarRect = findBar?.getBoundingClientRect()
    const contentRect = content?.getBoundingClientRect()

    return {
      contentTop: Math.round(contentRect?.top ?? -1),
      findBarBottom: Math.round(findBarRect?.bottom ?? -1),
    }
  })

  expect(metrics.findBarBottom).toBeLessThanOrEqual(metrics.contentTop)
})

async function displayFocusedSectionIndex(page: Page, sectionIndex: number) {
  await page.evaluate(async (targetIndex) => {
    const tab = (window as any).reader.focusedBookTab
    const section = tab?.sections?.find((candidate: { index?: number }) => candidate.index === targetIndex)
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
    const spreadIndexes = [spread?.left?.section?.index, spread?.right?.section?.index].filter(
      (index): index is number => typeof index === 'number',
    )

    return {
      activeTabId: tab?.id,
      bodySectionIndexes: [...markerNumbers].map((number) => number - 1).sort((a, b) => a - b),
      frameCount: activeFrames.length,
      frameTexts,
      rendered: tab?.rendered,
      atEnd: location?.atEnd === true,
      renditionIndexes: [tab?.rendition?.location?.start?.index, tab?.rendition?.location?.end?.index].filter(
        (index): index is number => typeof index === 'number',
      ),
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
    const tabs = (window as any).reader.tabs
    const tab = tabs.find((candidate: any) => candidate.id === targetTabId)
    if (!tab) throw new Error(`Missing tab ${targetTabId}`)

    const location = tab.paginationSnapshot?.location
    const spread = tab.rendition?.manager?.currentReflowableSpread

    return {
      atEnd: location?.atEnd === true,
      bookCfi: tab.book?.cfi,
      currentLocationIndexes: [tab.currentLocation?.start?.index, tab.currentLocation?.end?.index].filter(
        (index: unknown): index is number => typeof index === 'number',
      ),
      rendered: tab.rendered,
      renditionIndexes: [tab.rendition?.location?.start?.index, tab.rendition?.location?.end?.index].filter(
        (index: unknown): index is number => typeof index === 'number',
      ),
      snapshotIndexes: [location?.start?.index, location?.end?.index].filter(
        (index: unknown): index is number => typeof index === 'number',
      ),
      spreadIndexes: [spread?.left?.section?.index, spread?.right?.section?.index].filter(
        (index: unknown): index is number => typeof index === 'number',
      ),
      visibleSectionIndexes: [...(tab.visibleSectionIndexes ?? [])],
    }
  }, tabId)
}

async function expectLongBookTabSection(page: Page, tabId: string, expectedSectionIndex: number) {
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

async function expectFocusedLongBookSection(page: Page, expectedSectionIndex: number) {
  await expect
    .poll(async () => {
      const state = await readFocusedLongBookIntegrity(page)
      const visible = new Set([...state.visibleSectionIndexes, ...state.snapshotIndexes, ...state.spreadIndexes])

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
      const committed = new Set([...state.visibleSectionIndexes, ...state.snapshotIndexes, ...state.spreadIndexes])
      const hasCommittedBody =
        state.bodySectionIndexes.length > 0 && state.bodySectionIndexes.every((index) => committed.has(index))
      const locationStillAligned =
        !state.snapshotIndexes.length ||
        !state.renditionIndexes.length ||
        state.snapshotIndexes.some((index) => state.renditionIndexes.includes(index))

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

test('keeps inactive reader panes at the active reader geometry', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 })

  await openFixtureBook(page, 0)
  await waitForStableReaderLayout(page)
  await openFixtureBookByName(page, 'Tab Layout B')
  await waitForStableReaderLayout(page)

  expectStablePaneGeometry(await readReaderPaneGeometry(page))

  await readerTab(page, 'Tab Layout A').click()
  expectStablePaneGeometry(await readReaderPaneGeometry(page))

  await ensureTocSidebarVisibility(page, false)
  expectStablePaneGeometry(await readReaderPaneGeometry(page))

  await readerTab(page, 'Tab Layout B').click()
  expectStablePaneGeometry(await readReaderPaneGeometry(page))
})

test('keeps tab layout stable across repeated tab and sidebar changes', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 })

  await openFixtureBook(page, 0)
  await expect(readerTab(page, 'Tab Layout A')).toBeVisible()
  await expectRightEdgeNavigation(page)
  const initialA = await waitForStableReaderLayout(page)
  expect(initialA.sidebarVisible).toBe(true)
  await stampVisibleFrames(page, 'tab-a-wide')

  await openFixtureBookByName(page, 'Tab Layout B')
  await expect(readerTab(page, 'Tab Layout B')).toBeVisible()
  const initialB = await waitForStableReaderLayout(page)
  expect(initialB.sidebarVisible).toBe(true)
  await stampVisibleFrames(page, 'tab-b-wide')

  await readerTab(page, 'Tab Layout A').click()
  const unchangedA = await expectHealthyLayoutWithSidebar(page, true)
  expect(unchangedA.footer).toBe(initialA.footer)
  await expectVisibleFrameStamp(page, 'tab-a-wide')

  await readerTab(page, 'Tab Layout B').click()
  const unchangedB = await expectHealthyLayoutWithSidebar(page, true)
  expect(unchangedB.footer).toBe(initialB.footer)
  await expectVisibleFrameStamp(page, 'tab-b-wide')

  await toggleTocSidebar(page)
  const hiddenB = await waitForStableReaderLayout(page, {
    sidebarVisible: false,
  })
  await stampVisibleFrames(page, 'tab-b-hidden')

  await readerTab(page, 'Tab Layout A').click()
  const hiddenA = await waitForStableReaderLayout(page, {
    sidebarVisible: false,
  })
  await stampVisibleFrames(page, 'tab-a-hidden')

  expect(hiddenA.frames.every((frame) => frame.width > 250)).toBe(true)
  expect(hiddenB.frames.every((frame) => frame.width > 250)).toBe(true)

  await readerTab(page, 'Tab Layout B').click()
  await expectHealthyLayoutWithSidebar(page, false)
  await expectVisibleFrameStamp(page, 'tab-b-hidden')

  await readerTab(page, 'Tab Layout A').click()
  await expectHealthyLayoutWithSidebar(page, false)
  await expectVisibleFrameStamp(page, 'tab-a-hidden')

  await readerTab(page, 'Tab Layout B').click()
  await expectHealthyLayoutWithSidebar(page, false)
  await expectVisibleFrameStamp(page, 'tab-b-hidden')

  await toggleTocSidebar(page)
  await waitForStableReaderLayout(page, { sidebarVisible: true })
  await stampVisibleFrames(page, 'tab-b-wide-again')

  await readerTab(page, 'Tab Layout A').click()
  await waitForStableReaderLayout(page, { sidebarVisible: true })
  await stampVisibleFrames(page, 'tab-a-wide-again')

  await readerTab(page, 'Tab Layout B').click()
  await expectHealthyLayoutWithSidebar(page, true)
  await expectVisibleFrameStamp(page, 'tab-b-wide-again')

  await readerTab(page, 'Tab Layout A').click()
  await expectHealthyLayoutWithSidebar(page, true)
  await expectVisibleFrameStamp(page, 'tab-a-wide-again')

  await page.setViewportSize({ width: 900, height: 900 })
  const resizedA = await waitForStableReaderLayout(page, {
    sidebarVisible: true,
  })
  await stampVisibleFrames(page, 'tab-a-narrow')

  await readerTab(page, 'Tab Layout B').click()
  const resizedB = await waitForStableReaderLayout(page, {
    sidebarVisible: true,
  })
  await stampVisibleFrames(page, 'tab-b-narrow')

  await readerTab(page, 'Tab Layout A').click()
  await expectHealthyLayoutWithSidebar(page, true)
  await expectVisibleFrameStamp(page, 'tab-a-narrow')

  expect(resizedA.footer).not.toBe(initialA.footer)
  expect(resizedB.footer).not.toBe(initialB.footer)
  expect(resizedA.frames.every((frame) => frame.width > 250)).toBe(true)
  expect(resizedA.frames.every((frame) => frame.maxTextBlockWidth > 180)).toBe(true)
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

  const seen = new Map<string, Awaited<ReturnType<typeof readFocusedRenderSignature>>>()

  async function visitLayoutState(viewport: { width: number; height: number }, sidebarVisible: boolean) {
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

test('replays multi-tab mixed layout states deterministically', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 })

  await openFixtureBook(page, 0)
  await waitForStableReaderLayout(page, { sidebarVisible: true })
  await advanceFocusedTabPages(page, 1)
  await waitForStableReaderLayout(page, {
    header: false,
    sidebarVisible: true,
  })

  await openFixtureBookByName(page, 'Tab Layout B')
  await waitForStableReaderLayout(page, { sidebarVisible: true })
  await advanceFocusedTabPages(page, 3)
  await waitForStableReaderLayout(page, {
    header: false,
    sidebarVisible: true,
  })

  await openFixtureBookByName(page, 'Tab Layout C')
  await waitForStableReaderLayout(page, { sidebarVisible: true })
  await installFullTabRuntimeProbe(page)
  await advanceFocusedTabPages(page, 5)
  await waitForStableReaderLayout(page, {
    header: false,
    sidebarVisible: true,
  })

  const seen = new Map<string, Awaited<ReturnType<typeof readFocusedRenderSignature>>>()

  async function visitMixedState(
    tabName: string,
    viewport: { width: number; height: number },
    sidebarVisible: boolean,
  ) {
    await readerTab(page, tabName).click()
    await expectFocusedTabId(
      page,
      tabName === 'Tab Layout A' ? 'tab-layout-a' : tabName === 'Tab Layout B' ? 'tab-layout-b' : 'tab-layout-c',
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

test('keeps committed locations stable during rapid tab switches', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 })

  await openFixtureBook(page, 0)
  await waitForStableReaderLayout(page, { sidebarVisible: true })

  await openFixtureBookByName(page, 'Tab Layout B')
  await waitForStableReaderLayout(page, { sidebarVisible: true })
  await advanceFocusedTabPages(page, 2)
  await waitForStableReaderLayout(page, { sidebarVisible: true })

  await readerTab(page, 'Tab Layout A').click()
  await waitForStableReaderLayout(page, { sidebarVisible: true })
  const before = await readAllBookTabStates(page)

  for (let i = 0; i < 12; i++) {
    await readerTab(page, i % 2 ? 'Tab Layout A' : 'Tab Layout B').click()
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
    expect(current?.visibleSectionIndexes).toEqual(previous.visibleSectionIndexes)
    expect(current?.rendered).toBe(true)
    expect(current?.turning).toBe(false)
  }
})

test('switches adjacent tabs immediately with wheel and keyboard input', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 })

  await openFixtureBook(page, 0)
  await waitForStableReaderLayout(page, { sidebarVisible: true })

  await openFixtureBookByName(page, 'Tab Layout B')
  await waitForStableReaderLayout(page, { sidebarVisible: true })
  await openFixtureBookByName(page, 'Tab Layout C')
  await waitForStableReaderLayout(page, { sidebarVisible: true })
  await expectFocusedTabId(page, 'tab-layout-c')

  await readerTab(page, 'Tab Layout A').click()
  await expectFocusedTabId(page, 'tab-layout-a')

  await readerTab(page, 'Tab Layout A').hover()
  await page.mouse.wheel(0, 80)
  await expectFocusedTabId(page, 'tab-layout-b')
  await page.mouse.wheel(0, 80)
  await expectFocusedTabId(page, 'tab-layout-c')

  await readerTab(page, 'Tab Layout A').click()
  await expectFocusedTabId(page, 'tab-layout-a')

  await page.keyboard.press('Control+ArrowRight')
  await expectFocusedTabId(page, 'tab-layout-b')
  await page.keyboard.press('Control+ArrowRight')
  await expectFocusedTabId(page, 'tab-layout-c')
})

test('[scrolled-doc] keeps one-page footer and turns chapters only at scroll boundaries', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 700 })
  await openFixtureBook(page, 0)

  await expect
    .poll(() =>
      page.evaluate(() => {
        const tab = (window as any).reader.focusedBookTab
        const manager = tab?.rendition?.manager
        const container = manager?.container
        const location = tab?.paginationSnapshot?.location?.start

        return {
          flow: tab?.rendition?.settings?.globalLayoutProperties?.flow,
          index: location?.index,
          page: location?.displayed?.page,
          total: location?.displayed?.total,
          divisor: manager?.layout?.divisor,
          maxScrollTop: container ? container.scrollHeight - container.clientHeight : 0,
          overflowX: container ? getComputedStyle(container).overflowX : null,
        }
      }),
    )
    .toMatchObject({
      flow: 'scrolled-doc',
      index: 0,
      page: 1,
      total: 1,
      divisor: 1,
      maxScrollTop: expect.any(Number),
      overflowX: 'hidden',
    })

  const initialPercentage = await page.evaluate(
    () => (window as any).reader.focusedBookTab.paginationSnapshot.percentage,
  )
  expect(initialPercentage).toBeCloseTo(0.5, 5)

  const activeFrame = page.locator('[data-flow-reader-pane][aria-hidden="false"] iframe').last()
  await activeFrame.hover()
  await page.mouse.wheel(0, 240)

  await expect
    .poll(() =>
      page.evaluate(() => {
        const tab = (window as any).reader.focusedBookTab
        const manager = tab?.rendition?.manager

        return {
          index: tab?.paginationSnapshot?.location?.start?.index,
          percentage: tab?.paginationSnapshot?.percentage,
          scrollTop: manager?.container?.scrollTop ?? 0,
        }
      }),
    )
    .toMatchObject({
      index: 0,
      percentage: initialPercentage,
      scrollTop: expect.any(Number),
    })
  expect(
    await page.evaluate(() => (window as any).reader.focusedBookTab.rendition.manager.container.scrollTop),
  ).toBeGreaterThan(0)

  await page.evaluate(() => {
    const container = (window as any).reader.focusedBookTab.rendition.manager.container
    container.scrollTop = container.scrollHeight
  })
  await activeFrame.hover()
  await page.mouse.wheel(0, 240)

  await expect
    .poll(() =>
      page.evaluate(() => {
        const tab = (window as any).reader.focusedBookTab
        const location = tab?.paginationSnapshot?.location?.start

        return {
          index: location?.index,
          page: location?.displayed?.page,
          total: location?.displayed?.total,
          scrollTop: tab?.rendition?.manager?.container?.scrollTop,
        }
      }),
    )
    .toEqual({
      index: 1,
      page: 1,
      total: 1,
      scrollTop: 0,
    })
})

test('reorders tabs without changing the focused reader runtime', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 })

  await openFixtureBook(page, 0)
  await waitForStableReaderLayout(page, { sidebarVisible: true })
  await openFixtureBookByName(page, 'Tab Layout B')
  await waitForStableReaderLayout(page, { sidebarVisible: true })
  await openFixtureBookByName(page, 'Tab Layout C')
  await waitForStableReaderLayout(page, { sidebarVisible: true })
  await readerTab(page, 'Tab Layout B').click()
  await expectFocusedTabId(page, 'tab-layout-b')

  await installBookTabRuntimeCounters(page)
  await resetBookTabRuntimeCounters(page)

  await page.keyboard.press('Control+Shift+ArrowRight')

  await expect
    .poll(() => readerTabs(page).evaluateAll((tabs) => tabs.map((tab) => tab.textContent?.trim())))
    .toEqual(['Tab Layout A', 'Tab Layout C', 'Tab Layout B'])
  await expectFocusedTabId(page, 'tab-layout-b')

  const counters = await readBookTabRuntimeCounters(page)
  counters.forEach((counter) =>
    expect(counter).toMatchObject({
      display: 0,
      next: 0,
      prev: 0,
      relayoutCurrentView: 0,
      resizeRendition: 0,
      setActive: 0,
    }),
  )
})

test('commits pointer tab reordering only inside the tab strip', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 })

  await openFixtureBook(page, 0)
  await waitForStableReaderLayout(page, { sidebarVisible: true })
  await openFixtureBookByName(page, 'Tab Layout B')
  await waitForStableReaderLayout(page, { sidebarVisible: true })
  await openFixtureBookByName(page, 'Tab Layout C')
  await waitForStableReaderLayout(page, { sidebarVisible: true })
  await installFullTabRuntimeProbe(page)

  await page.evaluate(() => {
    const panes = Array.from(document.querySelectorAll<HTMLElement>('[data-flow-reader-pane]'))
    const parent = panes[0]?.parentElement
    if (!parent) throw new Error('Missing reader pane parent')

    const movedPaneIds: string[] = []
    panes.forEach((pane, index) => {
      pane.dataset.flowPaneIdentity = String(index)
    })
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of [...record.removedNodes, ...record.addedNodes]) {
          if (!(node instanceof HTMLElement)) continue
          if (!node.matches('[data-flow-reader-pane]')) continue
          movedPaneIds.push(node.dataset.flowPaneIdentity ?? '')
        }
      }
    })
    observer.observe(parent, { childList: true })
    ;(window as any).__flowTabReorderPaneProbe = {
      activePane: document.querySelector('[data-flow-reader-pane][aria-hidden="false"]'),
      movedPaneIds,
      observer,
      panes,
    }
  })

  const tabA = readerTab(page, 'Tab Layout A')
  const tabC = readerTab(page, 'Tab Layout C')
  const tabABox = await tabA.boundingBox()
  const tabCBox = await tabC.boundingBox()
  if (!tabABox || !tabCBox) throw new Error('Missing tab bounds')

  await page.mouse.move(tabABox.x + tabABox.width / 2, tabABox.y + tabABox.height / 2)
  await page.mouse.down()
  await page.mouse.move(tabCBox.x + tabCBox.width - 2, tabCBox.y + tabCBox.height / 2, { steps: 5 })

  const dropIndicator = page.locator('[data-flow-tab-drop-indicator]')
  await expect(dropIndicator).toHaveAttribute('data-flow-tab-drop-indicator', 'after')
  await expect(tabC).not.toHaveClass(/ring-ring/)
  const indicatorBox = await dropIndicator.boundingBox()
  if (!indicatorBox) throw new Error('Missing tab drop indicator bounds')
  expect(indicatorBox.width).toBe(2)
  expect(indicatorBox.height).toBe(20)
  expect(Math.abs(indicatorBox.x + indicatorBox.width / 2 - (tabCBox.x + tabCBox.width))).toBeLessThanOrEqual(6)

  await page.mouse.up()

  const tabOrder = () => readerTabs(page).evaluateAll((tabs) => tabs.map((tab) => tab.textContent?.trim()))
  await expect.poll(tabOrder).toEqual(['Tab Layout B', 'Tab Layout C', 'Tab Layout A'])
  await expectFocusedTabId(page, 'tab-layout-c')

  const paneStability = await page.evaluate(() => {
    const probe = (window as any).__flowTabReorderPaneProbe
    probe.observer.disconnect()
    const panes = Array.from(document.querySelectorAll('[data-flow-reader-pane]'))

    return {
      activePaneStable: document.querySelector('[data-flow-reader-pane][aria-hidden="false"]') === probe.activePane,
      movedPaneIds: probe.movedPaneIds,
      paneOrderStable: panes.length === probe.panes.length && panes.every((pane, index) => pane === probe.panes[index]),
    }
  })
  expect(paneStability).toEqual({
    activePaneStable: true,
    movedPaneIds: [],
    paneOrderStable: true,
  })
  const runtimeStability = await readFullTabRuntimeStability(page)
  runtimeStability.forEach((state: Record<string, boolean>, tabIndex: number) => {
    Object.entries(state).forEach(([name, stable]) => {
      expect(stable, `tab ${tabIndex} runtime ${name}`).toBe(true)
    })
  })

  const tabB = readerTab(page, 'Tab Layout B')
  const tabList = readerTabs(page).first().locator('..')
  const tabBBox = await tabB.boundingBox()
  const tabListBox = await tabList.boundingBox()
  if (!tabBBox || !tabListBox) throw new Error('Missing tab bounds')

  await page.mouse.move(tabBBox.x + tabBBox.width / 2, tabBBox.y + tabBBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(tabListBox.x + tabListBox.width + 20, tabBBox.y + tabBBox.height / 2, { steps: 5 })
  await page.mouse.up()

  await expect.poll(tabOrder).toEqual(['Tab Layout B', 'Tab Layout C', 'Tab Layout A'])
})

test('[vertical-rl] preserves double-page and panel runtime across tab reordering', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 })
  await openVerticalFixtureBook(page)
  await openFixtureBookByName(page, 'Tab Layout C')
  await waitForVerticalReaderLoaded(page)

  await page.evaluate(() => {
    const tab = (window as any).reader.focusedBookTab
    tab.updateConfiguration({
      ...tab.book.configuration,
      typography: {
        ...tab.book.configuration?.typography,
        fontSize: '18px',
        spread: 'auto',
      },
    })
    tab.define(['FLOW-RUNTIME-DEFINITION-C'])
    tab.setKeyword('VERTICAL-CHAPTER-01-29')
  })
  await expect.poll(() => page.evaluate(() => (window as any).reader.focusedBookTab?.results?.length)).toBe(1)
  await waitForStableReaderLayout(page, { header: false })

  const activityBar = page.locator('.ActivityBar')
  const sidebar = page.locator('.SideBar')
  await activityBar.getByRole('button', { name: msg('image.title') }).click()
  await sidebar.getByRole('button', { name: msg('image.filter.all'), exact: true }).click()
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).reader.focusedBookTab?.sections?.every((section: any) => Array.isArray(section.images)),
      ),
    )
    .toBe(true)

  await activityBar.getByRole('button', { name: msg('typography.title') }).click()
  await expect(sidebar.getByRole('spinbutton', { name: msg('typography.font_size') })).toHaveValue('18')
  await expect(page.locator('[data-flow-reader-pane][aria-hidden="false"] [data-flow-reader-content]')).toHaveAttribute(
    'data-flow-reader-spread',
    'double',
  )
  await expect
    .poll(() => page.evaluate(() => (window as any).reader.focusedBookTab?.rendition?.manager?.layout?.divisor))
    .toBe(2)

  await installBookTabRuntimeCounters(page)
  await resetBookTabRuntimeCounters(page)
  await installFullTabRuntimeProbe(page)

  const tabC = readerTab(page, 'Tab Layout C')
  const tabA = readerTab(page, 'Tab Layout A')
  const tabCBox = await tabC.boundingBox()
  const tabABox = await tabA.boundingBox()
  if (!tabCBox || !tabABox) throw new Error('Missing tab bounds')

  await page.mouse.move(tabCBox.x + tabCBox.width / 2, tabCBox.y + tabCBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(tabABox.x + 2, tabABox.y + tabABox.height / 2, {
    steps: 5,
  })
  await page.mouse.up()

  await expect
    .poll(() => readerTabs(page).evaluateAll((tabs) => tabs.map((tab) => tab.textContent?.trim())))
    .toEqual(['Tab Layout C', 'Tab Layout A', 'Tab Layout B'])
  await expectFocusedTabId(page, 'tab-layout-c')
  await expect(page.locator('[data-flow-reader-pane][aria-hidden="false"] [data-flow-reader-content]')).toHaveAttribute(
    'data-flow-reader-spread',
    'double',
  )

  const runtimeStability = await readFullTabRuntimeStability(page)
  runtimeStability.forEach((state: Record<string, boolean>, tabIndex: number) => {
    Object.entries(state).forEach(([name, stable]) => {
      expect(stable, `vertical tab ${tabIndex} runtime ${name}`).toBe(true)
    })
  })
  const counters = await readBookTabRuntimeCounters(page)
  counters.forEach((counter) =>
    expect(counter).toMatchObject({
      display: 0,
      next: 0,
      prev: 0,
      relayoutCurrentView: 0,
      resizeRendition: 0,
      setActive: 0,
    }),
  )

  await activityBar.getByRole('button', { name: msg('search.title') }).click()
  await expect(sidebar.getByRole('textbox', { name: msg('search.title') })).toHaveValue('VERTICAL-CHAPTER-01-29')
  await activityBar.getByRole('button', { name: msg('annotation.title') }).click()
  await expect(sidebar.getByText('FLOW-RUNTIME-DEFINITION-C')).toBeVisible()
  await activityBar.getByRole('button', { name: msg('image.title') }).click()
  await expect
    .poll(() =>
      sidebar
        .getByRole('button', { name: msg('image.filter.all'), exact: true })
        .evaluate((element) => element.className.includes('bg-(--flow-accent-bg)')),
    )
    .toBe(true)
  await activityBar.getByRole('button', { name: msg('typography.title') }).click()
  await expect(sidebar.getByRole('spinbutton', { name: msg('typography.font_size') })).toHaveValue('18')
  await activityBar.getByRole('button', { name: msg('toc.title') }).click()
  await expect(sidebar.getByText('VERTICAL-CHAPTER-01')).toBeVisible()
})

test('does not paginate during unchanged-size tab switches', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 })

  await openFixtureBook(page, 0)
  await waitForStableReaderLayout(page, { sidebarVisible: true })
  await openFixtureBookByName(page, 'Tab Layout B')
  await waitForStableReaderLayout(page, { sidebarVisible: true })
  await openFixtureBookByName(page, 'Tab Layout C')
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
    expect(framesA.find((frame) => frame.phase === 'after-click')?.t).toBeLessThan(24)
    framesA.forEach((frame) => expect(frame.metrics).toEqual(framesA[0]!.metrics))

    const framesB = await traceTabSwitchInteraction(page, 'Tab Layout B')
    await expectFocusedTabId(page, 'tab-layout-b')
    expect(framesB.at(-1)?.focusedTabId).toBe('tab-layout-b')
    expect(framesB.find((frame) => frame.phase === 'after-click')?.t).toBeLessThan(24)
    framesB.forEach((frame) => expect(frame.metrics).toEqual(framesB[0]!.metrics))

    const framesC = await traceTabSwitchInteraction(page, 'Tab Layout C')
    await expectFocusedTabId(page, 'tab-layout-c')
    expect(framesC.at(-1)?.focusedTabId).toBe('tab-layout-c')
    expect(framesC.find((frame) => frame.phase === 'after-click')?.t).toBeLessThan(24)
    framesC.forEach((frame) => expect(frame.metrics).toEqual(framesC[0]!.metrics))
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
  expect(counters.reduce((total, counter) => total + (counter.setActive ?? 0), 0)).toBe(12)
  expect(afterMotion.animated).toEqual([])

  for (const frame of afterMotion.frames) {
    expect(frame).toEqual(afterMotion.frames[0])
  }
})

test('long-book keeps distant chapter bodies tied to their committed tab state', async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 900 })

  await openFixtureBook(page, 0)
  await waitForStableReaderLayout(page, {
    header: false,
    sidebarVisible: true,
  })
  await displayFocusedSectionIndex(page, 38)
  await expectFocusedLongBookSection(page, 38)

  await openFixtureBookByName(page, 'Tab Layout B')
  await waitForStableReaderLayout(page, {
    header: false,
    sidebarVisible: true,
  })
  await displayFocusedSectionIndex(page, 565)
  await expectFocusedLongBookSection(page, 565)

  await openFixtureBookByName(page, 'Tab Layout C')
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
    await readerTab(page, tabName).click()
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

test('long-book inactive tab does not commit stale relayout after rapid switch', async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 900 })

  await openFixtureBook(page, 0)
  await waitForStableReaderLayout(page, {
    header: false,
    sidebarVisible: true,
  })
  await displayFocusedSectionIndex(page, 38)
  await expectFocusedLongBookSection(page, 38)

  await openFixtureBookByName(page, 'Tab Layout B')
  await waitForStableReaderLayout(page, {
    header: false,
    sidebarVisible: true,
  })
  await displayFocusedSectionIndex(page, 565)
  await expectFocusedLongBookSection(page, 565)

  await page.evaluate(() => {
    const tabs = (window as any).reader.tabs
    const tabA = tabs.find((tab: any) => tab.id === 'tab-layout-a')
    if (!tabA) throw new Error('Missing Tab Layout A')

    const originalDisplay = tabA.rendition.display.bind(tabA.rendition)
    tabA.rendition.display = async (...args: unknown[]) => {
      await new Promise((resolve) => setTimeout(resolve, 120))
      return originalDisplay(...args)
    }
  })

  await readerTab(page, 'Tab Layout A').click()
  await page.evaluate(() => {
    const tab = (window as any).reader.focusedBookTab
    void tab.relayoutCurrentView()
  })
  await readerTab(page, 'Tab Layout B').click()
  await expectFocusedLongBookSection(page, 565)
  await page.waitForTimeout(250)
  await expectLongBookTabSection(page, 'tab-layout-a', 38)

  const tabAState = await readLongBookIntegrityByTabId(page, 'tab-layout-a')
  expect(tabAState.bookCfi).not.toContain('chapter_566')
  expect(tabAState.visibleSectionIndexes).toEqual(expect.arrayContaining([38]))
})

test('long-book keeps final-page tab stable across switches and relayouts', async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 900 })

  await openFixtureBook(page, 0)
  await waitForStableReaderLayout(page, {
    header: false,
    sidebarVisible: true,
  })
  await displayFocusedSectionIndex(page, 38)
  await expectFocusedLongBookSection(page, 38)

  await openFixtureBookByName(page, 'Tab Layout B')
  await waitForStableReaderLayout(page, {
    header: false,
    sidebarVisible: true,
  })
  await displayFocusedSectionIndex(page, 619)
  await goFocusedLongBookToEnd(page)
  await expectFocusedLongBookSection(page, 619)
  await expect.poll(async () => (await readFocusedLongBookIntegrity(page)).atEnd).toBe(true)

  for (let i = 0; i < 3; i++) {
    await readerTab(page, 'Tab Layout A').click()
    await expectFocusedLongBookSection(page, 38)
    await readerTab(page, 'Tab Layout B').click()
    await expectFocusedLongBookSection(page, 619)
    await expect.poll(async () => (await readFocusedLongBookIntegrity(page)).atEnd).toBe(true)
  }

  await ensureTocSidebarVisibility(page, false, { header: false })
  await expectFocusedLongBookSection(page, 619)
  await readerTab(page, 'Tab Layout A').click()
  await page.setViewportSize({ width: 1180, height: 820 })
  await expectFocusedLongBookSection(page, 38)
  await readerTab(page, 'Tab Layout B').click()
  await expectFocusedLongBookSection(page, 619)
  await expect.poll(async () => (await readFocusedLongBookIntegrity(page)).atEnd).toBe(true)
  await ensureTocSidebarVisibility(page, true, { header: false })
  await page.setViewportSize({ width: 1500, height: 900 })
  await expectFocusedLongBookSection(page, 619)
  await expect.poll(async () => (await readFocusedLongBookIntegrity(page)).atEnd).toBe(true)
})

test('long-book does not reuse stale sidebar-layout spread after page turns', async ({ page }) => {
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

test('keeps three tabs stable and redraws same-chapter overlays immediately', async ({ page }) => {
  await page.setViewportSize({ width: 1360, height: 900 })

  await openFixtureBook(page, 0)
  await waitForStableReaderLayout(page, { sidebarVisible: true })
  await stampVisibleFrames(page, 'tab-a-initial')

  await openFixtureBookByName(page, 'Tab Layout B')
  await waitForStableReaderLayout(page, { sidebarVisible: true })
  await stampVisibleFrames(page, 'tab-b-initial')

  await openFixtureBookByName(page, 'Tab Layout C')
  await waitForStableReaderLayout(page, { sidebarVisible: true })
  await stampVisibleFrames(page, 'tab-c-initial')

  await readerTab(page, 'Tab Layout A').click()
  await expectVisibleFrameStamp(page, 'tab-a-initial')
  await readerTab(page, 'Tab Layout B').click()
  await expectVisibleFrameStamp(page, 'tab-b-initial')
  await readerTab(page, 'Tab Layout C').click()
  await expectVisibleFrameStamp(page, 'tab-c-initial')

  await toggleTocSidebar(page)
  await waitForStableReaderLayout(page, { sidebarVisible: false })
  await stampVisibleFrames(page, 'tab-c-sidebar-hidden')

  await page.setViewportSize({ width: 960, height: 820 })
  await waitForStableReaderLayout(page, { sidebarVisible: false })
  await stampVisibleFrames(page, 'tab-c-narrow')

  await readerTab(page, 'Tab Layout A').click()
  await waitForStableReaderLayout(page, { sidebarVisible: false })
  await stampVisibleFrames(page, 'tab-a-narrow')
  await readerTab(page, 'Tab Layout C').click()
  await expectVisibleFrameStamp(page, 'tab-c-narrow')

  const originalDefinition = '原书，ＡＢＣ'
  await page.evaluate((definition) => {
    ;(window as any).reader.focusedBookTab?.define([definition])
  }, originalDefinition)
  await expect
    .poll(() =>
      page.evaluate(
        (definition) => (window as any).reader.focusedBookTab?.overlayState.definitions.includes(definition) ?? false,
        originalDefinition,
      ),
    )
    .toBe(true)

  await page.evaluate(() => {
    ;(window as any).reader.focusedBookTab?.define(['Alice'])
  })
  await expectVisibleReaderMarks(page, 'flow-definition-underline', 1)
  await expectReaderMarkCursor(page, 'flow-definition-underline')

  const annotation = await addVisibleAnnotation(page)
  expect(annotation.text).toBe('Alice')
  await expectVisibleReaderMarks(page, 'epubjs-hl', 1)
  await expectReaderMarkCursor(page, 'epubjs-hl')

  await page.evaluate((definition) => {
    const tab = (window as any).reader.focusedBookTab
    tab?.undefine('Alice')
    tab?.undefine(definition)
  }, originalDefinition)
  await expect.poll(() => countVisibleReaderMarks(page, 'flow-definition-underline')).toBe(0)

  await page.evaluate((cfi) => {
    ;(window as any).reader.focusedBookTab?.removeAnnotation(cfi)
  }, annotation.cfi)
  await expect.poll(() => countVisibleReaderMarks(page, 'epubjs-hl')).toBe(0)

  await readerTab(page, 'Tab Layout A').click()
  await expectVisibleFrameStamp(page, 'tab-a-narrow')
  await readerTab(page, 'Tab Layout C').click()
  await expectVisibleFrameStamp(page, 'tab-c-narrow')
})

test('keeps final-page tabs stable across tab switches and sidebar relayouts', async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 900 })

  await openFixtureBook(page, 0)
  await waitForStableReaderLayout(page, { sidebarVisible: true })
  await stampVisibleFrames(page, 'tab-a-final-test')

  await openFixtureBookByName(page, 'Tab Layout B')
  await waitForStableReaderLayout(page, { sidebarVisible: true })
  await expect.poll(async () => (await readFocusedTabState(page)).tabId).toBe('tab-layout-b')
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

  await readerTab(page, 'Tab Layout A').click()
  await waitForStableReaderLayout(page, {
    header: false,
    sidebarVisible: true,
  })
  await expectVisibleFrameStamp(page, 'tab-a-final-test')
  await readerTab(page, 'Tab Layout B').click()
  await waitForStableReaderLayout(page, {
    header: false,
    sidebarVisible: true,
  })
  await expectVisibleFrameStamp(page, 'tab-b-final')

  await ensureTocSidebarVisibility(page, false, { header: false })
  await ensureTocSidebarVisibility(page, true, { header: false })
  await ensureTocSidebarVisibility(page, false, { header: false })

  await readerTab(page, 'Tab Layout A').click()
  await waitForStableReaderLayout(page, { sidebarVisible: false })
  await readerTab(page, 'Tab Layout B').click()
  const stableFinalB = await waitForStableReaderLayout(page, {
    header: false,
    sidebarVisible: false,
  })
  const stableState = await readFocusedTabState(page)

  expect(stableState.atEnd).toBe(true)
  expect(stableFinalB.footer).toContain('100.00%')
  expect(stableFinalB.frames.every((frame) => frame.width > 250)).toBe(true)
})

test('keeps right-page cross-section header and overlays in sync', async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 900 })

  await openFixtureBook(page, 0)
  await waitForStableReaderLayout(page, { sidebarVisible: true })
  await openFixtureBookByName(page, 'Tab Layout B')
  await waitForStableReaderLayout(page, { sidebarVisible: true })

  const spread = await goToCrossSectionSpread(page)
  const crossSectionLayout = await waitForStableReaderLayout(page, {
    header: false,
    sidebarVisible: true,
  })
  expect(crossSectionLayout.footer).toMatch(/\|/)
  const stableHeader = new RegExp(crossSectionLayout.header.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))

  await page.evaluate(async (sectionIndex) => {
    const tab = (window as any).reader.focusedBookTab
    const section = tab?.sections?.find((candidate: { index?: number }) => candidate.index === sectionIndex)
    if (!tab || !section) throw new Error('Missing target section')

    await tab.displaySectionStart(section)
    await new Promise((resolve) => window.setTimeout(resolve, 80))
  }, spread.rightSectionIndex)

  await waitForStableReaderLayout(page, {
    header: stableHeader,
    sidebarVisible: true,
  })

  const overlaySpread = await goToCrossSectionSpread(page)
  const annotation = await addRightPageDefinitionAndAnnotation(page, overlaySpread.rightSectionIndex)
  expect(annotation.sectionIndex).toBe(overlaySpread.rightSectionIndex)
  expect(annotation.text.length).toBeGreaterThan(3)

  await expectVisibleReaderMarks(page, 'epubjs-hl', 1)
  await expectVisibleReaderMarks(page, 'flow-definition-underline', 1)

  await readerTab(page, 'Tab Layout A').click()
  await waitForStableReaderLayout(page, { sidebarVisible: true })
  await readerTab(page, 'Tab Layout B').click()
  await waitForStableReaderLayout(page, { header: stableHeader, sidebarVisible: true })
  await expectVisibleReaderMarks(page, 'epubjs-hl', 1)
  await expectVisibleReaderMarks(page, 'flow-definition-underline', 1)
})
