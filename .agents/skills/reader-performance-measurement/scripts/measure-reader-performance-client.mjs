import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { chromium } from '@playwright/test'

const CDP_URL = process.env.FLOW_READER_CDP_URL ?? 'http://127.0.0.1:9351'
const APP_URL = process.env.FLOW_READER_APP_URL ?? 'http://127.0.0.1:7127'
const OUT_DIR =
  process.env.FLOW_READER_PERF_OUT_DIR ?? path.join(process.cwd(), 'perf-results', 'reader-performance-client')
const RUNS = Number(process.env.FLOW_READER_PERF_RUNS ?? 12)
const BURST_RUNS = Number(process.env.FLOW_READER_PERF_BURST_RUNS ?? Math.max(4, Math.floor(RUNS / 3)))
const STEADY_SKIP = Number(process.env.FLOW_READER_PERF_STEADY_SKIP ?? 3)
const CPU_PROFILE = process.env.FLOW_READER_CPU_PROFILE === '1'
const DIAGNOSTICS = process.env.FLOW_READER_PERF_DIAGNOSTICS === '1'
const WINDOW_WIDTH = Number(process.env.FLOW_READER_PERF_WINDOW_WIDTH ?? 1600)
const WINDOW_HEIGHT = Number(process.env.FLOW_READER_PERF_WINDOW_HEIGHT ?? 1000)
const SKIP_WINDOW_RESIZE = process.env.FLOW_READER_PERF_SKIP_WINDOW_RESIZE === '1'
const REQUIRE_WINDOW_RESIZE = process.env.FLOW_READER_PERF_REQUIRE_WINDOW_RESIZE === '1'
const INCLUDE_TEXT_PREFIX = process.env.FLOW_READER_PERF_INCLUDE_TEXT_PREFIX === '1'
const HEADLESS_BROWSER = process.env.FLOW_READER_PERF_HEADLESS === '1'
const BROWSER_CHANNEL =
  process.env.FLOW_READER_PERF_BROWSER_CHANNEL ?? (process.platform === 'win32' ? 'msedge' : 'chrome')
const BOOK_CHAPTERS = Number(process.env.FLOW_READER_PERF_BOOK_CHAPTERS ?? 120)
const BOOK_PARAGRAPHS = Number(process.env.FLOW_READER_PERF_BOOK_PARAGRAPHS ?? 20)
const SCENARIO_FILTERS = (process.env.FLOW_READER_PERF_SCENARIOS ?? '')
  .split(',')
  .map((filter) => filter.trim())
  .filter(Boolean)
const PERF_MODE = resolvePerfMode(process.env.FLOW_READER_PERF_MODE)
const BOOK_SOURCE = process.env.FLOW_READER_PERF_BOOK_SOURCE ?? (PERF_MODE === 'browser' ? 'mock' : 'native')
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function resolvePerfMode(value) {
  const mode = String(value || 'auto').toLowerCase()
  if (mode === 'auto') return process.platform === 'win32' ? 'tauri' : 'browser'
  if (mode === 'tauri' || mode === 'browser') return mode
  fail(`unsupported FLOW_READER_PERF_MODE "${value}"; use auto, tauri, or browser`)
}

function fail(message, detail) {
  const error = new Error(message)
  error.detail = detail
  throw error
}

function assert(condition, message, detail) {
  if (!condition) fail(message, detail)
}

function powershell(command) {
  return execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function setFlowWindowBoundsWin32(width, height, x = 40, y = 40) {
  powershell(`
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class FlowPerfWin32 {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
}
"@
$p = Get-Process -Name 'flow-reader','Flow Reader' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Sort-Object StartTime -Descending | Select-Object -First 1
if (-not $p) { throw 'Flow Reader process not found' }
$h = $p.MainWindowHandle
if ($h -eq 0) { throw 'flow-reader MainWindowHandle is 0' }
[FlowPerfWin32]::ShowWindow($h, 9) | Out-Null
Start-Sleep -Milliseconds 100
[FlowPerfWin32]::SetWindowPos($h, [IntPtr]::Zero, ${x}, ${y}, ${width}, ${height}, 0x0040) | Out-Null
`)
}

async function setCdpWindowBounds(target, width, height, x = 40, y = 40) {
  let session
  try {
    session = await target.page.context().newCDPSession(target.page)
    const { windowId } = await session.send('Browser.getWindowForTarget')
    await session.send('Browser.setWindowBounds', {
      windowId,
      bounds: { windowState: 'normal' },
    })
    await session.send('Browser.setWindowBounds', {
      windowId,
      bounds: { left: x, top: y, width, height },
    })
    return { ok: true, method: 'cdp-browser-window-bounds' }
  } catch (error) {
    return { ok: false, reason: error?.message || String(error) }
  } finally {
    await session?.detach().catch(() => {})
  }
}

function windowBoundsMatch(metrics, width, height) {
  return Math.abs(metrics.outerWidth - width) <= 8 && Math.abs(metrics.outerHeight - height) <= 8
}

async function applyWindowBounds(target) {
  if (SKIP_WINDOW_RESIZE) {
    return {
      method: 'skipped',
      reason: 'FLOW_READER_PERF_SKIP_WINDOW_RESIZE=1',
    }
  }

  if (target.mode === 'browser') {
    await target.page.setViewportSize({
      width: WINDOW_WIDTH,
      height: WINDOW_HEIGHT,
    })
    return { method: 'playwright-viewport' }
  }

  if (process.platform === 'win32') {
    setFlowWindowBoundsWin32(WINDOW_WIDTH, WINDOW_HEIGHT)
    return { method: 'win32-user32' }
  }

  const cdpResize = await setCdpWindowBounds(target, WINDOW_WIDTH, WINDOW_HEIGHT)
  if (cdpResize.ok) {
    await wait(150)
    const metrics = await readWindowMetrics(target.page)
    if (windowBoundsMatch(metrics, WINDOW_WIDTH, WINDOW_HEIGHT)) {
      return { method: cdpResize.method }
    }
  }

  const reason = `real Tauri window resizing could not be controlled through CDP: ${cdpResize.reason}`
  if (REQUIRE_WINDOW_RESIZE) fail(`failed to resize client window: ${reason}`)
  return { method: 'skipped', reason }
}

async function readWindowMetrics(page) {
  return page.evaluate(() => ({
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    outerWidth: window.outerWidth,
    outerHeight: window.outerHeight,
    devicePixelRatio: window.devicePixelRatio,
  }))
}

function makeBook(filePath, title, prefix, chapterCount, paragraphs) {
  const parts = [title, '']
  for (let i = 1; i <= chapterCount; i += 1) {
    parts.push(`第${i}章 ${prefix} CHAPTER ${i}`)
    for (let p = 0; p < paragraphs; p += 1) {
      parts.push(
        `${prefix}-${String(i).padStart(3, '0')}-${String(p).padStart(
          2,
          '0',
        )} ${title} ${prefix} 性能测量正文段落，用于真实客户端多标签切换和翻页响应时间量化。`.repeat(4),
      )
    }
    parts.push('')
  }
  fs.writeFileSync(filePath, parts.join('\n'), 'utf8')
}

function createPerfBrowserBooks() {
  return ['A', 'B', 'C'].map((name, index) => {
    const prefix = `PERF_${name}`
    const title = `FLOW_PERF_${name}`
    return {
      id: `flow-perf-${name.toLowerCase()}`,
      name: `${title}.epub`,
      size: BOOK_CHAPTERS * BOOK_PARAGRAPHS * 512,
      metadata: {
        title,
        creator: 'Flow Performance',
        language: 'en-US',
      },
      createdAt: 1 + index,
      updatedAt: 1 + index,
      cfi: 'chapter_001.xhtml',
      definitions: [],
      annotations: [],
      stateLoaded: true,
      packageUrl: `/flow-perf/${name}/OPS/package.opf`,
      perfPrefix: prefix,
      perfTitle: title,
    }
  })
}

function perfBookResource(pathname, book) {
  const base = `/flow-perf/${book.id.replace('flow-perf-', '').toUpperCase()}/OPS/`
  const normalized = pathname.startsWith(base)
    ? pathname.slice(base.length)
    : pathname.replace(/^\/flow-perf\/[^/]+\/OPS\//, '')
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
    <dc:title>${book.perfTitle}</dc:title>
    <dc:creator>Flow Performance</dc:creator>
    <dc:language>en-US</dc:language>
    <meta property="dcterms:modified">2026-06-29T00:00:00Z</meta>
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
    const items = Array.from({ length: BOOK_CHAPTERS }, (_, index) => {
      const number = String(index + 1).padStart(3, '0')
      return `<li><a href="chapter_${number}.xhtml">${book.perfPrefix}-CHAPTER-${number}</a></li>`
    }).join('\n')

    return {
      contentType: 'application/xhtml+xml',
      body: `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
  <head><title>${book.perfTitle}</title></head>
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
    const padded = String(number).padStart(3, '0')
    const title = `${book.perfPrefix}-CHAPTER-${padded}`
    const paragraphs = Array.from({ length: BOOK_PARAGRAPHS }, (_, index) => {
      const marker = `${book.perfPrefix}-${padded}-${String(index).padStart(2, '0')}`
      return `<p>${marker} ${book.perfTitle} deterministic reader performance paragraph for cross-platform browser measurement. This text is repeated to create stable columns, page turns, and tab switching load. ${marker} ${marker} ${marker}</p>`
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

async function installPerfBookRoutes(page, books) {
  await page.route('**/flow-perf/**', (route) => {
    const pathname = new URL(route.request().url()).pathname
    const book = books.find((candidate) =>
      pathname.startsWith(`/flow-perf/${candidate.id.replace('flow-perf-', '').toUpperCase()}/`),
    )
    const resource = book ? perfBookResource(pathname, book) : undefined

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

async function installBrowserTauriMock(page, books) {
  await page.addInitScript((fixtureBooks) => {
    const globalWindow = window
    const bookStore = new Map(fixtureBooks.map((book) => [book.id, book]))
    const settingsStore = { locale: 'en-US' }
    let nextCallbackId = 1
    let nextEventId = 1

    const internals = (globalWindow.__TAURI_INTERNALS__ ??= {})
    const eventInternals = (globalWindow.__TAURI_EVENT_PLUGIN_INTERNALS__ ??= {})
    const callbacks = (internals.callbacks ??= {})

    globalWindow.__FLOW_PERF_TAURI__ = { settingsStore }
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
    internals.invoke = async (command, args = {}) => {
      if (command === 'get_settings') return { ...settingsStore }
      if (command === 'update_settings') {
        Object.assign(settingsStore, args.settings ?? {})
        return null
      }
      if (command === 'list_books') return Array.from(bookStore.values())
      if (command === 'get_book') return bookStore.get(String(args.id)) ?? null
      if (command === 'update_book') {
        const id = String(args.id)
        const current = bookStore.get(id)
        if (!current) return null
        const updated = { ...current, ...(args.changes ?? {}) }
        bookStore.set(id, updated)
        return updated
      }
      if (command === 'import_text_paths') return Array.from(bookStore.values())
      if (command === 'list_covers') return []
      if (command === 'get_cover') return null
      if (command === 'get_book_package_path') {
        return bookStore.get(String(args.id))?.packageUrl ?? ''
      }
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
  }, books)
}

async function installRuntimePerfBookMock(page, books) {
  await page.evaluate((fixtureBooks) => {
    const globalWindow = window
    const internals = (globalWindow.__TAURI_INTERNALS__ ??= {})
    const originalInvoke = internals.invoke?.bind(internals)
    const bookStore = new Map(fixtureBooks.map((book) => [book.id, book]))

    internals.invoke = async (command, args = {}) => {
      if (command === 'list_books') return Array.from(bookStore.values())
      if (command === 'get_book') return bookStore.get(String(args.id)) ?? null
      if (command === 'update_book') {
        const id = String(args.id)
        const current = bookStore.get(id)
        if (!current) return null
        const updated = { ...current, ...(args.changes ?? {}) }
        bookStore.set(id, updated)
        return updated
      }
      if (command === 'import_text_paths') return Array.from(bookStore.values())
      if (command === 'list_covers') return []
      if (command === 'get_cover') return null
      if (command === 'get_book_package_path') {
        return bookStore.get(String(args.id))?.packageUrl ?? ''
      }
      if (command === 'search_book_text') return []
      if (command === 'unload_book_search_text') return null
      return originalInvoke?.(command, args) ?? null
    }
  }, books)
}

async function createPerfTarget() {
  if (PERF_MODE === 'tauri') {
    const browser = await chromium.connectOverCDP(CDP_URL)
    const context = browser.contexts()[0]
    const page = context.pages().find((candidate) => candidate.url().includes('localhost:7127')) || context.pages()[0]

    if (BOOK_SOURCE === 'mock') {
      const books = createPerfBrowserBooks()
      await installPerfBookRoutes(page, books)
      await installRuntimePerfBookMock(page, books)
      return { browser, context, page, mode: 'tauri', appUrl: CDP_URL, books }
    }

    return { browser, context, page, mode: 'tauri', appUrl: CDP_URL }
  }

  const books = createPerfBrowserBooks()
  const browser = await chromium.launch({
    channel: BROWSER_CHANNEL,
    headless: HEADLESS_BROWSER,
    args: [`--window-size=${WINDOW_WIDTH},${WINDOW_HEIGHT}`],
  })
  const context = await browser.newContext({
    viewport: { width: WINDOW_WIDTH, height: WINDOW_HEIGHT },
    deviceScaleFactor: 1,
  })
  const page = await context.newPage()
  await installPerfBookRoutes(page, books)
  await installBrowserTauriMock(page, books)
  await page.goto(APP_URL)

  return { browser, context, page, mode: 'browser', appUrl: APP_URL, books }
}

async function invoke(page, command, args) {
  return page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args })
}

async function ensureReaderMode(page) {
  for (let i = 0; i < 3; i += 1) {
    const libraryOverlay = await page.evaluate(
      () => !!document.querySelector('.absolute.inset-0.z-10.min-h-0.overflow-hidden.flow-bg-content'),
    )
    if (!libraryOverlay) return
    await page.keyboard.press('c')
    await wait(700)
  }
  assert(
    !(await page.evaluate(
      () => !!document.querySelector('.absolute.inset-0.z-10.min-h-0.overflow-hidden.flow-bg-content'),
    )),
    'failed to enter reader mode',
  )
}

async function isSidebarVisible(page) {
  return page.evaluate(() => {
    const sidebar = document.querySelector('.SideBar')
    if (!sidebar) return false
    const rect = sidebar.getBoundingClientRect()
    const style = getComputedStyle(sidebar)
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 10 && rect.height > 10
  })
}

async function clickActivityButton(page, names) {
  return page.evaluate((names) => {
    const expected = new Set(names)
    const button = Array.from(document.querySelectorAll('button')).find((el) =>
      expected.has(el.getAttribute('aria-label') || ''),
    )
    button?.click()
    return !!button
  }, names)
}

async function ensureSidebar(page, visible, panel = 'toc') {
  await ensureReaderMode(page)
  const panelLabels = {
    toc: ['目录', 'TOC'],
    search: ['搜索', 'Search'],
    annotation: ['标注', 'Annotation', 'Annotations'],
    image: ['图片', 'Image', 'Images'],
    typography: ['排版', 'Typography'],
  }
  const labels = panelLabels[panel] ?? panelLabels.toc

  for (let i = 0; i < 5; i += 1) {
    const currentlyVisible = await isSidebarVisible(page)
    if (currentlyVisible === visible) {
      if (!visible) return
      const clicked = await clickActivityButton(page, labels)
      assert(clicked, `${panel} sidebar button not found`)
      await wait(200)
      if (await isSidebarVisible(page)) return
      const reopened = await clickActivityButton(page, labels)
      assert(reopened, `${panel} sidebar button not found`)
      await waitForSettled(page, `sidebar ${panel} reopened`)
      return
    }
    const clicked = await clickActivityButton(page, labels)
    assert(clicked, `${panel} sidebar button not found`)
    await waitForSettled(page, `sidebar ${panel} ${visible ? 'open' : 'closed'}`)
  }

  assert((await isSidebarVisible(page)) === visible, `sidebar did not become ${visible ? 'open' : 'closed'}`)
}

async function readState(page) {
  return page.evaluate((includeTextPrefix) => {
    const normalize = (text) =>
      String(text ?? '')
        .replace(/\s+/g, ' ')
        .trim()
    const part = (p) =>
      p
        ? {
            index: p.index,
            href: p.href,
            cfi: p.cfi,
            page: p.displayed?.page,
            total: p.displayed?.total,
            slot: p.displayed?.slot,
          }
        : null
    const loc = (location) =>
      location
        ? {
            start: part(location.start),
            end: part(location.end),
            atStart: !!location.atStart,
            atEnd: !!location.atEnd,
          }
        : null
    const rectOf = (el) => {
      const rect = el?.getBoundingClientRect?.()
      if (!rect) return null
      return {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      }
    }
    const panes = Array.from(document.querySelectorAll('[data-flow-reader-pane]')).map((pane) => {
      const style = getComputedStyle(pane)
      const frames = Array.from(pane.querySelectorAll('iframe')).map((iframe) => {
        let text = ''
        let location = ''
        let readyState = ''
        let headings = []
        try {
          const doc = iframe.contentDocument
          text = doc?.body?.textContent || ''
          location = iframe.contentWindow?.location?.href || ''
          readyState = doc?.readyState || ''
          headings = Array.from(doc?.querySelectorAll('h1,h2,h3,[epub\\:type~="title"]') || [])
            .map((heading) => normalize(heading.textContent).slice(0, 120))
            .filter(Boolean)
            .slice(0, 4)
        } catch {}
        return {
          rect: rectOf(iframe),
          location,
          readyState,
          textLength: normalize(text).length,
          textPrefix: includeTextPrefix ? normalize(text).slice(0, 180) : undefined,
          headings,
        }
      })
      return {
        hidden: pane.getAttribute('aria-hidden') === 'true',
        opacity: style.opacity,
        visibility: style.visibility,
        rect: rectOf(pane),
        frames,
      }
    })
    const group = window.reader?.focusedGroup
    const selectedIndex = group?.selectedIndex ?? -1
    const tabs = (group?.tabs || []).map((tab, index) => ({
      index,
      id: tab.id,
      title: tab.title,
      active: !!tab.active,
      turning: !!tab.turning,
      visibleSectionIndexes: [...(tab.visibleSectionIndexes || [])],
      currentLocation: loc(tab.currentLocation),
      pagination: tab.paginationSnapshot
        ? {
            location: loc(tab.paginationSnapshot.location),
            percentage: tab.paginationSnapshot.percentage,
            spreadDivisor: tab.paginationSnapshot.spreadDivisor,
            headerPath: tab.paginationSnapshot.headerPath?.map((item) => item.label) || [],
            visibleSectionIndexes: [...(tab.paginationSnapshot.visibleSectionIndexes || [])],
          }
        : null,
    }))
    const activePane = panes.find((pane) => !pane.hidden)
    const activeTab = tabs[selectedIndex]
    return {
      selectedIndex,
      tabCount: tabs.length,
      activeTab,
      activePane,
      activeFrameCount: activePane?.frames.length || 0,
      activeFrameHeadings: (activePane?.frames || []).flatMap((frame) => frame.headings || []),
      activeFrameText: includeTextPrefix ? (activePane?.frames || []).map((frame) => frame.textPrefix).join('\n') : '',
      sidebarVisible: (() => {
        const sidebar = document.querySelector('.SideBar')
        if (!sidebar) return false
        const rect = sidebar.getBoundingClientRect()
        const style = getComputedStyle(sidebar)
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 10 && rect.height > 10
      })(),
    }
  }, INCLUDE_TEXT_PREFIX)
}

async function readFastInteractionState(page) {
  return page.evaluate(() => {
    const rectOf = (el) => {
      const rect = el?.getBoundingClientRect?.()
      if (!rect) return null
      return {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      }
    }
    const panes = Array.from(document.querySelectorAll('[data-flow-reader-pane]')).map((pane) => {
      const style = getComputedStyle(pane)
      return {
        hidden: pane.getAttribute('aria-hidden') === 'true',
        opacity: style.opacity,
        visibility: style.visibility,
        rect: rectOf(pane),
        frameCount: pane.querySelectorAll('iframe').length,
      }
    })
    const group = window.reader?.focusedGroup
    const selectedIndex = group?.selectedIndex ?? -1
    const activePane = panes.find((pane) => !pane.hidden)

    return {
      selectedIndex,
      activePane,
      activeTab: group?.tabs?.[selectedIndex]
        ? {
            turning: !!group.tabs[selectedIndex].turning,
          }
        : null,
    }
  })
}

function assertRenderAligned(state, label) {
  assert(state.tabCount > 0, `${label}: no tabs`)
  assert(state.activeTab, `${label}: no active tab`)
  assert(state.activePane, `${label}: no active pane`)
  assert(
    state.activePane.opacity === '1' && state.activePane.visibility === 'visible',
    `${label}: active pane is not visible`,
    state.activePane,
  )
  assert(state.activeFrameCount > 0, `${label}: no active iframe body`)
  assert(state.activeFrameCount <= 2, `${label}: active spread has more than two frames`, state.activePane)
  assert(
    state.activePane.frames.every((frame) => frame.textLength > 0),
    `${label}: blank iframe body`,
    state.activePane,
  )
  const pagination = state.activeTab.pagination
  assert(pagination, `${label}: missing pagination snapshot`, state.activeTab)
  assert(
    JSON.stringify(pagination.visibleSectionIndexes) === JSON.stringify(state.activeTab.visibleSectionIndexes),
    `${label}: visible sections diverge`,
    { pagination, visible: state.activeTab.visibleSectionIndexes },
  )
  const headers = pagination.headerPath.filter(Boolean)
  assert(headers.length > 0, `${label}: empty header path`, pagination)
  if (INCLUDE_TEXT_PREFIX) {
    assert(
      headers.some((header) => state.activeFrameText.includes(header)) ||
        state.activeFrameText.includes(state.activeTab.title),
      `${label}: header does not match body`,
      {
        headers,
        bodyText: state.activeFrameText,
      },
    )
  }
}

function assertFastInteractionVisible(state, label) {
  assert(state.activeTab, `${label}: no active tab`)
  assert(state.activePane, `${label}: no active pane`)
  assert(
    state.activePane.opacity === '1' && state.activePane.visibility === 'visible',
    `${label}: active pane is not visible`,
    state.activePane,
  )
  assert(state.activePane.frameCount > 0, `${label}: no active iframe`)
}

function activeRenderSignature(state) {
  return JSON.stringify({
    selectedIndex: state.selectedIndex,
    location: state.activeTab?.pagination?.location,
    percentage: state.activeTab?.pagination?.percentage,
    visibleSectionIndexes: state.activeTab?.pagination?.visibleSectionIndexes,
    frames: state.activePane?.frames?.map((frame) => ({
      rect: frame.rect,
      location: frame.location,
      readyState: frame.readyState,
      textLength: frame.textLength,
      headings: frame.headings,
    })),
  })
}

async function waitForSettled(page, label, timeout = 30000) {
  const start = Date.now()
  let last = ''
  let stable = 0
  let lastState
  let polls = 0

  while (Date.now() - start < timeout) {
    polls += 1
    const state = await readState(page)
    lastState = state
    try {
      assertRenderAligned(state, label)
    } catch {
      await wait(80)
      continue
    }
    const signature = activeRenderSignature(state)
    stable = signature === last && !state.activeTab.turning ? stable + 1 : 0
    last = signature
    if (stable >= 2) {
      state.__settled = {
        elapsedMs: Date.now() - start,
        polls,
      }
      return state
    }
    await wait(80)
  }

  fail(`${label}: did not settle`, lastState)
}

async function waitForAllTabsReady(page, label, timeout = 30000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const state = await readState(page)
    const allReady =
      state.tabCount > 0 &&
      (await page.evaluate(() =>
        (window.reader?.focusedGroup?.tabs || []).every((tab) => tab.paginationSnapshot && !tab.turning),
      ))
    if (allReady) return state
    await wait(100)
  }
  fail(`${label}: tabs did not become ready`)
}

async function installPerfInstrumentation(page) {
  await page.evaluate((diagnosticsEnabled) => {
    window.__flowPerf = {
      counters: {},
      diagnostics: {
        enabled: diagnosticsEnabled,
        mutations: {},
        scrollEvents: {},
        scrollToCalls: [],
      },
      longtasks: [],
      marks: [],
      mutationObservers: [],
      wrapped: new WeakSet(),
    }

    if (!window.__flowPerfLongTaskObserver) {
      try {
        window.__flowPerfLongTaskObserver = new PerformanceObserver((list) => {
          const perf = window.__flowPerf
          if (!perf) return
          list.getEntries().forEach((entry) => {
            perf.longtasks.push({
              duration: entry.duration,
              name: entry.name,
              startTime: entry.startTime,
            })
          })
        })
        window.__flowPerfLongTaskObserver.observe({ entryTypes: ['longtask'] })
      } catch {}
    }

    const methods = ['display', 'next', 'prev', 'resizeRendition', 'relayoutCurrentView']

    const classifyElement = (node) => {
      if (!(node instanceof Element)) return 'unknown'
      if (node.closest('[data-flow-reader-pane]')) return 'reader-pane'
      if (node.closest('.SideBar')) return 'sidebar'
      if (node.closest('.Reader')) return 'reader'
      return 'document'
    }

    const classifyElementDetail = (node) => {
      if (!(node instanceof Element)) return 'unknown'
      if (node.matches('iframe')) return 'iframe'
      if (node.closest('[data-radix-popper-content-wrapper]')) {
        return 'tooltip-content'
      }
      if (node.matches('.list-row')) return 'list-row'
      if (node.closest('.list-row')) return 'list-row-child'
      if (node.matches('svg') || node.closest('svg')) return 'icon'
      if (node.matches('button') || node.closest('button')) return 'button'
      if (node.matches('.Pane')) return 'pane'
      if (node.closest('.Pane')) return 'pane-child'
      if (node.closest('[data-flow-reader-pane]')) return 'reader-pane-child'
      if (node.closest('.SideBar')) return 'sidebar-child'
      if (node.closest('.Reader')) return 'reader-child'
      return node.localName || 'element'
    }

    const incrementDiagnostic = (bucket, key, amount = 1) => {
      const diagnostics = window.__flowPerf?.diagnostics
      if (!diagnostics?.enabled) return
      diagnostics[bucket][key] = (diagnostics[bucket][key] || 0) + amount
    }

    const installDomDiagnostics = () => {
      const perf = window.__flowPerf
      if (!perf?.diagnostics.enabled || perf.domDiagnosticsInstalled) return
      perf.domDiagnosticsInstalled = true

      const observe = (target, name) => {
        if (!target) return
        const observer = new MutationObserver((mutations) => {
          mutations.forEach((mutation) => {
            const targetKey = name === 'document' ? classifyElement(mutation.target) : name
            const detailKey = `${targetKey}:${classifyElementDetail(mutation.target)}`
            incrementDiagnostic('mutations', `${targetKey}:records`)
            incrementDiagnostic('mutations', `${detailKey}:records`)
            if (mutation.type === 'attributes') {
              incrementDiagnostic('mutations', `${targetKey}:attributes`)
              incrementDiagnostic('mutations', `${detailKey}:attributes`)
              incrementDiagnostic('mutations', `${detailKey}:attr:${mutation.attributeName || 'unknown'}`)
            }
            if (mutation.type === 'childList') {
              incrementDiagnostic('mutations', `${targetKey}:added`, mutation.addedNodes.length)
              mutation.addedNodes.forEach((node) => {
                incrementDiagnostic('mutations', `${targetKey}:${classifyElementDetail(node)}:added`)
              })
              incrementDiagnostic('mutations', `${targetKey}:removed`, mutation.removedNodes.length)
              mutation.removedNodes.forEach((node) => {
                incrementDiagnostic('mutations', `${targetKey}:${classifyElementDetail(node)}:removed`)
              })
            }
          })
        })
        observer.observe(target, {
          attributes: true,
          childList: true,
          subtree: true,
        })
        perf.mutationObservers.push(observer)
      }

      observe(document.querySelector('.SideBar'), 'sidebar')
      observe(document.querySelector('.Reader'), 'reader')
      observe(document.body, 'document')

      document.addEventListener(
        'scroll',
        (event) => {
          incrementDiagnostic('scrollEvents', classifyElement(event.target))
        },
        { capture: true, passive: true },
      )

      const originalElementScrollTo = Element.prototype.scrollTo
      if (originalElementScrollTo && !Element.prototype.__flowPerfScrollTo) {
        Object.defineProperty(Element.prototype, '__flowPerfScrollTo', {
          value: originalElementScrollTo,
        })
        Element.prototype.scrollTo = function (...args) {
          const diagnostics = window.__flowPerf?.diagnostics
          if (diagnostics?.enabled) {
            diagnostics.scrollToCalls.push({
              target: classifyElement(this),
              args: args.map((arg) =>
                arg && typeof arg === 'object'
                  ? {
                      behavior: arg.behavior,
                      left: arg.left,
                      top: arg.top,
                    }
                  : arg,
              ),
            })
          }
          return originalElementScrollTo.apply(this, args)
        }
      }
    }

    window.__flowPerfWrap = () => {
      const group = window.reader?.focusedGroup
      ;(group?.tabs || []).forEach((tab) => {
        if (window.__flowPerf.wrapped.has(tab)) return
        window.__flowPerf.wrapped.add(tab)
        window.__flowPerf.counters[tab.id] ||= {}
        methods.forEach((method) => {
          if (typeof tab[method] !== 'function') return
          const original = tab[method].bind(tab)
          tab[method] = (...args) => {
            const counter = window.__flowPerf.counters[tab.id]
            counter[method] = (counter[method] || 0) + 1
            return original(...args)
          }
        })
      })
    }

    window.__flowPerfReset = () => {
      window.__flowPerfWrap()
      installDomDiagnostics()
      window.__flowPerf.longtasks = []
      window.__flowPerf.diagnostics.mutations = {}
      window.__flowPerf.diagnostics.scrollEvents = {}
      window.__flowPerf.diagnostics.scrollToCalls = []
      Object.values(window.__flowPerf.counters).forEach((counter) => {
        methods.forEach((method) => {
          counter[method] = 0
        })
      })
    }

    window.__flowPerfRead = () =>
      structuredClone({
        counters: window.__flowPerf.counters,
        diagnostics: window.__flowPerf.diagnostics,
        longtasks: window.__flowPerf.longtasks,
      })

    window.__flowPerfWrap()
  }, DIAGNOSTICS)
}

async function resetPerf(page) {
  await page.evaluate(() => window.__flowPerfReset?.())
}

async function readPerf(page) {
  return page.evaluate(() => window.__flowPerfRead?.() || {})
}

function sumCounters(counters) {
  const sums = {
    display: 0,
    next: 0,
    prev: 0,
    resizeRendition: 0,
    relayoutCurrentView: 0,
  }
  Object.values(counters || {}).forEach((counter) => {
    Object.keys(sums).forEach((method) => {
      sums[method] += counter[method] || 0
    })
  })
  return sums
}

async function navigateTabTo(page, tabIndex, sectionIndex, nextCount = 0) {
  await page.evaluate(
    async ({ tabIndex, sectionIndex, nextCount }) => {
      const group = window.reader.focusedGroup
      group.selectTab(tabIndex)
      const tab = group.tabs[tabIndex]
      const deadline = Date.now() + 30000
      while (!tab.sections?.[sectionIndex] && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      const section = tab.sections?.[sectionIndex]
      if (!section) throw new Error(`section ${sectionIndex} missing`)
      await tab.displaySectionStart(section)
      for (let i = 0; i < nextCount; i += 1) await tab.next()
    },
    { tabIndex, sectionIndex, nextCount },
  )
  await waitForSettled(page, `navigate tab ${tabIndex}`)
}

function normalizeOperation(operation) {
  return typeof operation === 'function' ? { run: operation } : operation
}

async function measureOperation(page, label, operation) {
  const { name: operationName, run, expectedSelectedIndex } = normalizeOperation(operation)
  await waitForSettled(page, `${label} before`)
  await resetPerf(page)
  const start = await page.evaluate(() => performance.now())
  await run()
  const operationEnd = await page.evaluate(() => performance.now())
  const frame = await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => resolve(performance.now()))),
  )
  const immediate = await readState(page)
  if (typeof expectedSelectedIndex === 'number' && immediate.selectedIndex !== expectedSelectedIndex) {
    fail(`${label}: operation did not select expected tab`, {
      expectedSelectedIndex,
      state: immediate,
    })
  }
  const settledState = await waitForSettled(page, `${label} settled`)
  if (typeof expectedSelectedIndex === 'number' && settledState.selectedIndex !== expectedSelectedIndex) {
    fail(`${label}: settled on unexpected tab`, {
      expectedSelectedIndex,
      state: settledState,
    })
  }
  const settled = await page.evaluate(() => performance.now())
  const perf = await readPerf(page)
  const longtasks = perf.longtasks || []

  return {
    label,
    operationName,
    selectedIndex: immediate.selectedIndex,
    operationMs: operationEnd - start,
    firstFrameMs: frame - start,
    frameDelayMs: frame - operationEnd,
    settledMs: settled - start,
    postOperationSettleMs: settled - operationEnd,
    settlePolls: settledState.__settled?.polls,
    longTaskCount: longtasks.length,
    longTaskTotalMs: longtasks.reduce((sum, entry) => sum + entry.duration, 0),
    longTaskMaxMs: longtasks.reduce((max, entry) => Math.max(max, entry.duration), 0),
    counters: sumCounters(perf.counters),
    diagnostics: perf.diagnostics?.enabled ? summarizeDiagnostics(perf.diagnostics) : undefined,
  }
}

function summarizeDiagnostics(diagnostics) {
  if (!diagnostics?.enabled) return

  const scrollToCalls = diagnostics.scrollToCalls || []
  const scrollToByTarget = scrollToCalls.reduce((acc, call) => {
    acc[call.target] = (acc[call.target] || 0) + 1
    return acc
  }, {})

  return {
    mutations: diagnostics.mutations || {},
    scrollEvents: diagnostics.scrollEvents || {},
    scrollToByTarget,
    scrollToCalls: scrollToCalls.slice(0, 20),
  }
}

function cpuProfileNodeLabel(node) {
  const frame = node.callFrame ?? {}
  const fn = frame.functionName || '(anonymous)'
  const url = frame.url || '(unknown)'
  const line = typeof frame.lineNumber === 'number' ? frame.lineNumber + 1 : 0
  const column = typeof frame.columnNumber === 'number' ? frame.columnNumber + 1 : 0
  return `${fn} @ ${url}:${line}:${column}`
}

function summarizeCpuProfile(profile, limit = 30) {
  const nodesById = new Map((profile.nodes ?? []).map((node) => [node.id, node]))
  const selfTimeById = new Map()
  const samples = profile.samples ?? []
  const timeDeltas = profile.timeDeltas ?? []

  samples.forEach((nodeId, index) => {
    const deltaMs = (timeDeltas[index] ?? 0) / 1000
    selfTimeById.set(nodeId, (selfTimeById.get(nodeId) ?? 0) + deltaMs)
  })

  const totalMs = [...selfTimeById.values()].reduce((sum, time) => sum + time, 0)

  const topSelfTime = [...selfTimeById.entries()]
    .flatMap(([nodeId, selfMs]) => {
      const node = nodesById.get(nodeId)
      if (!node || selfMs <= 0) return []

      return [
        {
          selfMs,
          percent: totalMs ? (selfMs / totalMs) * 100 : 0,
          hitCount: node.hitCount ?? 0,
          callFrame: node.callFrame,
          label: cpuProfileNodeLabel(node),
        },
      ]
    })
    .sort((a, b) => b.selfMs - a.selfMs)
    .slice(0, limit)

  return {
    totalMs,
    samples: samples.length,
    topSelfTime,
  }
}

async function profileOperation(page, label, operation) {
  const { run } = normalizeOperation(operation)
  await waitForSettled(page, `${label} profile before`)
  await resetPerf(page)

  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Profiler.enable')
  await cdp.send('Profiler.start')

  const start = await page.evaluate(() => performance.now())
  await run()
  const frame = await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => resolve(performance.now()))),
  )
  const immediate = await readState(page)
  await waitForSettled(page, `${label} profile settled`)
  const settled = await page.evaluate(() => performance.now())
  const { profile } = await cdp.send('Profiler.stop')
  await cdp.detach()

  const perf = await readPerf(page)
  const longtasks = perf.longtasks || []

  return {
    label,
    selectedIndex: immediate.selectedIndex,
    firstFrameMs: frame - start,
    settledMs: settled - start,
    longTaskCount: longtasks.length,
    longTaskTotalMs: longtasks.reduce((sum, entry) => sum + entry.duration, 0),
    longTaskMaxMs: longtasks.reduce((max, entry) => Math.max(max, entry.duration), 0),
    counters: sumCounters(perf.counters),
    cpu: summarizeCpuProfile(profile),
  }
}

function percentile(values, p) {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[index]
}

function summarizeSamples(samples) {
  if (!samples.length) return

  const metric = (key) => samples.map((sample) => sample[key])
  const sum = (values) => values.reduce((total, value) => total + value, 0)
  const operation = metric('operationMs')
  const firstFrame = metric('firstFrameMs')
  const frameDelay = metric('frameDelayMs')
  const settled = metric('settledMs')
  const postOperationSettle = metric('postOperationSettleMs')
  const settlePolls = metric('settlePolls')
  const counters = samples.reduce((acc, sample) => {
    Object.entries(sample.counters).forEach(([key, value]) => {
      acc[key] = (acc[key] || 0) + value
    })
    return acc
  }, {})

  return {
    runs: samples.length,
    operationMs: {
      min: Math.min(...operation),
      p50: percentile(operation, 50),
      p95: percentile(operation, 95),
      max: Math.max(...operation),
      avg: sum(operation) / operation.length,
    },
    firstFrameMs: {
      min: Math.min(...firstFrame),
      p50: percentile(firstFrame, 50),
      p95: percentile(firstFrame, 95),
      max: Math.max(...firstFrame),
      avg: sum(firstFrame) / firstFrame.length,
    },
    frameDelayMs: {
      min: Math.min(...frameDelay),
      p50: percentile(frameDelay, 50),
      p95: percentile(frameDelay, 95),
      max: Math.max(...frameDelay),
      avg: sum(frameDelay) / frameDelay.length,
    },
    settledMs: {
      min: Math.min(...settled),
      p50: percentile(settled, 50),
      p95: percentile(settled, 95),
      max: Math.max(...settled),
      avg: sum(settled) / settled.length,
    },
    postOperationSettleMs: {
      min: Math.min(...postOperationSettle),
      p50: percentile(postOperationSettle, 50),
      p95: percentile(postOperationSettle, 95),
      max: Math.max(...postOperationSettle),
      avg: sum(postOperationSettle) / postOperationSettle.length,
    },
    settlePolls: {
      min: Math.min(...settlePolls),
      p50: percentile(settlePolls, 50),
      p95: percentile(settlePolls, 95),
      max: Math.max(...settlePolls),
      avg: sum(settlePolls) / settlePolls.length,
    },
    longTasks: {
      count: sum(samples.map((sample) => sample.longTaskCount)),
      totalMs: sum(samples.map((sample) => sample.longTaskTotalMs)),
      maxMs: Math.max(...samples.map((sample) => sample.longTaskMaxMs)),
    },
    counters,
    diagnostics: summarizeScenarioDiagnostics(samples),
  }
}

function summarizeScenarioDiagnostics(samples) {
  const aggregate = {
    mutations: {},
    scrollEvents: {},
    scrollToByTarget: {},
  }
  let enabled = false

  samples.forEach((sample) => {
    const diagnostics = sample.diagnostics
    if (!diagnostics) return
    enabled = true
    ;['mutations', 'scrollEvents', 'scrollToByTarget'].forEach((bucket) => {
      Object.entries(diagnostics[bucket] || {}).forEach(([key, value]) => {
        aggregate[bucket][key] = (aggregate[bucket][key] || 0) + value
      })
    })
  })

  return enabled ? aggregate : undefined
}

async function measureScenario(page, name, operations) {
  const samples = []
  for (let i = 0; i < RUNS; i += 1) {
    const operation = operations[i % operations.length]
    samples.push(await measureOperation(page, `${name} #${i + 1}`, operation))
  }
  const steadySamples = samples.length > STEADY_SKIP ? samples.slice(STEADY_SKIP) : samples
  return {
    name,
    summary: summarizeSamples(samples),
    steadySummary: summarizeSamples(steadySamples),
    steadySkip: samples.length - steadySamples.length,
    samples,
  }
}

async function measureBurstOperation(page, label, operations, options = {}) {
  const { assertEachFrameVisible = false } = options
  await waitForSettled(page, `${label} before`)
  await resetPerf(page)

  const start = await page.evaluate(() => performance.now())
  const steps = []

  for (let i = 0; i < operations.length; i += 1) {
    const operation = normalizeOperation(operations[i])
    const stepStart = await page.evaluate(() => performance.now())
    await operation.run()
    const operationEnd = await page.evaluate(() => performance.now())
    const frame = await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => resolve(performance.now()))),
    )
    const state = await readFastInteractionState(page)

    if (
      typeof operation.expectedSelectedIndex === 'number' &&
      state.selectedIndex !== operation.expectedSelectedIndex
    ) {
      fail(`${label}: burst step selected unexpected tab`, {
        step: i + 1,
        operationName: operation.name,
        expectedSelectedIndex: operation.expectedSelectedIndex,
        state,
      })
    }

    if (assertEachFrameVisible) {
      assertFastInteractionVisible(state, `${label} step ${i + 1}`)
    }

    steps.push({
      operationName: operation.name,
      selectedIndex: state.selectedIndex,
      operationMs: operationEnd - stepStart,
      firstFrameMs: frame - stepStart,
      frameDelayMs: frame - operationEnd,
    })
  }

  const burstEnd = await page.evaluate(() => performance.now())
  const settledState = await waitForSettled(page, `${label} settled`)
  const settled = await page.evaluate(() => performance.now())
  const perf = await readPerf(page)
  const longtasks = perf.longtasks || []

  return {
    label,
    stepCount: steps.length,
    burstMs: burstEnd - start,
    settledMs: settled - start,
    postBurstSettleMs: settled - burstEnd,
    settlePolls: settledState.__settled?.polls,
    maxStepOperationMs: Math.max(...steps.map((step) => step.operationMs)),
    avgStepOperationMs: steps.reduce((sum, step) => sum + step.operationMs, 0) / steps.length,
    maxStepFirstFrameMs: Math.max(...steps.map((step) => step.firstFrameMs)),
    avgStepFirstFrameMs: steps.reduce((sum, step) => sum + step.firstFrameMs, 0) / steps.length,
    longTaskCount: longtasks.length,
    longTaskTotalMs: longtasks.reduce((sum, entry) => sum + entry.duration, 0),
    longTaskMaxMs: longtasks.reduce((max, entry) => Math.max(max, entry.duration), 0),
    counters: sumCounters(perf.counters),
    diagnostics: perf.diagnostics?.enabled ? summarizeDiagnostics(perf.diagnostics) : undefined,
    steps,
  }
}

function summarizeBurstSamples(samples) {
  if (!samples.length) return

  const metric = (key) => samples.map((sample) => sample[key])
  const sum = (values) => values.reduce((total, value) => total + value, 0)
  const burst = metric('burstMs')
  const settled = metric('settledMs')
  const postBurstSettle = metric('postBurstSettleMs')
  const maxStepOperation = metric('maxStepOperationMs')
  const avgStepOperation = metric('avgStepOperationMs')
  const maxStepFirstFrame = metric('maxStepFirstFrameMs')
  const avgStepFirstFrame = metric('avgStepFirstFrameMs')
  const settlePolls = metric('settlePolls')
  const counters = samples.reduce((acc, sample) => {
    Object.entries(sample.counters).forEach(([key, value]) => {
      acc[key] = (acc[key] || 0) + value
    })
    return acc
  }, {})

  return {
    runs: samples.length,
    stepCount: samples[0]?.stepCount ?? 0,
    burstMs: {
      min: Math.min(...burst),
      p50: percentile(burst, 50),
      p95: percentile(burst, 95),
      max: Math.max(...burst),
      avg: sum(burst) / burst.length,
    },
    settledMs: {
      min: Math.min(...settled),
      p50: percentile(settled, 50),
      p95: percentile(settled, 95),
      max: Math.max(...settled),
      avg: sum(settled) / settled.length,
    },
    postBurstSettleMs: {
      min: Math.min(...postBurstSettle),
      p50: percentile(postBurstSettle, 50),
      p95: percentile(postBurstSettle, 95),
      max: Math.max(...postBurstSettle),
      avg: sum(postBurstSettle) / postBurstSettle.length,
    },
    maxStepOperationMs: {
      min: Math.min(...maxStepOperation),
      p50: percentile(maxStepOperation, 50),
      p95: percentile(maxStepOperation, 95),
      max: Math.max(...maxStepOperation),
      avg: sum(maxStepOperation) / maxStepOperation.length,
    },
    avgStepOperationMs: {
      min: Math.min(...avgStepOperation),
      p50: percentile(avgStepOperation, 50),
      p95: percentile(avgStepOperation, 95),
      max: Math.max(...avgStepOperation),
      avg: sum(avgStepOperation) / avgStepOperation.length,
    },
    maxStepFirstFrameMs: {
      min: Math.min(...maxStepFirstFrame),
      p50: percentile(maxStepFirstFrame, 50),
      p95: percentile(maxStepFirstFrame, 95),
      max: Math.max(...maxStepFirstFrame),
      avg: sum(maxStepFirstFrame) / maxStepFirstFrame.length,
    },
    avgStepFirstFrameMs: {
      min: Math.min(...avgStepFirstFrame),
      p50: percentile(avgStepFirstFrame, 50),
      p95: percentile(avgStepFirstFrame, 95),
      max: Math.max(...avgStepFirstFrame),
      avg: sum(avgStepFirstFrame) / avgStepFirstFrame.length,
    },
    settlePolls: {
      min: Math.min(...settlePolls),
      p50: percentile(settlePolls, 50),
      p95: percentile(settlePolls, 95),
      max: Math.max(...settlePolls),
      avg: sum(settlePolls) / settlePolls.length,
    },
    longTasks: {
      count: sum(samples.map((sample) => sample.longTaskCount)),
      totalMs: sum(samples.map((sample) => sample.longTaskTotalMs)),
      maxMs: Math.max(...samples.map((sample) => sample.longTaskMaxMs)),
    },
    counters,
    diagnostics: summarizeScenarioDiagnostics(samples),
  }
}

async function measureBurstScenario(page, name, operations, options = {}) {
  const samples = []
  for (let i = 0; i < BURST_RUNS; i += 1) {
    samples.push(await measureBurstOperation(page, `${name} #${i + 1}`, operations, options))
  }
  return {
    name,
    kind: 'burst',
    summary: summarizeBurstSamples(samples),
    samples,
  }
}

function repeatOperations(operations, count) {
  return Array.from({ length: count }, (_, index) => operations[index % operations.length])
}

function shouldMeasureScenario(name) {
  if (!SCENARIO_FILTERS.length) return true
  return SCENARIO_FILTERS.some((filter) => name.includes(filter))
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-perf-books-'))
  const bookPaths = ['A', 'B', 'C'].map((name) => path.join(tempDir, `FLOW_PERF_${name}.txt`))
  if (PERF_MODE === 'tauri') {
    makeBook(bookPaths[0], 'FLOW_PERF_A', 'PERF_A', BOOK_CHAPTERS, BOOK_PARAGRAPHS)
    makeBook(bookPaths[1], 'FLOW_PERF_B', 'PERF_B', BOOK_CHAPTERS, BOOK_PARAGRAPHS)
    makeBook(bookPaths[2], 'FLOW_PERF_C', 'PERF_C', BOOK_CHAPTERS, BOOK_PARAGRAPHS)
  }

  const target = await createPerfTarget()
  const { browser, page } = target

  page.on('pageerror', (error) => console.log('PAGEERROR', error.message))
  const windowResize = await applyWindowBounds(target)
  await wait(1000)
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => Boolean(window.__TAURI_INTERNALS__?.invoke && window.reader), null, {
    timeout: 30000,
  })

  const imported =
    BOOK_SOURCE === 'mock'
      ? target.books
      : await invoke(page, 'import_text_paths', {
          imports: bookPaths.map((bookPath) => ({ path: bookPath })),
          replaceExisting: true,
        })
  const books = await Promise.all(
    imported.map(async (book) => {
      const full = await invoke(page, 'get_book', { id: book.id })
      return full ?? book
    }),
  )
  await page.evaluate((books) => {
    window.reader.closeAllTabs?.()
    books.forEach((book) => window.reader.addTab(book))
    window.reader.focusedGroup?.selectTab(0)
  }, books)
  await ensureReaderMode(page)
  await waitForSettled(page, 'initial imported tabs')
  await installPerfInstrumentation(page)
  await navigateTabTo(page, 0, 20, 2)
  await navigateTabTo(page, 1, 55, 3)
  await navigateTabTo(page, 2, 90, 1)
  await page.evaluate(() => window.reader.focusedGroup.selectTab(0))
  await waitForAllTabsReady(page, 'all tabs positioned')

  const scenarios = []
  const recordScenario = async (name, operations) => {
    if (!shouldMeasureScenario(name)) return

    try {
      scenarios.push(await measureScenario(page, name, operations))
    } catch (error) {
      scenarios.push({
        name,
        status: 'failed',
        error: error.message,
        detail: error.detail,
      })
      console.error(`${name}: ${error.message}`)
      if (error.detail) {
        console.error(JSON.stringify(error.detail, null, 2).slice(0, 4000))
      }
    }
  }
  const recordBurstScenario = async (name, operations, options) => {
    if (!shouldMeasureScenario(name)) return

    try {
      scenarios.push(await measureBurstScenario(page, name, operations, options))
    } catch (error) {
      scenarios.push({
        name,
        kind: 'burst',
        status: 'failed',
        error: error.message,
        detail: error.detail,
      })
      console.error(`${name}: ${error.message}`)
      if (error.detail) {
        console.error(JSON.stringify(error.detail, null, 2).slice(0, 4000))
      }
    }
  }
  const selectTabOperation = (index) => ({
    name: `select-tab-${index + 1}`,
    expectedSelectedIndex: index,
    run: () => page.evaluate((index) => window.reader.focusedGroup.selectTab(index), index),
  })
  const clickTabOperation = (index) => ({
    name: `click-tab-${index + 1}`,
    expectedSelectedIndex: index,
    run: () =>
      page.evaluate((index) => {
        const tabs = Array.from(document.querySelectorAll('.ReaderGroup [role="tab"]'))
        const tab = tabs[index]
        if (!(tab instanceof HTMLElement)) {
          throw new Error(`reader tab ${index} not found`)
        }
        tab.click()
      }, index),
  })
  const tabSwitchOps = [selectTabOperation(1), selectTabOperation(2), selectTabOperation(0)]
  const tabClickOps = [clickTabOperation(1), clickTabOperation(2), clickTabOperation(0)]
  const profiles = []

  if (CPU_PROFILE) {
    await ensureSidebar(page, true, 'toc')
    profiles.push(await profileOperation(page, 'cpu-profile/tab-switch/sidebar-toc', tabSwitchOps[0]))
  }

  await ensureSidebar(page, false)
  await recordScenario('tab-switch/sidebar-closed', tabSwitchOps)
  await recordScenario('tab-click/sidebar-closed', tabClickOps)
  await recordBurstScenario('rapid-tab-click/sidebar-closed', repeatOperations(tabClickOps, 18), {
    assertEachFrameVisible: true,
  })

  for (const panel of ['toc', 'search', 'annotation', 'image']) {
    await ensureSidebar(page, true, panel)
    await recordScenario(`tab-switch/sidebar-${panel}`, tabSwitchOps)
    await recordScenario(`tab-click/sidebar-${panel}`, tabClickOps)
    if (panel === 'toc') {
      await recordBurstScenario('rapid-tab-click/sidebar-toc', repeatOperations(tabClickOps, 18), {
        assertEachFrameVisible: true,
      })
    }
  }

  await ensureSidebar(page, true, 'search')
  const searchQueryOperation = {
    name: 'broad-query',
    run: () =>
      page.evaluate(async () => {
        const tab = window.reader.focusedBookTab
        if (!tab) throw new Error('focused book tab missing')
        tab.results = undefined
        const results = await tab.search('性能测量')
        if (tab.keyword === '') tab.results = results
      }),
  }
  await page.evaluate(async () => {
    const tab = window.reader.focusedBookTab
    if (!tab) throw new Error('focused book tab missing')
    await tab.search('性能测量')
  })
  await recordScenario('search-query/sidebar-search', [searchQueryOperation])

  await page.evaluate((book) => {
    window.reader.closeAllTabs?.()
    window.reader.addTab(book)
  }, books[0])
  await ensureReaderMode(page)
  await navigateTabTo(page, 0, 28, 2)

  const pageTurnOps = [
    { name: 'keyboard-next', run: () => page.keyboard.press('ArrowRight') },
    { name: 'keyboard-next', run: () => page.keyboard.press('ArrowRight') },
    { name: 'keyboard-prev', run: () => page.keyboard.press('ArrowLeft') },
    { name: 'keyboard-next', run: () => page.keyboard.press('ArrowRight') },
  ]
  const pageTurnApiOps = [
    {
      name: 'api-next',
      run: () => page.evaluate(() => window.reader.focusedBookTab?.next()),
    },
    {
      name: 'api-next',
      run: () => page.evaluate(() => window.reader.focusedBookTab?.next()),
    },
    {
      name: 'api-prev',
      run: () => page.evaluate(() => window.reader.focusedBookTab?.prev()),
    },
    {
      name: 'api-next',
      run: () => page.evaluate(() => window.reader.focusedBookTab?.next()),
    },
  ]

  await ensureSidebar(page, false)
  await recordScenario('page-turn/sidebar-closed', pageTurnOps)
  await recordScenario('page-turn-api/sidebar-closed', pageTurnApiOps)
  await recordBurstScenario('rapid-page-turn/sidebar-closed', repeatOperations(pageTurnOps, 12))
  try {
    await ensureSidebar(page, true, 'toc')
    await recordScenario('page-turn/sidebar-toc', pageTurnOps)
    await recordScenario('page-turn-api/sidebar-toc', pageTurnApiOps)
    await recordBurstScenario('rapid-page-turn/sidebar-toc', repeatOperations(pageTurnOps, 12))
  } catch (error) {
    scenarios.push({
      name: 'page-turn/sidebar-toc',
      status: 'failed-before-measure',
      error: error.message,
      detail: error.detail,
    })
    console.error(`page-turn/sidebar-toc: ${error.message}`)
    if (error.detail) {
      console.error(JSON.stringify(error.detail, null, 2).slice(0, 4000))
    }
  }

  const result = {
    generatedAt: new Date().toISOString(),
    mode: target.mode,
    appUrl: target.appUrl,
    cdpUrl: target.mode === 'tauri' ? CDP_URL : undefined,
    diagnostics: DIAGNOSTICS,
    runsPerScenario: RUNS,
    burstRunsPerScenario: BURST_RUNS,
    window: {
      requested: { width: WINDOW_WIDTH, height: WINDOW_HEIGHT },
      resize: windowResize,
      actual: await readWindowMetrics(page),
    },
    scenarios,
    profiles,
  }
  const file = path.join(OUT_DIR, `reader-performance-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  fs.writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  console.log(
    JSON.stringify(
      {
        file,
        scenarios: result.scenarios.map((s) => ({
          name: s.name,
          status: s.status ?? 'passed',
          summary: s.summary,
          steadySummary: s.steadySummary,
          steadySkip: s.steadySkip,
          error: s.error,
        })),
        profiles: profiles.map((profile) => ({
          label: profile.label,
          firstFrameMs: profile.firstFrameMs,
          settledMs: profile.settledMs,
          longTaskTotalMs: profile.longTaskTotalMs,
          counters: profile.counters,
          topSelfTime: profile.cpu.topSelfTime.slice(0, 12),
        })),
      },
      null,
      2,
    ),
  )
  await browser.close()
}

main().catch((error) => {
  console.error(error.message)
  if (error.detail) {
    console.error(JSON.stringify(error.detail, null, 2).slice(0, 8000))
  }
  process.exit(1)
})
