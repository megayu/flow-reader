import fs from 'node:fs'
import path from 'node:path'

import { chromium } from '@playwright/test'
import sharp from 'sharp'

const CDP_URL = process.env.FLOW_READER_CDP_URL ?? 'http://127.0.0.1:9351'
const INVENTORY_FILE =
  process.env.FLOW_READER_VERTICAL_INVENTORY ??
  path.join(process.cwd(), 'test-results', 'vertical-rl-book-inventory.json')
const OUT_DIR =
  process.env.FLOW_READER_VERTICAL_OUT_DIR ??
  path.join(process.cwd(), 'test-results', 'reader-layout-vertical-rl-release')
const TITLE_SEARCH_ONLY = process.env.FLOW_READER_VERTICAL_TITLE_SEARCH_ONLY === '1'
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function assert(condition, message, detail) {
  if (condition) return
  const error = new Error(message)
  error.detail = detail
  throw error
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function displayTitle(book) {
  return book.title.replace(/\s+-\s+.*\.epub$/i, '').replace(/\.epub$/i, '')
}

async function waitForFocusedBook(page, id) {
  await page.waitForFunction(
    (expected) =>
      window.reader?.focusedBookTab?.book?.id === expected &&
      window.reader.focusedBookTab.rendered &&
      window.reader.focusedBookTab.paginationSnapshot?.location,
    id,
    { timeout: 20_000 },
  )
  await wait(500)
}

async function openBook(page, book) {
  const title = displayTitle(book)
  let button = page
    .getByRole('button', {
      name: new RegExp(escapeRegExp(title)),
    })
    .first()
  if (!(await button.isVisible().catch(() => false))) {
    await page
      .getByRole('button', { name: /图书馆|LIBRARY/i })
      .first()
      .click()
    button = page
      .getByRole('button', {
        name: new RegExp(escapeRegExp(title)),
      })
      .first()
    await button.waitFor({ state: 'visible' })
  }
  await button.click()
  await waitForFocusedBook(page, book.id)
  return title
}

async function closeTransientUi(page) {
  await page.keyboard.press('Escape').catch(() => {})
  await page.keyboard.press('Escape').catch(() => {})
  await page
    .locator('[data-flow-reader-pane][aria-hidden="false"] [data-flow-reader-content]')
    .click({ position: { x: 80, y: 80 } })
    .catch(() => {})
  await wait(150)
}

async function inspectReader(page) {
  return page.evaluate(() => {
    const tab = window.reader?.focusedBookTab
    const pane = document.querySelector('[data-flow-reader-pane][aria-hidden="false"]')
    const content = pane?.querySelector('[data-flow-reader-content]')
    const contentRect = content?.getBoundingClientRect()
    const pageWidth = tab?.rendition?.manager?.layout?.pageWidth
    const gap = tab?.rendition?.manager?.layout?.gap
    const frames = Array.from(pane?.querySelectorAll('iframe') ?? [])
      .filter((frame) => frame.getBoundingClientRect().width > 0)
      .map((frame) => {
        const frameRect = frame.getBoundingClientRect()
        const body = frame.contentDocument?.body
        const bodyStyle = body && frame.contentWindow?.getComputedStyle(body)
        const paragraph = frame.contentDocument?.querySelector('p')
        const paragraphStyle = paragraph && frame.contentWindow?.getComputedStyle(paragraph)
        const walker = frame.contentDocument?.createTreeWalker(body, NodeFilter.SHOW_TEXT)
        let flow
        let node
        while ((node = walker?.nextNode())) {
          const value = node.textContent ?? ''
          const match = /[\p{Script=Han}]{2}/u.exec(value)
          if (!match || match.index === undefined) continue
          const first = frame.contentDocument.createRange()
          const second = frame.contentDocument.createRange()
          first.setStart(node, match.index)
          first.setEnd(node, match.index + 1)
          second.setStart(node, match.index + 1)
          second.setEnd(node, match.index + 2)
          const a = first.getBoundingClientRect()
          const b = second.getBoundingClientRect()
          const outerA = {
            left: frameRect.left + a.left,
            top: frameRect.top + a.top,
          }
          if (
            contentRect &&
            outerA.left >= contentRect.left &&
            outerA.left <= contentRect.right &&
            outerA.top >= contentRect.top &&
            outerA.top <= contentRect.bottom
          ) {
            flow = { firstTop: a.top, secondTop: b.top }
            break
          }
        }

        return {
          rect: {
            left: frameRect.left,
            top: frameRect.top,
            width: frameRect.width,
            height: frameRect.height,
          },
          writingMode: bodyStyle?.writingMode,
          direction: bodyStyle?.direction,
          padding: bodyStyle && {
            top: bodyStyle.paddingTop,
            right: bodyStyle.paddingRight,
            bottom: bodyStyle.paddingBottom,
            left: bodyStyle.paddingLeft,
          },
          paragraph: paragraphStyle && {
            lineHeight: paragraphStyle.lineHeight,
            textIndent: paragraphStyle.textIndent,
          },
          flow,
        }
      })

    return {
      bookId: tab?.book?.id,
      footer: pane?.innerText?.split('\n').slice(-4),
      location: tab?.paginationSnapshot?.location,
      paginationModel: tab?.rendition?.manager?.paginationModel?.(),
      pageWidth,
      gap,
      contentRect: contentRect && {
        left: contentRect.left,
        top: contentRect.top,
        width: contentRect.width,
        height: contentRect.height,
      },
      frames,
      devicePixelRatio,
    }
  })
}

async function screenshotWithGapCheck(page, file, reader) {
  await page.screenshot({ path: file })
  const frame = reader.frames.find((candidate) => candidate.writingMode === 'vertical-rl')
  assert(frame, 'no rendered vertical-rl frame found', reader)
  assert(reader.contentRect, 'reader content rect is missing', reader)
  assert(reader.pageWidth > 0 && reader.gap > 0, 'invalid page geometry', reader)

  const dpr = reader.devicePixelRatio || 1
  const left = Math.round((reader.contentRect.left + reader.pageWidth - reader.gap / 2) * dpr)
  const top = Math.round(frame.rect.top * dpr)
  const width = Math.max(1, Math.round(reader.gap * dpr))
  const height = Math.max(1, Math.round(frame.rect.height * dpr))
  const image = sharp(file)
  const metadata = await image.metadata()
  const extract = {
    left: Math.max(0, Math.min(left, metadata.width - 1)),
    top: Math.max(0, Math.min(top, metadata.height - 1)),
    width: Math.min(width, metadata.width - left),
    height: Math.min(height, metadata.height - top),
  }
  const { data, info } = await image.extract(extract).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  let darkPixels = 0
  for (let index = 0; index < data.length; index += info.channels) {
    if (data[index] < 150 && data[index + 1] < 150 && data[index + 2] < 150) {
      darkPixels += 1
    }
  }

  return {
    crop: extract,
    darkPixels,
    totalPixels: info.width * info.height,
  }
}

async function selectVisibleRange(page, mode) {
  return page.evaluate((selectionMode) => {
    const pane = document.querySelector('[data-flow-reader-pane][aria-hidden="false"]')
    const paneRect = pane?.getBoundingClientRect()
    if (!pane || !paneRect) throw new Error('active reader pane is missing')

    for (const frame of pane.querySelectorAll('iframe')) {
      const frameRect = frame.getBoundingClientRect()
      const doc = frame.contentDocument
      const win = frame.contentWindow
      if (!doc || !win || !doc.body) continue
      const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT)
      let node
      while ((node = walker.nextNode())) {
        const value = node.textContent ?? ''
        const candidates = []
        if (selectionMode === 'short') {
          for (const match of value.matchAll(/[\p{Script=Han}]{3}/gu)) {
            candidates.push([match.index, match.index + match[0].length])
          }
        } else if (value.length >= 30) {
          for (let start = 0; start < Math.min(80, value.length - 30); start += 1) {
            for (const length of [80, 60, 45, 30]) {
              if (start + length <= value.length) {
                candidates.push([start, start + length])
              }
            }
          }
        }

        for (const [start, end] of candidates) {
          const range = doc.createRange()
          range.setStart(node, start)
          range.setEnd(node, end)
          const rects = Array.from(range.getClientRects()).map((rect) => ({
            left: frameRect.left + rect.left,
            right: frameRect.left + rect.right,
            top: frameRect.top + rect.top,
            bottom: frameRect.top + rect.bottom,
            width: rect.width,
            height: rect.height,
          }))
          if (!rects.length || (selectionMode === 'cross' && rects.length < 2)) {
            continue
          }
          if (
            rects.some(
              (rect) =>
                rect.width <= 0 ||
                rect.height <= 0 ||
                rect.left < paneRect.left + 30 ||
                rect.right > paneRect.right - 30 ||
                rect.top < paneRect.top + 20 ||
                rect.bottom > paneRect.bottom - 20,
            )
          ) {
            continue
          }

          const selection = win.getSelection()
          selection.removeAllRanges()
          selection.addRange(range)
          const bounds = range.getBoundingClientRect()
          win.dispatchEvent(
            new win.MouseEvent('contextmenu', {
              bubbles: true,
              cancelable: true,
              clientX: bounds.left + bounds.width / 2,
              clientY: bounds.top + bounds.height / 2,
            }),
          )
          return {
            text: range.toString(),
            cfi: window.reader.focusedBookTab.rangeToCfi(range),
            rects: rects.sort((a, b) => b.left - a.left || a.top - b.top),
          }
        }
      }
    }
    throw new Error(`no visible ${selectionMode} range found`)
  }, mode)
}

async function inspectSelectionMenu(page, selected) {
  await page.locator('button[aria-label="highlight yellow"]').waitFor({ state: 'visible' })
  return page.evaluate((selection) => {
    const action = document.querySelector('button[aria-label="highlight yellow"]')
    const menu = action?.closest('[data-flow-keyboard-capture="true"]')
    const pane = menu?.closest('[data-flow-reader-pane]')
    const content = pane?.querySelector('[data-flow-reader-content]')
    const menuRect = menu?.getBoundingClientRect()
    const contentRect = content?.getBoundingClientRect()
    const selectionRect = {
      left: Math.min(...selection.rects.map((rect) => rect.left)),
      right: Math.max(...selection.rects.map((rect) => rect.right)),
      top: Math.min(...selection.rects.map((rect) => rect.top)),
      bottom: Math.max(...selection.rects.map((rect) => rect.bottom)),
    }
    if (!menuRect || !contentRect) throw new Error('selection menu is missing')
    const overlaps = !(
      menuRect.right <= selectionRect.left ||
      menuRect.left >= selectionRect.right ||
      menuRect.bottom <= selectionRect.top ||
      menuRect.top >= selectionRect.bottom
    )

    return {
      actionCount: document.querySelectorAll('button[aria-label^="highlight "], button[aria-label^="underline "]')
        .length,
      inside:
        menuRect.left >= contentRect.left &&
        menuRect.right <= contentRect.right &&
        menuRect.top >= contentRect.top &&
        menuRect.bottom <= contentRect.bottom,
      beside: menuRect.right <= selectionRect.left || menuRect.left >= selectionRect.right,
      overlaps,
    }
  }, selected)
}

async function verifyNotePopover(page) {
  const noteTarget = await page.evaluate(async () => {
    const tab = window.reader.focusedBookTab
    const ordered = [
      ...tab.sections.filter((section) => section.index >= tab.section.index),
      ...tab.sections.filter((section) => section.index < tab.section.index),
    ]
    for (const section of ordered) {
      await tab.ensureSectionInfo(section)
      const link = Array.from(section.document?.querySelectorAll('a[href*="#"]') ?? []).find((candidate) => {
        const marker = candidate.textContent?.trim() ?? ''
        return (
          /^[[(（〔【]?[0-9一二三四五六七八九十]+[\])）〕】]?$/.test(marker) &&
          !candidate.closest('.note, aside, [role="doc-footnote"], [epub\\:type~="footnote"]')
        )
      })
      if (!link) continue

      const cfi = section.cfiFromElement(link)
      await tab.displayReflowableTarget(section.index, cfi)
      return { sectionIndex: section.index, cfi }
    }
  })
  if (!noteTarget) return { applicable: false, internalHashLinks: 0 }
  await wait(800)

  const anchor = await page.evaluate(() => {
    const pane = document.querySelector('[data-flow-reader-pane][aria-hidden="false"]')
    const paneRect = pane?.getBoundingClientRect()
    if (!pane || !paneRect) throw new Error('reader pane is missing')
    for (const frame of pane.querySelectorAll('iframe')) {
      const frameRect = frame.getBoundingClientRect()
      for (const link of frame.contentDocument?.querySelectorAll('a[href*="#"]') ?? []) {
        const marker = link.textContent?.trim() ?? ''
        if (
          !/^[[(（〔【]?[0-9一二三四五六七八九十]+[\])）〕】]?$/.test(marker) ||
          link.closest('.note, aside, [role="doc-footnote"], [epub\\:type~="footnote"]')
        ) {
          continue
        }
        const rect = link.getBoundingClientRect()
        const outer = {
          left: frameRect.left + rect.left,
          right: frameRect.left + rect.right,
          top: frameRect.top + rect.top,
          bottom: frameRect.top + rect.bottom,
        }
        if (
          marker &&
          outer.left > paneRect.left + 180 &&
          outer.right < paneRect.right - 30 &&
          outer.top > paneRect.top + 20 &&
          outer.bottom < paneRect.bottom - 20
        ) {
          link.dispatchEvent(
            new frame.contentWindow.MouseEvent('click', {
              bubbles: true,
              cancelable: true,
              clientX: rect.left + rect.width / 2,
              clientY: rect.top + rect.height / 2,
            }),
          )
          return outer
        }
      }
    }
    return undefined
  })
  if (!anchor) {
    return { applicable: false, internalHashLinks: 1, noteTarget }
  }
  await page.locator('.flow-note-popover').waitFor({ state: 'visible' })
  const result = await page.evaluate((anchorRect) => {
    const popover = document.querySelector('.flow-note-popover')
    const content = popover?.firstElementChild
    const rect = popover?.getBoundingClientRect()
    if (!rect || !content) throw new Error('note popover is missing')
    return {
      side: rect.right < anchorRect.left ? 'left' : 'right',
      gap: rect.right < anchorRect.left ? anchorRect.left - rect.right : rect.left - anchorRect.right,
      writingMode: getComputedStyle(content).writingMode,
      contentLength: content.textContent?.trim().length ?? 0,
    }
  }, anchor)
  return { applicable: true, ...result }
}

async function verifyDefinition(page, screenshotFile) {
  const selected = await selectVisibleRange(page, 'short')
  const menu = await inspectSelectionMenu(page, selected)
  await page.getByRole('button', { name: '定义', exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll('[ref="flow-definition-underline"]').length)
  const geometry = await page.evaluate((selection) => {
    const selectedLeft = Math.min(...selection.rects.map((rect) => rect.left))
    const paths = Array.from(document.querySelectorAll('[ref="flow-definition-underline"] path')).map((path) =>
      path.getBoundingClientRect(),
    )
    const path = paths.find((rect) => Math.abs(rect.top - selection.rects[0].top) < 80)
    if (!path) throw new Error('definition wave path is missing')
    return {
      pathRight: path.right,
      selectedLeft,
      vertical: path.height > path.width,
    }
  }, selected)
  await page.screenshot({ path: screenshotFile })
  await page.evaluate((text) => window.reader.focusedBookTab.undefine(text), selected.text)
  return { menu, geometry, queryLength: selected.text.length }
}

async function verifyAnnotationHighlight(page, screenshotFile) {
  const selected = await selectVisibleRange(page, 'cross')
  const menu = await inspectSelectionMenu(page, selected)
  await page.locator('button[aria-label="highlight green"]').click()
  await wait(500)
  const result = await page.evaluate((selection) => {
    const tab = window.reader.focusedBookTab
    const annotation = [...tab.book.annotations].find((candidate) => candidate.cfi === selection.cfi)
    if (!annotation) throw new Error('created annotation is missing')
    const markRects = Array.from(document.querySelectorAll('[ref="epubjs-hl"] rect'))
      .map((rect) => rect.getBoundingClientRect())
      .filter((rect) =>
        selection.rects.some(
          (selected) => Math.abs(rect.left - selected.left) < 8 && Math.abs(rect.top - selected.top) < 8,
        ),
      )
      .map((rect) => ({
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      }))
    return { cfi: annotation.cfi, markRects }
  }, selected)
  assert(result.markRects.length >= 2, 'cross-line highlight fragments are missing', {
    selected,
    result,
  })
  const first = selected.rects[0]
  const second = selected.rects[1]
  assert(first.left > second.left, 'vertical range did not advance right-to-left', selected)
  assert(first.top > second.top, 'cross-line range does not split bottom then top', selected)
  await page.screenshot({ path: screenshotFile })

  await page.evaluate((selection) => {
    const pane = document.querySelector('[data-flow-reader-pane][aria-hidden="false"]')
    const target = Array.from(pane?.querySelectorAll('[ref="epubjs-hl"]') ?? []).find((mark) => {
      const rect = mark.getBoundingClientRect()
      return selection.rects.some(
        (selected) =>
          rect.right > selected.left &&
          rect.left < selected.right &&
          rect.bottom > selected.top &&
          rect.top < selected.bottom,
      )
    })
    if (!target) throw new Error('created annotation mark is not clickable')
    target.dispatchEvent(
      new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        clientX: target.getBoundingClientRect().left + 4,
        clientY: target.getBoundingClientRect().top + 4,
      }),
    )
  }, selected)
  const reopened = await inspectSelectionMenu(page, selected)
  await page.keyboard.press('Escape')
  await page.evaluate((cfi) => window.reader.focusedBookTab.removeAnnotation(cfi), result.cfi)
  return {
    menu,
    reopened,
    fragmentCount: selected.rects.length,
    markFragmentCount: result.markRects.length,
  }
}

async function findRepeatedVisibleQuery(page) {
  return page.evaluate(async () => {
    const tab = window.reader.focusedBookTab
    const manager = tab.rendition.manager
    const spread = manager.currentReflowableSpread
    const section = spread?.right?.section
    const view = manager.views.find(section)
    if (!section || !view?.document?.body) {
      throw new Error('visible right-page section is missing')
    }
    const candidates = []
    const seen = new Set()
    const walker = view.document.createTreeWalker(view.document.body, NodeFilter.SHOW_TEXT)
    let node
    while ((node = walker.nextNode()) && candidates.length < 160) {
      const text = (node.textContent ?? '').replace(/\s+/g, '')
      for (const match of text.matchAll(/[\p{Script=Han}]{2}/gu)) {
        if (seen.has(match[0])) continue
        seen.add(match[0])
        candidates.push(match[0])
      }
    }

    for (const query of candidates) {
      const matches = section.find(query).filter((match) => match.cfi)
      if (matches.length < 2) continue
      const pageIndexes = await Promise.all(matches.map((match) => tab.pageIndexForCfi(section.index, match.cfi)))
      const indexesByPage = new Map()
      pageIndexes.forEach((pageIndex, index) => {
        const indexes = indexesByPage.get(pageIndex) ?? []
        indexes.push(index)
        indexesByPage.set(pageIndex, indexes)
      })
      const samePage = Array.from(indexesByPage.entries()).find(([, indexes]) => indexes[0] === 0 && indexes[1] === 1)
      if (samePage) {
        const [pageIndex, visibleIndexes] = samePage
        await tab.displayReflowableTarget(section.index, matches[visibleIndexes[0]].cfi)
        return { query, count: matches.length, pageIndex, visibleIndexes }
      }
    }
    throw new Error('no repeated query found on the visible spread')
  })
}

async function spreadSignature(page) {
  return page.evaluate(() => {
    const spread = window.reader.focusedBookTab.rendition.manager.currentReflowableSpread
    return {
      right: spread?.right && {
        sectionIndex: spread.right.section.index,
        pageIndex: spread.right.pageIndex,
      },
      left: spread?.left && {
        sectionIndex: spread.left.section.index,
        pageIndex: spread.left.pageIndex,
      },
    }
  })
}

async function verifySearches(page, screenshotFile) {
  const repeated = await findRepeatedVisibleQuery(page)
  const query = repeated.query
  const initialOrdinal = repeated.visibleIndexes[0] + 1
  const nextOrdinal = repeated.visibleIndexes[1] + 1
  const beforeFind = await spreadSignature(page)

  await page
    .locator('[data-flow-reader-pane][aria-hidden="false"] [data-flow-reader-content]')
    .click({ position: { x: 80, y: 80 } })
  await page.keyboard.press('Control+f')
  const chapterInput = page.getByRole('textbox', { name: '当前章节搜索' })
  await chapterInput.fill(query)
  await page.waitForFunction(
    ({ ordinal, count }) =>
      document.querySelector('[data-flow-chapter-find-bar]')?.innerText.includes(`${ordinal}/${count}`),
    { ordinal: initialOrdinal, count: repeated.count },
  )
  await chapterInput.press('Enter')
  await page.waitForFunction(
    ({ ordinal, count }) =>
      document.querySelector('[data-flow-chapter-find-bar]')?.innerText.includes(`${ordinal}/${count}`),
    { ordinal: nextOrdinal, count: repeated.count },
  )
  await page.waitForFunction(() => document.querySelectorAll('[ref="epubjs-hl"]').length > 0)
  const chapter = {
    markCount: await page.locator('[ref="epubjs-hl"]').count(),
    stayedOnSpread: JSON.stringify(await spreadSignature(page)) === JSON.stringify(beforeFind),
  }
  await page.keyboard.press('Escape')

  await page.getByRole('button', { name: '搜索', exact: true }).click()
  const sidebarInput = page.getByRole('textbox', { name: '搜索' })
  await sidebarInput.fill(query)
  const result = page.locator('.list-row[role="button"]:has(svg.invisible)').filter({ hasText: query }).last()
  await result.waitFor({ state: 'visible' })
  await result.click()
  await page.waitForFunction(
    (query) =>
      Array.from(document.querySelectorAll('.list-row[role="button"]')).some(
        (row) => row.getAttribute('aria-current') === 'true' && row.textContent?.includes(query),
      ),
    query,
  )
  await page.waitForFunction(() => document.querySelectorAll('[ref="epubjs-hl"]').length > 0)
  const sidebar = await page.evaluate(() => ({
    markCount: document.querySelectorAll('[ref="epubjs-hl"]').length,
    hasResults: /个结果|results?/i.test(document.body.innerText),
    activeResultID: window.reader.focusedBookTab.activeResultID,
  }))
  await page.screenshot({ path: screenshotFile })
  await page.locator('.ActivityBar button[aria-label="目录"]').click()
  assert(chapter.stayedOnSpread, 'chapter find skipped a same-page match', {
    repeated,
    chapter,
  })
  assert(sidebar.activeResultID, 'sidebar search result id was not committed')
  return { chapter, sidebar, repeated, queryLength: query.length }
}

async function inspectChapterFindMatch(page, query) {
  return page.evaluate(async (value) => {
    const tab = window.reader.focusedBookTab
    const section = tab.rendition.manager.currentReflowableSpread?.right?.section ?? tab.currentSection ?? tab.section
    const view = tab.rendition.manager.views._views.find((candidate) => candidate.section.index === section.index)
    const body = view?.contents?.document?.body
    const matches = section.find(value)
    const pageIndexes = await Promise.all(matches.map((match) => tab.pageIndexForCfi(section.index, match.cfi)))
    const ranges = matches.map((match, index) => {
      const range = view?.contents?.range(match.cfi)
      return {
        cfi: match.cfi,
        inBody: !!range && !!body?.contains(range.startContainer),
        pageIndex: pageIndexes[index],
        text: range?.toString(),
      }
    })

    return {
      count: matches.length,
      ranges,
      sectionIndex: section.index,
    }
  }, query)
}

async function waitForVisibleActiveChapterFindHighlight(page) {
  await page.waitForFunction(() => {
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
}

async function verifyKnownChapterTitleFinds(page, title, screenshotFile) {
  const cases = title.includes('聊斋志异')
    ? [
        { chapter: '偷桃', query: '偷' },
        { chapter: '勞山道士', query: '道士', startAtLastPage: true },
      ]
    : title.includes('史記')
      ? [
          { chapter: '秦始皇本紀第六', query: '史記' },
          { chapter: '秦始皇本紀第六', query: '秦始皇' },
        ]
      : []
  const results = []

  for (const [caseIndex, item] of cases.entries()) {
    await page.evaluate(async (chapter) => {
      const tab = window.reader.focusedBookTab
      const flatten = (items) => items.flatMap((entry) => [entry, ...flatten(entry.subitems ?? [])])
      const navItem = flatten(tab.nav.toc).find((entry) => entry.label.trim() === chapter)
      if (!navItem) throw new Error(`Missing chapter ${chapter}`)
      const section = tab.epub.spine.get(navItem.href)
      if (!section) throw new Error(`Missing section for ${chapter}`)
      const hash = navItem.href.split('#')[1]
      if (hash) {
        await tab.displayFromSelector(`#${hash}`, section, false, true)
      } else {
        await tab.displaySectionStart(section)
      }
    }, item.chapter)
    await wait(800)

    const match = await inspectChapterFindMatch(page, item.query)
    assert(match.count > 0, 'known title query has no body matches', {
      item,
      match,
    })
    assert(
      match.ranges.every((range) => range.inBody && range.text?.includes(item.query)),
      'chapter find included a non-body or unresolved match',
      { item, match },
    )

    let initialIndex = 0
    let visiblePageIndexes
    if (item.startAtLastPage) {
      const lastPage = Math.max(...match.ranges.map((range) => range.pageIndex ?? 0))
      initialIndex = match.ranges.findIndex((range) => range.pageIndex === lastPage)
      const target = match.ranges[initialIndex]
      assert(target?.cfi, 'last-page title match has no CFI', { item, match })
      await page.evaluate(
        async ({ sectionIndex, cfi }) => {
          await window.reader.focusedBookTab.displayReflowableTarget(sectionIndex, cfi)
        },
        { sectionIndex: match.sectionIndex, cfi: target.cfi },
      )
      await wait(800)
      visiblePageIndexes = await page.evaluate((sectionIndex) => {
        const spread = window.reader.focusedBookTab.rendition.manager.currentReflowableSpread
        return [spread?.right, spread?.left]
          .filter((address) => address?.section?.index === sectionIndex)
          .map((address) => address.pageIndex)
      }, match.sectionIndex)
      initialIndex = match.ranges.findIndex((range) => visiblePageIndexes.includes(range.pageIndex))
    }

    await page
      .locator('[data-flow-reader-pane][aria-hidden="false"] [data-flow-reader-content]')
      .click({ position: { x: 80, y: 80 } })
    await page.keyboard.press('Control+f')
    const input = page.getByRole('textbox', { name: '当前章节搜索' })
    await input.fill(item.query)
    const bar = page.locator('[data-flow-chapter-find-bar]')
    await page.waitForFunction(
      ({ count, ordinal }) =>
        document.querySelector('[data-flow-chapter-find-bar]')?.innerText.includes(`${ordinal}/${count}`),
      { count: match.count, ordinal: initialIndex + 1 },
    )
    assert(
      (await bar.locator('button').nth(0).isDisabled()) === (initialIndex === 0),
      'previous title match boundary state is incorrect',
      { item, match },
    )
    await waitForVisibleActiveChapterFindHighlight(page)

    if (initialIndex + 1 < match.count) {
      if (item.startAtLastPage) {
        assert(
          visiblePageIndexes.includes(match.ranges[initialIndex + 1]?.pageIndex),
          'next known title match is not on the same terminal spread',
          { item, initialIndex, match, visiblePageIndexes },
        )
      }
      await input.press('Enter')
      await page.waitForFunction(
        ({ count, ordinal }) =>
          document.querySelector('[data-flow-chapter-find-bar]')?.innerText.includes(`${ordinal}/${count}`),
        { count: match.count, ordinal: initialIndex + 2 },
      )
      await waitForVisibleActiveChapterFindHighlight(page)
    } else {
      assert(await bar.locator('button').nth(1).isDisabled(), 'next title match is enabled for a single body result', {
        item,
        match,
      })
    }
    results.push({
      ...item,
      advanced: initialIndex + 1 < match.count,
      initialIndex,
      match,
      visiblePageIndexes,
    })
    if (caseIndex === cases.length - 1) {
      await page.screenshot({ path: screenshotFile })
    } else {
      await page.keyboard.press('Escape')
    }
  }

  return { applicable: results.length > 0, results }
}

async function verifyChapterFindPageTurnMode(page, spreadMode, chapter, query) {
  await page.evaluate((spread) => {
    const tab = window.reader.focusedBookTab
    tab.updateBook({
      configuration: {
        ...tab.book.configuration,
        typography: {
          ...tab.book.configuration?.typography,
          spread,
        },
      },
    })
  }, spreadMode)
  await page.waitForFunction(
    (divisor) => window.reader.focusedBookTab.rendition.manager.layout.divisor === divisor,
    spreadMode === 'none' ? 1 : 2,
  )

  const prepared = await page.evaluate(
    async ({ chapter, query }) => {
      const tab = window.reader.focusedBookTab
      const flatten = (items) => items.flatMap((entry) => [entry, ...flatten(entry.subitems ?? [])])
      const navItem = flatten(tab.nav.toc).find((entry) => entry.label.trim() === chapter)
      if (!navItem) throw new Error(`Missing chapter ${chapter}`)
      const section = tab.epub.spine.get(navItem.href)
      await tab.displaySectionStart(section)
      const matches = section.find(query)
      const pageIndexes = await Promise.all(matches.map((match) => tab.pageIndexForCfi(section.index, match.cfi)))
      const manager = tab.rendition.manager
      const visiblePages = [manager.currentReflowableSpread?.right, manager.currentReflowableSpread?.left]
        .filter((address) => address?.section?.index === section.index)
        .map((address) => address.pageIndex)
      const initialIndex = pageIndexes.findIndex((pageIndex) => visiblePages.includes(pageIndex))
      const firstOffPageIndex = pageIndexes.findIndex(
        (pageIndex, index) => index > initialIndex && !visiblePages.includes(pageIndex),
      )
      return {
        count: matches.length,
        firstOffPageIndex,
        initialIndex,
        pageIndexes,
        sectionIndex: section.index,
        visiblePages,
      }
    },
    { chapter, query },
  )
  assert(
    prepared.initialIndex >= 0 && prepared.firstOffPageIndex > prepared.initialIndex,
    'known chapter has no off-page find transition',
    { spreadMode, prepared },
  )

  await page
    .locator('[data-flow-reader-pane][aria-hidden="false"] [data-flow-reader-content]')
    .click({ position: { x: 80, y: 80 } })
  await page.keyboard.press('Control+f')
  const input = page.getByRole('textbox', { name: '当前章节搜索' })
  await input.fill(query)
  const waitForOrdinal = (ordinal) =>
    page.waitForFunction(
      ({ count, ordinal: expected }) =>
        document.querySelector('[data-flow-chapter-find-bar]')?.innerText.includes(`${expected}/${count}`),
      { count: prepared.count, ordinal },
    )
  await waitForOrdinal(prepared.initialIndex + 1)

  for (let index = prepared.initialIndex + 1; index < prepared.firstOffPageIndex; index += 1) {
    await input.press('Enter')
    await waitForOrdinal(index + 1)
  }
  const before = await spreadSignature(page)
  await input.press('Enter')
  await waitForOrdinal(prepared.firstOffPageIndex + 1)
  await page.waitForFunction(
    ({ pageIndex, sectionIndex }) => {
      const spread = window.reader.focusedBookTab.rendition.manager.currentReflowableSpread
      return [spread?.right, spread?.left].some(
        (address) => address?.section?.index === sectionIndex && address.pageIndex === pageIndex,
      )
    },
    {
      pageIndex: prepared.pageIndexes[prepared.firstOffPageIndex],
      sectionIndex: prepared.sectionIndex,
    },
  )
  await waitForVisibleActiveChapterFindHighlight(page)
  const after = await spreadSignature(page)
  assert(JSON.stringify(before) !== JSON.stringify(after), 'off-page chapter find did not turn the spread', {
    spreadMode,
    prepared,
    before,
    after,
  })
  await page.keyboard.press('Escape')
  return {
    spreadMode,
    prepared,
    before,
    after,
    activeHighlightVisible: true,
  }
}

async function verifyKnownChapterFindPageTurns(page, title) {
  const target = title.includes('聊斋志异')
    ? { chapter: '勞山道士', query: '道士' }
    : title.includes('史記')
      ? { chapter: '秦始皇本紀第六', query: '秦始皇' }
      : undefined
  if (!target) return { applicable: false }

  await closeTransientUi(page)
  const doublePage = await verifyChapterFindPageTurnMode(page, 'auto', target.chapter, target.query)
  const singlePage = await verifyChapterFindPageTurnMode(page, 'none', target.chapter, target.query)
  return { applicable: true, ...target, doublePage, singlePage }
}

async function verifyChapterNavigation(page, book) {
  const target = await page.evaluate((preferredLabel) => {
    const tab = window.reader.focusedBookTab
    const flatten = (items) => items.flatMap((item) => [item, ...flatten(item.subitems ?? [])])
    const entries = flatten(tab.nav.toc)
    const preferred = preferredLabel ? entries.find((item) => item.label.trim() === preferredLabel) : undefined
    const fallback = entries.find((item, index) => {
      if (index < 2 || !item.href?.includes('#')) return false
      const path = item.href.split('#')[0]
      return entries.some(
        (candidate, candidateIndex) => candidateIndex < index && candidate.href?.split('#')[0] === path,
      )
    })
    const item = preferred ?? fallback
    if (!item) throw new Error('no nested TOC target found')
    tab.setNavExpanded(true)
    return { label: item.label.trim(), href: item.href }
  }, book.tocTarget)
  const row = page.getByRole('button', { name: target.label, exact: true })
  const tocButton = page.locator('.ActivityBar button[aria-label="目录"]')
  const tocOpen = await tocButton.evaluate((button) => {
    const sidebar = document.querySelector('.SideBar')
    return !sidebar?.classList.contains('!hidden') && !button.className.includes('text-muted-foreground/70')
  })
  if (!tocOpen) {
    await tocButton.click()
  }
  await page.evaluate(() => {
    const scroll = Array.from(document.querySelectorAll('.SideBar .scroll')).sort(
      (a, b) => b.scrollHeight - a.scrollHeight,
    )[0]
    if (scroll) {
      scroll.scrollTop = 0
      scroll.dispatchEvent(new Event('scroll'))
    }
  })
  await wait(300)
  await row.waitFor({ state: 'visible' })
  await row.click()
  await wait(800)
  const clicked = await inspectReader(page)
  assert(clicked.location?.start?.displayed?.slot === 'right', 'TOC target did not begin on the right page', {
    target,
    clicked,
  })

  const beforeNext = await spreadSignature(page)
  await page.keyboard.press('BracketRight')
  await wait(900)
  const afterNext = await inspectReader(page)
  const afterNextSpread = await spreadSignature(page)
  assert(
    JSON.stringify(afterNextSpread) !== JSON.stringify(beforeNext) &&
      afterNext.location?.start?.displayed?.slot === 'right',
    'next chapter shortcut did not advance to a right-page start',
    { target, beforeNext, afterNextSpread, afterNext },
  )

  await page.keyboard.press('BracketLeft')
  await wait(900)
  const afterPreviousSpread = await spreadSignature(page)
  assert(
    JSON.stringify(afterPreviousSpread) !== JSON.stringify(afterNextSpread),
    'previous chapter shortcut did not return',
    { target, afterNextSpread, afterPreviousSpread },
  )
  await page.keyboard.press('BracketLeft')
  await wait(900)
  const afterSecondPrevious = await spreadSignature(page)
  assert(
    JSON.stringify(afterSecondPrevious) !== JSON.stringify(afterNextSpread),
    'repeated previous chapter shortcut became stuck',
    { target, afterNextSpread, afterPreviousSpread, afterSecondPrevious },
  )
  const repeatedForward = []
  const repeatedBackward = []
  if (book.title.includes('史記')) {
    await row.click()
    await wait(800)
    for (let index = 0; index < 5; index += 1) {
      await page.keyboard.press('BracketRight')
      await wait(800)
      const reader = await inspectReader(page)
      const spread = await spreadSignature(page)
      repeatedForward.push({ reader, spread })
    }
    assert(
      new Set(repeatedForward.map((entry) => entry.spread?.right?.sectionIndex)).size === repeatedForward.length &&
        repeatedForward.every(
          (entry) => entry.reader.location?.start?.displayed?.slot === 'right' && entry.spread?.right?.pageIndex === 0,
        ),
      'repeated next chapter shortcuts became stuck or lost the right-page start',
      repeatedForward,
    )

    for (let index = 0; index < 5; index += 1) {
      await page.keyboard.press('BracketLeft')
      await wait(800)
      const reader = await inspectReader(page)
      const spread = await spreadSignature(page)
      repeatedBackward.push({ reader, spread })
    }
    assert(
      new Set(repeatedBackward.map((entry) => entry.spread?.right?.sectionIndex)).size === repeatedBackward.length &&
        repeatedBackward.every(
          (entry) => entry.reader.location?.start?.displayed?.slot === 'right' && entry.spread?.right?.pageIndex === 0,
        ),
      'repeated previous chapter shortcuts became stuck or lost the right-page start',
      repeatedBackward,
    )
  }
  return {
    target,
    clicked,
    afterNext,
    afterPreviousSpread,
    afterSecondPrevious,
    repeatedForward,
    repeatedBackward,
  }
}

async function inspectPhysicalSectionSlots(page) {
  return page.evaluate(() => {
    const tab = window.reader.focusedBookTab
    const manager = tab.rendition.manager
    const content = document.querySelector('[data-flow-reader-pane][aria-hidden="false"] [data-flow-reader-content]')
    const contentRect = content?.getBoundingClientRect()
    if (!contentRect) throw new Error('active reader content is missing')

    const visible = manager.views._views
      .map((view) => {
        const rect = view.element.getBoundingClientRect()
        const left = Math.max(rect.left, contentRect.left)
        const right = Math.min(rect.right, contentRect.right)
        if (right - left <= 1) return

        const body = view.contents?.document?.body ?? view.document?.body
        return {
          sectionIndex: view.section.index,
          href: view.section.href,
          marker: (body?.querySelector('h1, h2, h3')?.textContent ?? body?.innerText ?? '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 60),
          visibleLeft: left,
          visibleRight: right,
          visibleCenter: (left + right) / 2,
        }
      })
      .filter(Boolean)
      .sort((left, right) => right.visibleCenter - left.visibleCenter)

    return {
      right: visible[0],
      left: visible.length > 1 ? visible[visible.length - 1] : visible[0],
      visible,
    }
  })
}

async function verifyKnownCrossSectionChapterNavigation(page, title) {
  if (!title.includes('聊斋志异')) return { applicable: false }

  const sidebar = page.locator('.SideBar')
  const longChapter = sidebar.getByText('荍中怪', { exact: true })
  const shortChapter = sidebar.getByText('捉狐', { exact: true })
  await longChapter.click()
  await wait(800)
  const longState = await inspectReader(page)
  assert(
    longState.location?.start?.displayed?.total === 2 && longState.location?.start?.displayed?.slot === 'right',
    'known two-page chapter did not open on the right',
    longState,
  )

  await shortChapter.click()
  await wait(800)
  const shortState = await inspectReader(page)
  const physical = await inspectPhysicalSectionSlots(page)
  assert(
    shortState.location?.start?.displayed?.total === 1 &&
      shortState.location?.start?.displayed?.slot === 'right' &&
      shortState.location?.end?.displayed?.slot === 'left' &&
      physical.right?.marker.includes('捉狐') &&
      physical.left?.marker.includes('荍中怪'),
    'known one-page chapter is not physically right of the next chapter',
    { shortState, physical },
  )

  await page.keyboard.press('BracketRight')
  await wait(800)
  const afterNext = await inspectReader(page)
  const afterNextPhysical = await inspectPhysicalSectionSlots(page)
  assert(
    afterNext.location?.start?.displayed?.slot === 'right' && afterNextPhysical.right?.marker.includes('宅妖'),
    'next chapter shortcut did not skip the chapter already visible on the left',
    { afterNext, afterNextPhysical },
  )

  await page.keyboard.press('BracketLeft')
  await wait(800)
  const afterPrevious = await inspectReader(page)
  assert(
    afterPrevious.location?.start?.displayed?.slot === 'right' &&
      afterPrevious.location?.start?.href === longState.location?.start?.href,
    'previous chapter shortcut did not return to the right-page chapter start',
    { longState, afterPrevious },
  )

  return {
    applicable: true,
    longState,
    shortState,
    physical,
    afterNext,
    afterNextPhysical,
    afterPrevious,
  }
}

async function verifySingleAndZoom(page, screenshotFile) {
  const setTypography = (spread, zoom) =>
    page.evaluate(
      ({ spread, zoom }) => {
        const tab = window.reader.focusedBookTab
        tab.updateBook({
          configuration: {
            ...tab.book.configuration,
            typography: {
              ...tab.book.configuration?.typography,
              spread,
              zoom,
            },
          },
        })
      },
      { spread, zoom },
    )
  const inspect = () =>
    page.evaluate(() => {
      const tab = window.reader.focusedBookTab
      const manager = tab.rendition.manager
      const spread = manager.currentReflowableSpread
      const views = manager.views._views
      const view = views.find((candidate) => candidate.section.index === spread?.right?.section?.index)
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
            textCrossesBodyLeft += Array.from(range.getClientRects()).filter(
              (rect) => rect.left < bodyRect.left - 1 && rect.right > bodyRect.left + 1,
            ).length
          }
          textNode = walker.nextNode()
        }
      }
      return {
        divisor: manager.layout.divisor,
        layoutWidth: manager.layout.width,
        layoutColumnWidth: manager.layout.columnWidth,
        gap: manager.layout.gap,
        pageWidth: manager.layout.pageWidth,
        pageHeight: manager.layout.height,
        viewCount: views.length,
        viewSectionIndexes: views.map((candidate) => candidate.section.index),
        hasLeft: !!spread?.left,
        bodyInsideFrame:
          !!bodyRect && typeof frameWidth === 'number' && bodyRect.left >= -1 && bodyRect.right <= frameWidth + 1,
        textCrossesBodyLeft,
        style: style && {
          columnWidth: parseFloat(style.columnWidth),
          columnHeight: parseFloat(style.columnHeight),
          columnGap: parseFloat(style.columnGap),
          rowGap: parseFloat(style.rowGap),
          transform: style.transform,
        },
      }
    })

  await setTypography('none', undefined)
  await page.waitForFunction(
    () =>
      window.reader.focusedBookTab.rendition.manager.layout.divisor === 1 &&
      !window.reader.focusedBookTab.rendition.manager.currentReflowableSpread?.left,
  )
  const single = await inspect()
  assert(single.viewCount === 1 && !single.hasLeft, 'single-page view leaked pages', single)

  await setTypography('none', 1.5)
  await page.waitForFunction(() => {
    const body = window.reader.focusedBookTab.rendition.manager.views._views.find((view) => view.document?.body)
      ?.document?.body
    return !!body && getComputedStyle(body).transform !== 'none'
  })
  await wait(600)
  const zoomed = await inspect()
  const rowHeight =
    zoomed.layoutWidth <= zoomed.layoutColumnWidth + zoomed.gap
      ? zoomed.layoutColumnWidth - zoomed.gap
      : zoomed.layoutColumnWidth
  assert(
    zoomed.viewCount === 1 &&
      !zoomed.hasLeft &&
      zoomed.bodyInsideFrame &&
      zoomed.textCrossesBodyLeft === 0 &&
      Math.abs(zoomed.style.columnWidth - (zoomed.pageHeight - 20) / 1.5) < 1 &&
      Math.abs(zoomed.style.columnHeight - rowHeight / 1.5) < 1 &&
      zoomed.style.columnGap === 0,
    'zoomed single-page physical axes are incorrect',
    zoomed,
  )
  await page.screenshot({ path: screenshotFile })
  await setTypography('auto', undefined)
  await page.waitForFunction(() => window.reader.focusedBookTab.rendition.manager.layout.divisor === 2)
  await wait(600)
  return { single, zoomed }
}

async function verifyBook(page, book) {
  const title = await openBook(page, book)
  await closeTransientUi(page)
  await page.evaluate(() => {
    const tab = window.reader.focusedBookTab
    const typography = {
      ...tab.book.configuration?.typography,
      spread: 'auto',
    }
    delete typography.zoom
    tab.updateBook({
      configuration: {
        ...tab.book.configuration,
        typography,
      },
    })
  })
  await page.waitForFunction(() => window.reader.focusedBookTab.rendition.manager.layout.divisor === 2)
  await wait(600)
  const initial = await inspectReader(page)
  assert(
    initial.paginationModel?.pageProgressionAxis === 'horizontal' &&
      initial.paginationModel?.spreadSlotOrder === 'right-first',
    'vertical pagination model is incorrect',
    initial,
  )
  assert(
    initial.frames.some((frame) => frame.writingMode === 'vertical-rl' && frame.flow?.secondTop > frame.flow?.firstTop),
    'vertical text does not flow top-to-bottom',
    initial,
  )
  const initialGap = await screenshotWithGapCheck(page, path.join(OUT_DIR, `${book.id}-initial.png`), initial)
  assert(initialGap.darkPixels === 0, 'initial spread gap contains dark pixels', initialGap)

  await page.keyboard.press('ArrowRight')
  await wait(600)
  const afterNext = await inspectReader(page)
  const nextGap = await screenshotWithGapCheck(page, path.join(OUT_DIR, `${book.id}-next.png`), afterNext)
  assert(nextGap.darkPixels === 0, 'page-turn spread gap contains dark pixels', nextGap)
  await page.keyboard.press('ArrowLeft')
  await wait(500)

  const note = await verifyNotePopover(page)
  if (note.applicable) {
    assert(note.side === 'left', 'note popover did not prefer the physical left', note)
    assert(note.writingMode === 'vertical-rl', 'note content is not vertical-rl', note)
    assert(note.contentLength > 0, 'note popover content is empty', note)
    await page.screenshot({ path: path.join(OUT_DIR, `${book.id}-note.png`) })
    await page.keyboard.press('Escape')
  } else {
    assert(note.internalHashLinks === 0, 'book has linked notes but none could be opened', note)
  }

  const definition = await verifyDefinition(page, path.join(OUT_DIR, `${book.id}-definition.png`))
  assert(
    definition.menu.actionCount === 5,
    'selection menu does not contain exactly five annotation actions',
    definition,
  )
  assert(
    definition.menu.inside && definition.menu.beside && !definition.menu.overlaps,
    'selection menu is clipped or covers the selection',
    definition,
  )
  assert(
    definition.geometry.vertical && definition.geometry.pathRight <= definition.geometry.selectedLeft + 0.75,
    'definition wave is not on the glyph left side',
    definition,
  )
  const annotation = await verifyAnnotationHighlight(page, path.join(OUT_DIR, `${book.id}-highlight.png`))
  const chapterNavigation = await verifyChapterNavigation(page, book)
  const knownCrossSectionNavigation = await verifyKnownCrossSectionChapterNavigation(page, title)
  const singleAndZoom = await verifySingleAndZoom(page, path.join(OUT_DIR, `${book.id}-single-zoom.png`))
  const searches = await verifySearches(page, path.join(OUT_DIR, `${book.id}-search.png`))
  const knownChapterTitleFinds = await verifyKnownChapterTitleFinds(
    page,
    title,
    path.join(OUT_DIR, `${book.id}-title-search.png`),
  )

  return {
    id: book.id,
    title,
    initial,
    afterNext,
    initialGap,
    nextGap,
    note,
    definition,
    annotation,
    chapterNavigation,
    knownCrossSectionNavigation,
    singleAndZoom,
    searches,
    knownChapterTitleFinds,
  }
}

async function verifyTitleSearchBook(page, book) {
  const title = await openBook(page, book)
  await closeTransientUi(page)
  const sidebar = page.locator('.SideBar')
  const tocOpen = await sidebar
    .getByText('目录', { exact: true })
    .isVisible()
    .catch(() => false)
  if (!tocOpen) {
    await page.locator('.ActivityBar button[aria-label="目录"]').click()
  }
  await wait(300)
  const knownChapterTitleFinds = await verifyKnownChapterTitleFinds(
    page,
    title,
    path.join(OUT_DIR, `${book.id}-title-search.png`),
  )
  const knownChapterFindPageTurns = await verifyKnownChapterFindPageTurns(page, title)
  assert(knownChapterTitleFinds.applicable, 'book has no known chapter title search cases', {
    book,
    knownChapterTitleFinds,
  })

  return {
    id: book.id,
    title,
    knownChapterTitleFinds,
    knownChapterFindPageTurns,
  }
}

fs.mkdirSync(OUT_DIR, { recursive: true })
const inventory = JSON.parse(fs.readFileSync(INVENTORY_FILE, 'utf8'))
assert(inventory.books?.length === 2, 'expected exactly two tagged vertical books', inventory)

const browser = await chromium.connectOverCDP(CDP_URL)
try {
  const page = browser.contexts().flatMap((context) => context.pages())[0]
  assert(page, 'no Flow Reader CDP page found')
  const results = []
  for (const book of inventory.books) {
    results.push(TITLE_SEARCH_ONLY ? await verifyTitleSearchBook(page, book) : await verifyBook(page, book))
  }
  fs.writeFileSync(
    path.join(OUT_DIR, 'result.json'),
    JSON.stringify(
      {
        mode: TITLE_SEARCH_ONLY ? 'tauri-release-title-search' : 'tauri-release',
        books: results,
      },
      null,
      2,
    ),
  )
  console.log(`vertical-rl release verification passed: ${OUT_DIR}`)
} finally {
  await browser.close()
}
