import fs from 'node:fs'
import path from 'node:path'
import { chromium } from '@playwright/test'

const CDP_URL = process.env.FLOW_READER_CDP_URL ?? 'http://127.0.0.1:9351'
const DATA_DIR =
  process.env.FLOW_READER_DATA_DIR ??
  path.join(process.cwd(), 'test-results', 'text-edit-client-data')
const OUT_DIR =
  process.env.FLOW_READER_TEXT_EDIT_OUT_DIR ??
  path.join(process.cwd(), 'test-results', 'text-edit-client')

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

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  fs.mkdirSync(DATA_DIR, { recursive: true })
  const deepChapterCount = 300
  const deepOldText = '错字'
  const deepNewText = '正字'
  const deepTargetParagraph = `深章节性能验证第${deepChapterCount}章包含${deepOldText}，用于检查后端替换是否快速返回。`
  const deepBookPath = path.join(OUT_DIR, 'flow-text-edit-client-deep.txt')
  fs.writeFileSync(
    deepBookPath,
    Array.from({ length: deepChapterCount }, (_, index) => {
      const chapter = index + 1
      const paragraph =
        chapter === deepChapterCount
          ? deepTargetParagraph
          : `深章节性能验证第${chapter}章保持不变。`
      return [
        `第${String(chapter).padStart(3, '0')}章 深章节${chapter}`,
        paragraph,
        '',
      ]
    })
      .flat()
      .join('\n'),
    'utf8',
  )

  const bookPath = path.join(OUT_DIR, 'flow-text-edit-client.txt')
  const oldText = '错字'
  const newText = '正字'
  const paragraph = `客户端真实编辑验证第一段包含${oldText}，用于检查保存后 iframe 是否即时同步。`
  fs.writeFileSync(
    bookPath,
    [
      '客户端真实编辑验证',
      '',
      '第001章 真实客户端',
      paragraph,
      '第二段保持不变。',
      '',
    ].join('\n'),
    'utf8',
  )

  const browser = await chromium.connectOverCDP(CDP_URL)
  const context = browser.contexts()[0]
  const page =
    context
      .pages()
      .find((candidate) => candidate.url().includes('localhost:7127')) ??
    context.pages()[0]
  page.on('pageerror', (error) => console.log('PAGEERROR', error.message))

  await page.waitForFunction(
    () => Boolean(window.__TAURI_INTERNALS__?.invoke && window.reader),
    null,
    { timeout: 30000 },
  )

  const [bookSummary] = await invoke(page, 'import_text_paths', {
    imports: [
      { path: bookPath, encoding: 'utf-8', title: '客户端真实编辑验证' },
    ],
    replaceExisting: true,
  })
  assert(bookSummary?.id, 'import_text_paths did not return a book')
  const [deepBookSummary] = await invoke(page, 'import_text_paths', {
    imports: [
      { path: deepBookPath, encoding: 'utf-8', title: '深章节性能验证' },
    ],
    replaceExisting: true,
  })
  assert(deepBookSummary?.id, 'deep import_text_paths did not return a book')

  const deepStartOffset = deepTargetParagraph.indexOf(deepOldText)
  assert(deepStartOffset >= 0, 'deep replacement target text is invalid')
  const deepStartedAt = performance.now()
  await invoke(page, 'replace_book_text', {
    id: deepBookSummary.id,
    target: {
      sectionHref: `Text/part${String(deepChapterCount).padStart(4, '0')}.xhtml`,
      textNodeIndex: 99,
      textNodeText: deepTargetParagraph,
      startOffset: deepStartOffset,
      endOffset: deepStartOffset + deepOldText.length,
      paragraphIndex: 0,
    },
    oldText: deepOldText,
    newText: deepNewText,
  })
  const deepReplaceMs = performance.now() - deepStartedAt
  const deepSourcePath = path.join(
    DATA_DIR,
    'books',
    deepBookSummary.id,
    'source.txt',
  )
  const deepSourceText = fs.readFileSync(deepSourcePath, 'utf8')
  assert(
    deepSourceText.includes(deepNewText) &&
      !deepSourceText.includes(deepOldText),
    'deep source.txt did not update',
    { deepSourcePath },
  )

  const book =
    (await invoke(page, 'get_book', { id: bookSummary.id })) ?? bookSummary

  await page.evaluate((book) => {
    window.reader.closeAllTabs?.()
    window.reader.addTab(book)
  }, book)

  await page.waitForFunction(
    (needle) =>
      window.reader.focusedBookTab?.iframes?.some((win) =>
        win.document?.body?.innerText?.includes(needle),
      ),
    paragraph,
    { timeout: 30000 },
  )

  const overlayLocked = await page.evaluate(async () => {
    const textarea = document.querySelector('textarea[name="replacement"]')
    return !textarea
  })
  assert(overlayLocked, 'test precondition failed: edit menu is already open')

  const result = await page.evaluate(
    async ({ bookId, paragraph, oldText, newText }) => {
      const tab = window.reader.focusedBookTab
      const win = tab.iframes.find((candidate) =>
        candidate.document.body.innerText.includes(paragraph),
      )
      const doc = win.document
      const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT)
      let node = walker.nextNode()
      let textNodeIndex = 0
      while (node) {
        if ((node.textContent ?? '').includes(oldText)) break
        textNodeIndex += 1
        node = walker.nextNode()
      }
      if (!node) throw new Error('test text node not found')

      const textNodeText = node.textContent ?? ''
      const startOffset = textNodeText.indexOf(oldText)
      if (startOffset < 0) throw new Error('old text not found in node')
      const paragraphElement = node.parentElement?.closest('p')
      const marker = paragraphElement?.closest('[data-flow-body-text="true"]')
      const paragraphContainer =
        marker === paragraphElement
          ? paragraphElement.parentElement
          : marker instanceof HTMLElement
            ? marker
            : paragraphElement?.closest('.flow-txt-body')
      const paragraphs = paragraphContainer
        ? Array.from(paragraphContainer.children).filter(
            (element) =>
              element.tagName.toLowerCase() === 'p' &&
              (marker !== paragraphElement ||
                element.getAttribute('data-flow-body-text') === 'true'),
          )
        : []
      const paragraphIndex = paragraphElement
        ? paragraphs.indexOf(paragraphElement)
        : -1
      const sectionHref =
        tab.viewForWindow(win)?.section?.href ?? tab.section?.href
      const target = {
        sectionHref,
        textNodeIndex,
        textNodeText,
        startOffset,
        endOffset: startOffset + oldText.length,
        paragraphIndex: paragraphIndex >= 0 ? paragraphIndex : undefined,
      }

      const replaceStartedAt = performance.now()
      const replaceResult = await window.__TAURI_INTERNALS__.invoke(
        'replace_book_text',
        {
          id: bookId,
          target,
          oldText,
          newText,
        },
      )
      const replaceMs = performance.now() - replaceStartedAt
      const patchStartedAt = performance.now()
      await window.reader.applyBookContentEdit(
        replaceResult.book,
        replaceResult.sectionHref,
        tab,
        {
          target,
          oldText,
          newText,
          document: doc,
          textNode: node,
        },
      )
      const patchMs = performance.now() - patchStartedAt

      return {
        changed: replaceResult.changed,
        bodyText: doc.body.innerText,
        nodeText: node.textContent,
        target,
        replaceMs,
        patchMs,
      }
    },
    { bookId: book.id, paragraph, oldText, newText },
  )

  assert(result.changed, 'replace_book_text returned changed=false', result)
  assert(
    result.bodyText.includes(newText) && !result.bodyText.includes(oldText),
    'iframe text did not update after applyBookContentEdit',
    result,
  )

  const sourcePath = path.join(DATA_DIR, 'books', book.id, 'source.txt')
  const sourceText = fs.readFileSync(sourcePath, 'utf8')
  assert(
    sourceText.includes(newText) && !sourceText.includes(oldText),
    'source.txt did not update',
    { sourcePath, sourceText },
  )

  const lockResult = await page.evaluate(
    async ({ currentText, replacementText }) => {
      const tab = window.reader.focusedBookTab
      const win =
        tab.iframes.find((candidate) =>
          candidate.document.body.innerText.includes(currentText),
        ) ?? tab.iframes[0]
      if (!win) throw new Error('active iframe not found')
      const doc = win.document
      const textNode = (() => {
        const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT)
        let node = walker.nextNode()
        while (node) {
          if ((node.textContent ?? '').includes(currentText)) return node
          node = walker.nextNode()
        }
      })()
      if (!textNode) throw new Error('updated text node not found')
      const selection = win.getSelection()
      const text = textNode.textContent ?? ''
      const start = text.indexOf(currentText)
      const range = doc.createRange()
      range.setStart(textNode, start)
      range.setEnd(textNode, start + currentText.length)
      selection.removeAllRanges()
      selection.addRange(range)
      doc.dispatchEvent(
        new MouseEvent('mouseup', {
          bubbles: true,
          clientX: 120,
          clientY: 120,
        }),
      )

      const waitFor = async (predicate, timeout = 3000) => {
        const deadline = Date.now() + timeout
        while (Date.now() < deadline) {
          const value = predicate()
          if (value) return value
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
      }
      const editButton = await waitFor(() =>
        Array.from(document.querySelectorAll('button')).find((button) =>
          /^(Edit text|修改|编辑)$/.test(
            (button.getAttribute('aria-label') || button.title || '').trim(),
          ),
        ),
      )
      if (!editButton) throw new Error('edit button did not appear')
      editButton?.click()
      const textarea = await waitFor(() =>
        document.querySelector('textarea[name="replacement"]'),
      )
      if (!textarea) throw new Error('edit textarea did not open')
      textarea.value = replacementText
      textarea.dispatchEvent(new Event('input', { bubbles: true }))

      const saveButton = Array.from(document.querySelectorAll('button')).find(
        (button) => /^(Save|保存)$/.test(button.textContent?.trim() || ''),
      )
      if (!saveButton) throw new Error('save button not found')
      saveButton?.click()
      document.elementFromPoint(20, 20)?.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          clientX: 20,
          clientY: 20,
        }),
      )
      const textareaDuringImmediateOutsideClick = document.querySelector(
        'textarea[name="replacement"]',
      )
      const stillOpenDuringSave = !!textareaDuringImmediateOutsideClick

      await waitFor(
        () => !document.querySelector('textarea[name="replacement"]'),
        5000,
      )

      return {
        stillOpenDuringSave,
        finalOpen: !!document.querySelector('textarea[name="replacement"]'),
        bodyText: doc.body.innerText,
      }
    },
    { currentText: newText, replacementText: oldText },
  )

  assert(
    lockResult.stillOpenDuringSave,
    'edit menu closed while replacement save was pending',
    lockResult,
  )
  assert(
    !lockResult.finalOpen,
    'edit menu did not close after save completed',
    lockResult,
  )

  const report = {
    ok: true,
    bookId: book.id,
    sourcePath,
    target: result.target,
    nodeText: result.nodeText,
    replaceMs: result.replaceMs,
    patchMs: result.patchMs,
    deepChapterCount,
    deepReplaceMs,
    savingOverlayLock: lockResult.stillOpenDuringSave,
  }
  fs.writeFileSync(
    path.join(OUT_DIR, 'result.json'),
    JSON.stringify(report, null, 2),
  )
  console.log(JSON.stringify(report, null, 2))
  await browser.close()
}

main().catch((error) => {
  console.error(error)
  if (error.detail) console.error(JSON.stringify(error.detail, null, 2))
  process.exit(1)
})
