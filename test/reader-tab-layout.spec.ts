import path from 'node:path'

import { expect, test, type Page } from '@playwright/test'

import type { BookRecord } from '../src/db'

const aliceEpubPath = path.resolve('packages/epubjs/test/fixtures/alice.epub')
const alicePackageUrl = '/test-assets/alice.epub'

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

async function installReaderBooksMock(page: Page) {
  const books = [
    createBook('tab-layout-a', 'Tab Layout A'),
    createBook('tab-layout-b', 'Tab Layout B'),
  ]

  await page.route(`**${alicePackageUrl}`, (route) =>
    route.fulfill({
      path: aliceEpubPath,
      contentType: 'application/epub+zip',
    }),
  )

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
    { fixtureBooks: books, packageUrl: alicePackageUrl },
  )
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
    const header =
      Array.from(document.querySelectorAll('.ReaderGroup button'))
        .filter(isVisible)
        .map((el) => el.textContent?.replace(/\s+/g, ' ').trim() ?? '')
        .find((text) => text.includes('Down The Rabbit-Hole')) ?? ''
    const sidebar =
      document
        .querySelector('.SideBar')
        ?.textContent?.replace(/\s+/g, ' ')
        .trim() ?? ''
    const sidebarEl = document.querySelector('.SideBar')
    const sidebarVisible = sidebarEl ? isVisible(sidebarEl) : false
    const overlappingHiddenPanes = Array.from(
      document.querySelectorAll('[data-flow-reader-pane][aria-hidden="true"]'),
    ).filter((el) => {
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
      overlappingHiddenPanes,
      sidebar,
      sidebarVisible,
      tabs,
    }
  })
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
  options: { sidebarVisible?: boolean } = {},
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

      return (
        layout.frames.length > 0 &&
        layout.frames.every(
          (frame) => frame.width > 250 && frame.maxTextBlockWidth > 180,
        ) &&
        layout.header.includes('Down The Rabbit-Hole') &&
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

async function waitForStableReaderLayout(
  page: Page,
  options: { sidebarVisible?: boolean } = {},
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

test.beforeEach(async ({ page }) => {
  await installReaderBooksMock(page)
  await page.goto('/')
  await page.addStyleTag({
    content:
      'nextjs-portal{display:none!important;pointer-events:none!important}',
  })
  await expect(page.locator('#layout')).toBeVisible()
  await expect(page.locator('ul.grid [role="button"]')).toHaveCount(2)
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
