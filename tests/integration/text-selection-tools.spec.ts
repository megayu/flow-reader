import { expect, type Locator, type Page, test } from '@playwright/test'

import type { LocalDictionaryRecord } from '../../src/dictionary/native'
import type { BookRecord } from '../../src/storage'
import { createTestBook } from '../support/book-fixtures'
import { epubFixturePackageUrl, installEpubFixtureRoutes } from '../support/epub-fixture'
import { msg } from '../support/i18n'
import { selectReaderTextAndOpenMenu } from '../support/reader-selection'
import { getDictionaryMockState, installTauriMock } from '../support/tauri-mock'

function iconButton(container: Locator, icon: string) {
  return container.locator(`button:has(svg.lucide-${icon})`)
}

const characterHtml = `<!doctype html><html><body>
  <section id="jbjs" data-section="基本解释">
    <div class="jbjs-reading">
      <div class="jbjs-reading__py">tiān</div>
      <ol class="jbjs-list">
        <li class="jbjs-item"><span class="jbjs-item__def">高处的空间。</span><span class="jbjs-item__eg">例如：仰望天空。</span></li>
        <li class="jbjs-item"><span class="jbjs-item__def">时间单位。</span></li>
      </ol>
    </div>
    <div class="jbjs-reading">
      <div class="jbjs-reading__py">tiàn</div>
      <ol class="jbjs-list"><li class="jbjs-item"><span class="jbjs-item__def">合成测试的第二读音。</span></li></ol>
    </div>
  </section>
  <section id="xxjs" data-section="详细解释"><ol><li>不应显示的详细解释</li></ol></section>
</body></html>`

const wordHtml = `<!doctype html><html><body>
  <section id="xxjs" data-section="详细解释"><ol class="xxjs-list"><li>不应显示的详细解释</li></ol></section>
  <section id="xxjs" data-section="词语解释">
    <div class="dict-section__body">
      <div class="sense-group">
        <div class="xxjs-reading-head"><span class="xxjs-reading__word">天空</span><span class="xxjs-reading__py">tiān kōng</span></div>
        <ol class="xxjs-list">
          <li class="xxjs-item"><span class="xxjs-item__def">地面以上的广阔空间。</span><span class="xxjs-item__eg">晴朗的天空。</span></li>
          <li class="xxjs-item xxjs-item--nonum"><span class="xxjs-item__def">合成的无编号补充。</span></li>
        </ol>
        <div class="xxjs-reading-head"><span class="xxjs-reading__py">tiān kòng</span></div>
        <ol class="xxjs-list"><li class="xxjs-item"><span class="xxjs-item__def">合成的另一读音。</span></li></ol>
      </div>
    </div>
  </section>
  <section id="cyjs" data-section="成语解释"><ol><li>不应显示的成语解释</li></ol></section>
</body></html>`

const modernWordHtml = `<!doctype html><html><body>
  <section id="xxjs" data-section="词语解释">
    <div class="dict-section__body">
      <div class="sense-group">
        <div class="xxjs-reading-head"><span class="xxjs-reading__word">样词</span><span class="xxjs-reading__py">yàng cí</span></div>
        <ol class="xxjs-list">
          <li class="xxjs-item">
            <div class="xxjs-item__def">合成的新版释义。</div>
            <div class="xxjs-also"><span class="xxjs-block-label xxjs-block-label--also">例如</span><span class="xxjs-also__text">这是合成的中文例句。</span></div>
            <div class="xxjs-english"><span class="xxjs-block-label xxjs-block-label--en">英文</span><span class="xxjs-english__text">synthetic English gloss</span></div>
          </li>
        </ol>
      </div>
    </div>
  </section>
</body></html>`

function dictionaryBook(language = 'zh-CN'): BookRecord {
  return createTestBook({
    id: 'dictionary-book',
    name: 'Dictionary Fixture.epub',
    size: 128000,
    metadata: {
      title: 'Dictionary Fixture',
      creator: 'Flow Test',
      language,
    },
    createdAt: 1,
    updatedAt: 1,
    cfi: 'chapter_001.xhtml',
    definitions: [],
    annotations: [],
  })
}

async function setupDictionaryReader(
  page: Page,
  zdicResponses: Record<string, string>,
  zdicResponseDelayMs = 0,
  merriamWebsterResponses: Record<string, unknown> = {},
  localDictionaries: LocalDictionaryRecord[] = [],
  stardictResponses: Record<string, Record<string, unknown>> = {},
  mdictResponses: Record<string, Record<string, unknown>> = {},
  mdictStylesheets: Record<string, Record<string, string>> = {},
  bookLanguage = 'zh-CN',
  zdicResponseSequences: Record<string, string[]> = {},
  zdicResponseStatuses: Record<string, number> = {},
  translationOptions: { delayMs?: number; error?: string } = {},
) {
  await installEpubFixtureRoutes(page)
  await installTauriMock(page, {
    books: [dictionaryBook(bookLanguage)],
    readerSources: { 'dictionary-book': epubFixturePackageUrl },
    settings: {
      dictionary: {
        zdic: { enabled: true },
        merriamWebster: {
          apiKey: Object.keys(merriamWebsterResponses).length ? 'test-only-mw-key' : '',
          enabled: Object.keys(merriamWebsterResponses).length > 0,
        },
      },
      enableTextSelectionMenu: true,
    },
    merriamWebsterResponses,
    localDictionaries,
    mdictResponses,
    mdictStylesheets,
    stardictResponses,
    zdicResponses,
    zdicResponseSequences,
    zdicResponseStatuses,
    zdicResponseDelayMs,
    translationResponseDelayMs: translationOptions.delayMs,
    translationError: translationOptions.error,
  })
  await page.goto('/')
  await page.locator('ul.grid [data-flow-library-book-card]').filter({ hasText: 'Dictionary Fixture' }).click()
  await expect
    .poll(() =>
      page.evaluate(() => {
        const pane = document.querySelector('[data-flow-reader-pane][aria-hidden="false"]')
        return Array.from(pane?.querySelectorAll('iframe') ?? []).some(
          (frame) =>
            frame.getBoundingClientRect().width > 0 && Boolean((frame as HTMLIFrameElement).contentDocument?.body),
        )
      }),
    )
    .toBe(true)
}

async function setupTranslationReader(page: Page, options: { delayMs?: number; error?: string } = {}) {
  return setupDictionaryReader(page, {}, 0, {}, [], {}, {}, {}, 'zh-CN', {}, {}, options)
}

interface SpeechVoiceFixture {
  default?: boolean
  lang: string
  name: string
}

async function installSpeechSynthesisMock(
  page: Page,
  options: { supported?: boolean; voices?: SpeechVoiceFixture[] } = {},
) {
  await page.addInitScript(
    ({ supported, voices }) => {
      type TestUtterance = {
        lang: string
        onend: ((event: Event) => void) | null
        onerror: ((event: Event) => void) | null
        text: string
        voice: SpeechVoiceFixture | null
      }
      type SpeechTestState = {
        cancelCalls: number
        endLatest: () => void
        errorLatest: () => void
        events: string[]
        speakCalls: Array<{ lang: string; text: string; voiceName?: string }>
        setVoices: (voices: SpeechVoiceFixture[]) => void
      }
      const testWindow = window as typeof window & {
        __FLOW_TEST_SPEECH__?: SpeechTestState
      }

      if (!supported) {
        Object.defineProperty(window, 'speechSynthesis', {
          configurable: true,
          value: undefined,
        })
        Object.defineProperty(window, 'SpeechSynthesisUtterance', {
          configurable: true,
          value: undefined,
        })
        return
      }

      let latest: TestUtterance | undefined
      let currentVoices = voices
      const voiceListeners = new Set<EventListenerOrEventListenerObject>()
      class TestSpeechSynthesisUtterance implements TestUtterance {
        lang = ''
        onend: ((event: Event) => void) | null = null
        onerror: ((event: Event) => void) | null = null
        text: string
        voice: SpeechVoiceFixture | null = null

        constructor(text: string) {
          this.text = text
        }
      }
      const state: SpeechTestState = {
        cancelCalls: 0,
        endLatest() {
          latest?.onend?.(new Event('end'))
        },
        errorLatest() {
          latest?.onerror?.(new Event('error'))
        },
        events: [],
        setVoices(nextVoices) {
          currentVoices = nextVoices
          const event = new Event('voiceschanged')
          voiceListeners.forEach((listener) => {
            if (typeof listener === 'function') listener(event)
            else listener.handleEvent(event)
          })
        },
        speakCalls: [],
      }
      Object.defineProperty(window, 'SpeechSynthesisUtterance', {
        configurable: true,
        value: TestSpeechSynthesisUtterance,
      })
      Object.defineProperty(window, 'speechSynthesis', {
        configurable: true,
        value: {
          addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
            if (type === 'voiceschanged') voiceListeners.add(listener)
          },
          cancel() {
            state.cancelCalls += 1
            state.events.push('cancel')
          },
          getVoices() {
            return currentVoices.map((voice) => ({
              default: voice.default ?? false,
              lang: voice.lang,
              localService: true,
              name: voice.name,
              voiceURI: voice.name,
            }))
          },
          removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
            if (type === 'voiceschanged') voiceListeners.delete(listener)
          },
          speak(utterance: TestUtterance) {
            latest = utterance
            state.events.push('speak')
            state.speakCalls.push({
              lang: utterance.lang,
              text: utterance.text,
              voiceName: utterance.voice?.name,
            })
          },
        },
      })
      testWindow.__FLOW_TEST_SPEECH__ = state
    },
    {
      supported: options.supported !== false,
      voices: options.voices ?? [],
    },
  )
}

async function speechState(page: Page) {
  return page.evaluate(() => {
    const state = (
      window as typeof window & {
        __FLOW_TEST_SPEECH__?: {
          cancelCalls: number
          events: string[]
          speakCalls: Array<{
            lang: string
            text: string
            voiceName?: string
          }>
        }
      }
    ).__FLOW_TEST_SPEECH__
    return state
      ? {
          cancelCalls: state.cancelCalls,
          events: [...state.events],
          speakCalls: [...state.speakCalls],
        }
      : undefined
  })
}

function dictionaryBackButton(page: Page) {
  return page.locator('[data-flow-dictionary-popup] header').getByRole('button').first()
}

function dictionaryCloseButton(page: Page) {
  return page.locator('[data-flow-dictionary-popup] header').getByRole('button').last()
}

function dictionaryPopup(page: Page) {
  return page.locator('[data-flow-dictionary-popup="true"]')
}

function dictionarySpeechButton(page: Page) {
  return page
    .locator('[data-flow-dictionary-popup] header')
    .locator('button:has(.lucide-volume-2), button:has(.lucide-square)')
}

async function finishSpeech(page: Page, outcome: 'end' | 'error') {
  await page.evaluate((nextOutcome) => {
    const state = (
      window as typeof window & {
        __FLOW_TEST_SPEECH__?: {
          endLatest: () => void
          errorLatest: () => void
        }
      }
    ).__FLOW_TEST_SPEECH__
    if (nextOutcome === 'end') state?.endLatest()
    else state?.errorLatest()
  }, outcome)
}

function localStarDict(): LocalDictionaryRecord {
  return {
    createdAt: 1,
    enabled: true,
    fingerprint: { modifiedMs: 1, sampleHash: 'fixture', size: 1 },
    format: 'stardict',
    id: 'dict-oxford',
    language: { source: 'manual', value: ['en'] },
    name: 'Oxford English-Chinese Dictionary',
    order: 0,
    sourcePath: 'fixture-english.ifo',
    sourceStatus: 'available',
    updatedAt: 1,
  }
}

function localMdict(): LocalDictionaryRecord {
  return {
    createdAt: 1,
    enabled: true,
    fingerprint: { modifiedMs: 1, sampleHash: 'fixture', size: 1 },
    format: 'mdict',
    id: 'dict-synthetic-zh',
    language: { source: 'manual', value: ['zh'] },
    name: 'Synthetic Chinese MDict',
    order: 0,
    sourcePath: 'fixture-chinese.mdx',
    sourceStatus: 'available',
    updatedAt: 1,
  }
}

function merriamWebsterEntry(query: string, definitions: readonly string[]) {
  return [
    {
      def: [
        {
          sseq: definitions.map((definition, index) => [
            [
              'sense',
              {
                dt: [['text', `{bc}${definition}`]],
                sn: String(index + 1),
              },
            ],
          ]),
        },
      ],
      fl: 'noun',
      hwi: { hw: query },
      meta: { id: `${query}:1`, stems: [query] },
    },
  ]
}

function starDictEntry(query: string, definitions: readonly string[]) {
  return {
    entries: [{ definitions, headword: query }],
  }
}

async function selectFixtureText(page: Page, query: string, expectDictionary = true) {
  await page.evaluate((selectedText) => {
    const pane = document.querySelector('[data-flow-reader-pane][aria-hidden="false"]')
    const frame = Array.from(pane?.querySelectorAll('iframe') ?? []).find(
      (candidate) => candidate.getBoundingClientRect().width > 0,
    ) as HTMLIFrameElement | undefined
    const doc = frame?.contentDocument
    if (!frame?.contentWindow || !doc?.body) {
      throw new Error('Missing dictionary selection frame')
    }

    const target = doc.createElement('span')
    target.id = 'dictionary-selection-target'
    target.textContent = selectedText
    doc.body.prepend(target)
  }, query)
  await selectReaderTextAndOpenMenu(page, { targetSelector: '#dictionary-selection-target' })
  await expect(page.getByRole('button', { name: msg('menu.copy') })).toBeVisible()
  if (expectDictionary) {
    await expect(page.getByRole('button', { name: msg('menu.dictionary'), exact: true })).toBeVisible()
  }
}

test('limits cross-paragraph highlights to rendered text', async ({ page }) => {
  await setupDictionaryReader(page, {})

  await page.evaluate(() => {
    const tab = (window as any).reader.focusedBookTab
    const doc = tab?.iframe?.document as Document | undefined
    const frameWindow = doc?.defaultView
    if (!doc?.body || !frameWindow) throw new Error('Missing active reader document')

    doc.body.innerHTML =
      '<section><p style="width: 400px">&nbsp;&nbsp;&nbsp;alpha</p><p style="width: 400px">beta</p><p style="width: 400px">gamma</p><p style="width: 400px">delta&nbsp;&nbsp;&nbsp;</p></section>'
    const paragraphs = Array.from(doc.querySelectorAll('p'))
    const start = paragraphs[0]?.firstChild
    const end = paragraphs.at(-1)?.firstChild
    if (!start?.textContent || !end?.textContent) throw new Error('Missing selection text')

    const range = doc.createRange()
    range.setStart(start, 0)
    range.setEnd(end, end.textContent.length)
    const selection = frameWindow.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    const rect = range.getBoundingClientRect()
    doc.body.dispatchEvent(
      new frameWindow.MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: rect.left + rect.width / 2,
        clientY: rect.bottom,
      }),
    )
  })

  await page.getByRole('button', { name: 'yellow', exact: true }).click()
  await expect
    .poll(() =>
      page.evaluate(() => {
        const tab = (window as any).reader.focusedBookTab
        return tab?.book?.annotations?.[0]?.text
      }),
    )
    .toBe('alphabetagammadelta')

  const widths = await page.evaluate(() => {
    const tab = (window as any).reader.focusedBookTab
    const doc = tab?.iframe?.document as Document | undefined
    if (!doc) throw new Error('Missing active reader document')

    const textWidths = Array.from(doc.querySelectorAll('p')).map((paragraph) => {
      const node = paragraph.firstChild
      const text = node?.textContent ?? ''
      const start = text.search(/\S/)
      const end = text.search(/\s*$/)
      if (!node || start < 0 || end <= start) throw new Error('Missing paragraph text')

      const range = doc.createRange()
      range.setStart(node, start)
      range.setEnd(node, end)
      return range.getBoundingClientRect().width
    })
    const highlightWidths = Array.from(document.querySelectorAll<SVGRectElement>('g[ref="epubjs-hl"] rect')).map(
      (rect) => rect.getBoundingClientRect().width,
    )
    return { highlightWidths, textWidths }
  })

  expect(widths.highlightWidths.length).toBeGreaterThan(0)
  expect(Math.max(...widths.highlightWidths)).toBeLessThanOrEqual(Math.max(...widths.textWidths) + 1)
})

test('selection speech reads Chinese with the matching system voice and toggles stop', async ({ page }) => {
  await installSpeechSynthesisMock(page, {
    voices: [
      { default: true, lang: 'en-US', name: 'System English' },
      { lang: 'zh-CN', name: 'System Chinese' },
    ],
  })
  await setupDictionaryReader(page, { 测试: wordHtml })
  await selectFixtureText(page, '测试')
  await page.getByRole('button', { name: msg('menu.dictionary'), exact: true }).click()

  const speak = dictionarySpeechButton(page)
  await speak.focus()
  await speak.press('Enter')

  await expect(speak).toHaveAttribute('aria-pressed', 'true')
  await expect
    .poll(() => speechState(page))
    .toEqual({
      cancelCalls: 1,
      events: ['cancel', 'speak'],
      speakCalls: [
        {
          lang: 'zh-CN',
          text: '测试',
          voiceName: 'System Chinese',
        },
      ],
    })

  await speak.click()
  await expect(speak).toHaveAttribute('aria-pressed', 'false')
  await expect.poll(() => speechState(page)).toMatchObject({ cancelCalls: 2 })
})

test('prefers the default voice for the detected language and resets after an error', async ({ page }) => {
  await installSpeechSynthesisMock(page, {
    voices: [
      { default: true, lang: 'en-US', name: 'System American' },
      { lang: 'en-GB', name: 'System British' },
    ],
  })
  await setupDictionaryReader(page, {}, 0, { sample: [] }, [], {}, {}, {}, 'en-GB')
  await selectFixtureText(page, 'sample')
  await page.getByRole('button', { name: msg('menu.dictionary'), exact: true }).click()
  const speak = dictionarySpeechButton(page)
  await speak.click()

  await expect
    .poll(() => speechState(page))
    .toMatchObject({
      speakCalls: [
        {
          lang: 'en-US',
          text: 'sample',
          voiceName: 'System American',
        },
      ],
    })
  await finishSpeech(page, 'error')
  await expect(speak).toHaveAttribute('aria-pressed', 'false')
})

test('selection speech falls back to a same-language voice when no exact locale exists', async ({ page }) => {
  await installSpeechSynthesisMock(page, {
    voices: [{ lang: 'en-US', name: 'System English' }],
  })
  await setupDictionaryReader(page, {}, 0, { sample: [] }, [], {}, {}, {}, 'en-AU')
  await selectFixtureText(page, 'sample')
  await page.getByRole('button', { name: msg('menu.dictionary'), exact: true }).click()
  const speak = dictionarySpeechButton(page)
  await speak.click()

  await expect
    .poll(() => speechState(page))
    .toMatchObject({
      speakCalls: [
        {
          lang: 'en-US',
          text: 'sample',
          voiceName: 'System English',
        },
      ],
    })
  await finishSpeech(page, 'end')
  await expect(speak).toHaveAttribute('aria-pressed', 'false')
})

test('selection speech is hidden when the system API is unavailable', async ({ page }) => {
  await installSpeechSynthesisMock(page, { supported: false })
  await setupDictionaryReader(page, { 测试: wordHtml })
  await selectFixtureText(page, '测试')
  await page.getByRole('button', { name: msg('menu.dictionary'), exact: true }).click()

  const unavailable = dictionarySpeechButton(page)
  await expect(unavailable).toHaveCount(0)
})

test('selection speech reacts when the system voice list becomes available', async ({ page }) => {
  await installSpeechSynthesisMock(page)
  await setupDictionaryReader(page, { 测试: wordHtml })
  await selectFixtureText(page, '测试')
  await page.getByRole('button', { name: msg('menu.dictionary'), exact: true }).click()

  const speak = dictionarySpeechButton(page)
  await expect(speak).toHaveCount(0)
  await page.evaluate(() => {
    const state = (
      window as typeof window & {
        __FLOW_TEST_SPEECH__?: {
          setVoices: (voices: SpeechVoiceFixture[]) => void
        }
      }
    ).__FLOW_TEST_SPEECH__
    state?.setVoices([{ lang: 'zh-CN', name: 'Installed Chinese' }])
  })
  await expect(speak).toBeVisible()
})

test('stops active speech on every dictionary popup exit path', async ({ page }) => {
  await installSpeechSynthesisMock(page, {
    voices: [{ lang: 'zh-CN', name: 'System Chinese' }],
  })
  await setupDictionaryReader(page, { 测试: wordHtml })
  await selectFixtureText(page, '测试')

  const openDictionary = async () => {
    await page.getByRole('button', { name: msg('menu.dictionary'), exact: true }).click()
    await dictionarySpeechButton(page).click()
  }

  await openDictionary()
  await dictionaryBackButton(page).click()
  await expect.poll(() => speechState(page)).toMatchObject({ cancelCalls: 2 })

  await openDictionary()
  await page.mouse.click(2, 2)
  await expect.poll(() => speechState(page)).toMatchObject({ cancelCalls: 4 })

  await openDictionary()
  await dictionaryCloseButton(page).click()
  await expect.poll(() => speechState(page)).toMatchObject({ cancelCalls: 6 })
  await expect(page.getByRole('button', { name: msg('menu.copy') })).toHaveCount(0)
})

test('opens the compact translation popup and Escape returns to the text menu', async ({ page }) => {
  await setupTranslationReader(page, { delayMs: 150 })
  await selectFixtureText(page, 'sample')

  await page.getByRole('button', { name: msg('menu.translate'), exact: true }).click()
  const popup = page.locator('[data-flow-translation-popup="true"]')
  await expect(popup).toBeVisible()
  await expect(popup.getByRole('combobox').nth(0)).toContainText(msg('translation.auto_detect'))
  await expect(iconButton(popup, 'copy')).toBeDisabled()
  await expect(popup.getByText('Google: sample', { exact: true })).toBeVisible()
  await expect(iconButton(popup, 'copy')).toBeEnabled()
  await expect(popup.locator('[data-flow-translation-splitter]')).toBeVisible()
  await expect(popup).toHaveCSS('width', '600px')
  await expect(page.getByRole('tooltip')).toHaveCount(0)
  const compactGeometry = await popup.evaluate((element) => {
    const source = element.querySelector('[data-flow-translation-source]')
    const result = element.querySelector('[data-flow-translation-result]')
    if (!(source instanceof HTMLElement) || !(result instanceof HTMLElement)) {
      throw new Error('Missing translation regions')
    }
    const sourceStyle = getComputedStyle(source)
    const resultStyle = getComputedStyle(result)
    return {
      height: element.getBoundingClientRect().height,
      resultPadding: [resultStyle.paddingTop, resultStyle.paddingBottom],
      sourcePadding: [sourceStyle.paddingTop, sourceStyle.paddingBottom],
    }
  })
  expect(compactGeometry.height).toBeLessThan(150)
  expect(compactGeometry.sourcePadding).toEqual(['8px', '8px'])
  expect(compactGeometry.resultPadding).toEqual(['8px', '8px'])
  const toolbarGeometry = await popup.locator('[data-flow-translation-toolbar]').evaluate((toolbar) => {
    const toolbarRect = toolbar.getBoundingClientRect()
    const controls = Array.from(toolbar.querySelectorAll('button, [role="combobox"]')).map((control) =>
      control.getBoundingClientRect(),
    )
    return {
      height: toolbarRect.height,
      oneRow: controls.every((control) => control.top >= toolbarRect.top && control.bottom <= toolbarRect.bottom),
    }
  })
  expect(toolbarGeometry).toEqual({ height: 40, oneRow: true })

  await page.keyboard.press('Escape')
  await expect(popup).toHaveCount(0)
  await expect(page.getByRole('button', { name: msg('menu.copy') })).toBeVisible()
})

test('switches translation providers in place', async ({ page }) => {
  await setupTranslationReader(page)
  await selectFixtureText(page, 'sample')
  await page.getByRole('button', { name: msg('menu.translate'), exact: true }).click()

  const popup = page.locator('[data-flow-translation-popup="true"]')
  await popup.getByRole('button', { name: 'Azure', exact: true }).click()
  await expect(popup.getByText('Azure: sample', { exact: true })).toBeVisible()
})

test('allows copying and retrying a failed translation record', async ({ page }) => {
  await setupTranslationReader(page, {
    delayMs: 150,
    error: 'Synthetic translation failure',
  })
  await selectFixtureText(page, 'sample')
  await page.getByRole('button', { name: msg('menu.translate'), exact: true }).click()

  const popup = page.locator('[data-flow-translation-popup="true"]')
  await expect(popup.getByText('Synthetic translation failure')).toBeVisible()
  await expect(iconButton(popup, 'copy')).toBeEnabled()
  const errorRow = popup.getByText('Synthetic translation failure').locator('..')
  const retryButton = iconButton(errorRow, 'refresh-cw')
  const errorAlignment = await retryButton.evaluate((button) => {
    const row = button.parentElement
    const text = row?.querySelector('span')
    if (!row || !text) throw new Error('Missing translation error row')
    const buttonRect = button.getBoundingClientRect()
    const textRect = text.getBoundingClientRect()
    return {
      alignItems: getComputedStyle(row).alignItems,
      buttonColor: getComputedStyle(button).color,
      textColor: getComputedStyle(text).color,
      centerDelta: Math.abs(buttonRect.top + buttonRect.height / 2 - (textRect.top + textRect.height / 2)),
    }
  })
  expect(errorAlignment.alignItems).toBe('center')
  expect(errorAlignment.buttonColor).not.toBe(errorAlignment.textColor)
  expect(errorAlignment.centerDelta).toBeLessThanOrEqual(1)
  await retryButton.click()
  await expect(iconButton(popup, 'copy')).toBeDisabled()
  await expect(popup.getByText('Synthetic translation failure')).toBeVisible()
})

test('resizes the source and translation regions with the splitter', async ({ page }) => {
  await setupTranslationReader(page)
  await selectFixtureText(page, 'synthetic text '.repeat(100), false)
  await page.getByRole('button', { name: msg('menu.translate'), exact: true }).click()

  const popup = page.locator('[data-flow-translation-popup="true"]')
  await expect(popup.getByText(/Google: synthetic text/)).toBeVisible()
  const source = popup.locator('[data-flow-translation-source]')
  const splitter = popup.locator('[data-flow-translation-splitter]')
  const before = await source.boundingBox()
  const handle = await splitter.boundingBox()
  if (!before || !handle) throw new Error('Missing translation split geometry')
  const popupBottom = await popup.evaluate((element) => element.getBoundingClientRect().bottom)
  expect(popupBottom).toBeLessThanOrEqual(await page.evaluate(() => innerHeight))
  const allocation = await popup.evaluate((element) => {
    const source = element.querySelector('[data-flow-translation-source]')
    const result = element.querySelector('[data-flow-translation-result]')
    if (!(source instanceof HTMLElement) || !(result instanceof HTMLElement)) {
      throw new Error('Missing translation regions')
    }
    return {
      resultFullyVisible: result.scrollHeight <= result.clientHeight,
      sourceScrolls: source.scrollHeight > source.clientHeight,
    }
  })
  expect(allocation).toEqual({ resultFullyVisible: true, sourceScrolls: true })

  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
  await page.mouse.down()
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2 + 30)
  await page.mouse.up()

  const after = await source.boundingBox()
  expect(after?.height).toBeGreaterThan(before.height)
})

test('keeps the dictionary action disabled when no source matches the selection', async ({ page }) => {
  await setupDictionaryReader(page, {})
  await selectFixtureText(page, 'sky', false)

  await expect(page.getByRole('button', { name: msg('menu.dictionary'), exact: true })).toBeDisabled()
  expect((await getDictionaryMockState(page)).dictionaryRequests).toEqual([])
})

test('parses only the first Han Dian character explanation into semantic groups', async ({ page }) => {
  await setupDictionaryReader(page, { 天: characterHtml })
  await selectFixtureText(page, '天')
  await page.getByRole('button', { name: msg('menu.dictionary'), exact: true }).click()

  const popup = dictionaryPopup(page)
  await expect(popup).toBeVisible()
  await expect(popup.getByText('tiān', { exact: true })).toBeVisible()
  await expect(popup.getByText('tiàn', { exact: true })).toBeVisible()
  await expect(popup.getByText('高处的空间。', { exact: true })).toBeVisible()
  await expect(popup.getByText('例如：仰望天空。', { exact: true })).toBeVisible()
  await expect(popup.getByText('不应显示的详细解释')).toHaveCount(0)
  await expect(popup.locator('[data-dictionary-sense-marker]')).toHaveText(['1', '2', '1'])
})

test('copies a dictionary body selection instead of the original book selection', async ({ page }) => {
  await setupDictionaryReader(page, { 天: characterHtml })
  await selectFixtureText(page, '天')
  await page.getByRole('button', { name: msg('menu.dictionary'), exact: true }).click()

  const popup = dictionaryPopup(page)
  const definition = popup.getByText('高处的空间。', { exact: true })
  await expect(definition).toBeVisible()
  await definition.evaluate((element) => {
    const selection = window.getSelection()
    const range = document.createRange()
    range.selectNodeContents(element)
    selection?.removeAllRanges()
    selection?.addRange(range)
  })
  await popup.focus()
  await page.keyboard.press('Control+c')

  await page.evaluate(() => {
    const target = document.createElement('textarea')
    target.id = 'clipboard-paste-target'
    document.body.append(target)
    target.focus()
  })
  const pasteTarget = page.locator('#clipboard-paste-target')
  await page.keyboard.press('Control+v')
  await expect(pasteTarget).toHaveValue('高处的空间。')
})

test('parses adjacent Han Dian word reading groups and respects unnumbered senses', async ({ page }) => {
  await setupDictionaryReader(page, { 天空: wordHtml })
  await selectFixtureText(page, '天空')
  await page.getByRole('button', { name: msg('menu.dictionary'), exact: true }).click()

  const popup = dictionaryPopup(page)
  await expect(popup.getByText('tiān kōng', { exact: true })).toBeVisible()
  await expect(popup.getByText('tiān kòng', { exact: true })).toBeVisible()
  await expect(popup.getByText('地面以上的广阔空间。', { exact: true })).toBeVisible()
  await expect(popup.getByText('合成的无编号补充。')).toBeVisible()
  await expect(popup.getByText('不应显示的详细解释')).toHaveCount(0)
  await expect(popup.getByText('不应显示的成语解释')).toHaveCount(0)
  await expect(popup.locator('[data-dictionary-sense-marker]')).toHaveText(['1', '1'])
})

test('keeps modern Han Dian Chinese examples while excluding English glosses', async ({ page }) => {
  await setupDictionaryReader(page, { 样词: modernWordHtml })
  await selectFixtureText(page, '样词')
  await page.getByRole('button', { name: msg('menu.dictionary'), exact: true }).click()

  const popup = dictionaryPopup(page)
  await expect(popup.getByText('合成的新版释义。', { exact: true })).toBeVisible()
  await expect(popup.getByText('这是合成的中文例句。', { exact: true })).toBeVisible()
  await expect(popup.getByText('synthetic English gloss')).toHaveCount(0)
  await expect(popup.getByText('英文', { exact: true })).toHaveCount(0)
})

test('falls back to cleaned item text without exposing active or raw HTML', async ({ page }) => {
  const fallbackHtml = `<!doctype html><html><body>
    <section id="jbjs" data-section="基本解释">
      <div class="jbjs-reading"><div class="jbjs-reading__py">cè</div><ol class="jbjs-list">
        <li class="jbjs-item" onclick="alert(1)">缺少内部 class 的回退文本<script>危险脚本</script><style>.x{color:red}</style></li>
      </ol></div>
    </section>
  </body></html>`
  await setupDictionaryReader(page, { 测: fallbackHtml })
  await selectFixtureText(page, '测')
  await page.getByRole('button', { name: msg('menu.dictionary'), exact: true }).click()

  const popup = dictionaryPopup(page)
  await expect(popup.getByText('缺少内部 class 的回退文本')).toBeVisible()
  await expect(popup.getByText('危险脚本')).toHaveCount(0)
  await expect(
    popup.locator(
      '[data-dictionary-source-id] script, [data-dictionary-source-id] style, [data-dictionary-source-id] [onclick]',
    ),
  ).toHaveCount(0)
})

test('keeps the source link on parse failure and uses two-stage outside dismissal', async ({ page }) => {
  await setupDictionaryReader(page, {
    词: '<html><body><section data-section="其他解释">无目标区</section></body></html>',
  })
  await selectFixtureText(page, '词')
  await page.getByRole('button', { name: msg('menu.dictionary'), exact: true }).click()

  const popup = dictionaryPopup(page)
  await expect(popup.getByText(msg('dictionary.parse_error'))).toBeVisible()
  await popup.locator('[data-dictionary-external="zdic"]').click()
  await expect
    .poll(async () => (await getDictionaryMockState(page)).openedExternalUrls)
    .toEqual(['https://zdic.net/hans/%E8%AF%8D'])

  await page.mouse.click(2, 2)
  await expect(popup).toBeHidden()
  await expect(page.getByRole('button', { name: msg('menu.dictionary'), exact: true })).toBeVisible()
  await page.mouse.click(2, 2)
  await expect(page.getByRole('button', { name: msg('menu.dictionary'), exact: true })).toBeHidden()
})

test('treats a Han Dian 404 as a compact missing entry without retry', async ({ page }) => {
  await setupDictionaryReader(page, {}, 0, {}, [], {}, {}, {}, 'zh-CN', {}, { 测: 404 })
  await selectFixtureText(page, '测')
  await page.getByRole('button', { name: msg('menu.dictionary'), exact: true }).click()

  const popup = dictionaryPopup(page)
  const section = popup.locator('[data-dictionary-source-id="zdic"]')
  await expect(section.getByText(msg('dictionary.no_result'))).toBeVisible()
  await expect(section.locator('[data-dictionary-retry]')).toHaveCount(0)
  await expect(section.locator('[data-dictionary-external="zdic"]')).toBeVisible()
  expect(await section.evaluate((element) => element.getBoundingClientRect().height)).toBeLessThan(100)
})

test('retries a failed online source without displacing the scrolled dictionary content', async ({ page }) => {
  const localDictionary: LocalDictionaryRecord = {
    ...localStarDict(),
    id: 'dict-synthetic-local',
    language: { source: 'manual', value: ['zh'] },
    name: 'Synthetic Local Dictionary',
  }
  await setupDictionaryReader(
    page,
    {},
    600,
    {},
    [localDictionary],
    {
      'dict-synthetic-local': {
        测: starDictEntry(
          '测',
          Array.from({ length: 24 }, (_, index) => `synthetic local explanation ${index + 1}`),
        ),
      },
    },
    {},
    {},
    'zh-CN',
    {
      测: ['<html><body><p>synthetic unavailable response</p></body></html>', characterHtml],
    },
  )
  await selectFixtureText(page, '测')
  await page.getByRole('button', { name: msg('menu.dictionary'), exact: true }).click()

  const popup = dictionaryPopup(page)
  await expect(popup.getByText(msg('dictionary.parse_error'))).toBeVisible()
  const retry = popup.locator('[data-dictionary-retry="zdic"]')
  const source = popup.locator('[data-dictionary-external="zdic"]')
  await expect(retry).toBeVisible()
  expect(await retry.getAttribute('title')).toBeNull()
  expect(await source.getAttribute('title')).toBeNull()
  await expect(retry).toHaveText('')
  await expect(source).toHaveText('')

  await retry.click()
  await expect(retry).toBeDisabled()
  await expect
    .poll(() => retry.locator('svg').evaluate((icon) => getComputedStyle(icon).animationName))
    .not.toBe('none')

  const readingTarget = popup.getByText('synthetic local explanation 12', {
    exact: true,
  })
  await readingTarget.scrollIntoViewIfNeeded()
  const topBefore = await readingTarget.evaluate((element) => element.getBoundingClientRect().top)

  await expect(popup.getByText('高处的空间。', { exact: true })).toBeVisible()
  await expect(retry).toHaveCount(0)
  const topAfter = await readingTarget.evaluate((element) => element.getBoundingClientRect().top)
  expect(Math.abs(topAfter - topBefore)).toBeLessThanOrEqual(1)
  await expect.poll(async () => (await getDictionaryMockState(page)).dictionaryRequests).toHaveLength(2)
})

test('keeps the external action available while disabling empty source navigation', async ({ page }) => {
  await setupDictionaryReader(page, {}, 0, { sample: [] }, [], {}, {}, {}, 'en-US')
  await selectFixtureText(page, 'sample')
  await page.getByRole('button', { name: msg('menu.dictionary'), exact: true }).click()

  const popup = dictionaryPopup(page)
  const section = popup.locator('[data-dictionary-source-id="merriam-webster"]')
  const sourceButton = popup.getByRole('button', {
    name: 'Merriam-Webster',
    exact: true,
  })
  await expect(section.getByText(msg('dictionary.no_result'))).toBeVisible()
  const source = section.locator('[data-dictionary-external="merriam-webster"]')
  await expect(section.locator('[data-dictionary-retry]')).toHaveCount(0)
  await expect(source).toBeVisible()
  await expect(source).toBeEnabled()
  await expect(sourceButton).toBeDisabled()
  await expect(sourceButton).toHaveAttribute('aria-pressed', 'false')
  expect(await source.getAttribute('title')).toBeNull()
  expect(await section.evaluate((element) => element.getBoundingClientRect().height)).toBeLessThan(100)
})

test('back cancels an active native lookup and restores the action menu', async ({ page }) => {
  await setupDictionaryReader(page, { 天: characterHtml }, 2_000)
  await selectFixtureText(page, '天')
  await page.getByRole('button', { name: msg('menu.dictionary'), exact: true }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await expect.poll(async () => (await getDictionaryMockState(page)).dictionaryRequests.length).toBeGreaterThan(0)
  const latestSessionId = (await getDictionaryMockState(page)).dictionaryRequests.at(-1)!.sessionId
  await dictionaryBackButton(page).click()

  await expect(page.getByRole('button', { name: msg('menu.dictionary'), exact: true })).toBeVisible()
  await expect
    .poll(async () => {
      const state = await getDictionaryMockState(page)
      return state.cancelledDictionarySessions.includes(latestSessionId)
    })
    .toBe(true)
})

test('keeps the larger popup inside a narrow horizontal reader', async ({ page }) => {
  await page.setViewportSize({ width: 620, height: 520 })
  await setupDictionaryReader(page, { 天: characterHtml })
  await selectFixtureText(page, '天')
  await page.getByRole('button', { name: msg('menu.dictionary'), exact: true }).click()

  const popup = dictionaryPopup(page)
  await expect(popup.getByText('高处的空间。', { exact: true })).toBeVisible()
  const geometry = await popup.evaluate((element) => {
    const popupRect = element.getBoundingClientRect()
    const contentRect = element
      .closest('[data-flow-reader-pane]')
      ?.querySelector('[data-flow-reader-content]')
      ?.getBoundingClientRect()
    if (!contentRect) throw new Error('Missing horizontal reader geometry')

    return {
      inside:
        popupRect.left >= contentRect.left &&
        popupRect.right <= contentRect.right &&
        popupRect.top >= contentRect.top &&
        popupRect.bottom <= contentRect.bottom,
      width: popupRect.width,
    }
  })

  expect(geometry).toMatchObject({ inside: true })
  expect(geometry.width).toBeGreaterThan(280)
  await expect(popup.locator('[data-dictionary-scroll]')).toHaveCount(1)
})

test('looks up an English selection only in Merriam-Webster', async ({ page }) => {
  await setupDictionaryReader(page, {}, 0, {
    sky: [
      {
        meta: { id: 'sky:1', stems: ['sky', 'skies'] },
        hom: 1,
        hwi: { hw: 'sky' },
        fl: 'noun',
        def: [
          {
            sseq: [
              [
                [
                  'bs',
                  {
                    sense: {
                      sn: '1 a',
                      dt: [
                        ['text', '{bc}the upper atmosphere seen from earth'],
                        ['vis', [{ t: 'the {wi}sky{/wi} grew dark' }]],
                      ],
                    },
                  },
                ],
                [
                  'pseq',
                  [
                    [
                      'sense',
                      {
                        sn: '(1)',
                        dt: [['text', '{bc}the region above the clouds']],
                      },
                    ],
                    [
                      'sense',
                      {
                        sn: '(2)',
                        dt: [['text', '{bc}weather conditions']],
                      },
                    ],
                  ],
                ],
              ],
              [
                [
                  'sense',
                  {
                    sn: 'b',
                    dt: [['text', '{bc}a place or condition beyond reach {sx|heaven||}']],
                  },
                ],
              ],
              [
                [
                  'sense',
                  {
                    sn: '10 a',
                    dt: [['text', '{bc}a definition with a two-digit number']],
                  },
                ],
              ],
            ],
          },
        ],
      },
      {
        meta: { id: 'sky:2', stems: ['sky', 'skied', 'skying'] },
        hwi: { hw: 'sky' },
        fl: 'verb',
        def: [
          {
            sseq: [[['sense', { dt: [['text', '{bc}to hit high into the air']] }]]],
          },
        ],
      },
      {
        meta: { id: 'sky blue', stems: ['sky blue'] },
        hwi: { hw: 'sky blue' },
        fl: 'adjective',
        def: [
          {
            sseq: [[['sense', { dt: [['text', '{bc}a returned phrase to exclude']] }]]],
          },
        ],
      },
    ],
  })
  await selectFixtureText(page, 'sky')
  await page.getByRole('button', { name: msg('menu.dictionary'), exact: true }).click()

  const popup = dictionaryPopup(page)
  await expect(popup.getByRole('heading', { name: 'Merriam-Webster' })).toBeVisible()
  await expect(popup.getByText('the upper atmosphere seen from earth')).toBeVisible()
  await expect(popup.getByText('the sky grew dark')).toBeVisible()
  await expect(popup.getByText('sky blue', { exact: true })).toHaveCount(0)
  await expect(popup.locator('[data-dictionary-sense-level="1"]')).toHaveCount(2)
  const layout = await popup.locator('article').evaluateAll((articles) => {
    const noun = articles[0]
    const verb = articles[1]
    const markerLefts = (kind: string) =>
      Array.from(noun?.querySelectorAll<HTMLElement>(`[data-dictionary-sense-marker="${kind}"]`) ?? []).map(
        (marker) => marker.getBoundingClientRect().left,
      )
    const definitionLefts = (depth: string) =>
      Array.from(
        noun?.querySelectorAll<HTMLElement>(
          `[data-dictionary-marker-depth="${depth}"] [data-dictionary-sense-content]`,
        ) ?? [],
      ).map((content) => content.getBoundingClientRect().left)
    const verbHeading = verb?.querySelector<HTMLElement>('h3')
    const verbDefinition = verb?.querySelector<HTMLElement>('[data-dictionary-sense-content]')
    const reference = noun?.querySelector<HTMLElement>('[data-dictionary-text-kind="reference"]')
    const referenceContainer = reference?.closest<HTMLElement>('[data-dictionary-sense-content]')
    return {
      definitionLefts: {
        letter: definitionLefts('letter'),
        subnumber: definitionLefts('subnumber'),
      },
      markerLefts: {
        letter: markerLefts('letter'),
        number: markerLefts('number'),
        subnumber: markerLefts('subnumber'),
      },
      referenceColor: reference ? getComputedStyle(reference).color : null,
      referenceContainerColor: referenceContainer ? getComputedStyle(referenceContainer).color : null,
      unnumberedOffset:
        (verbDefinition?.getBoundingClientRect().left ?? 0) - (verbHeading?.getBoundingClientRect().left ?? 0),
    }
  })
  expect(layout.markerLefts.number).toHaveLength(2)
  expect(layout.markerLefts.letter).toHaveLength(3)
  expect(layout.markerLefts.subnumber).toHaveLength(2)
  for (const markerGroup of Object.values(layout.markerLefts)) {
    expect(Math.max(...markerGroup) - Math.min(...markerGroup)).toBeLessThanOrEqual(1)
  }
  for (const definitionGroup of Object.values(layout.definitionLefts)) {
    expect(Math.max(...definitionGroup) - Math.min(...definitionGroup)).toBeLessThanOrEqual(1)
  }
  expect(layout.referenceColor).toBe(layout.referenceContainerColor)
  expect(Math.abs(layout.unnumberedOffset)).toBeLessThanOrEqual(1)
  await expect(popup.getByRole('heading', { name: '汉典' })).toHaveCount(0)
  await popup.locator('[data-dictionary-external="merriam-webster"]').click()

  const state = await getDictionaryMockState(page)
  expect(state.merriamWebsterRequests).toHaveLength(1)
  expect(state.merriamWebsterRequests[0]).toEqual({
    query: 'sky',
    sessionId: expect.any(Number),
  })
  expect(state.openedExternalUrls).toEqual(['https://www.merriam-webster.com/dictionary/sky'])
})

test('keeps empty dictionary sources visible beside successful results', async ({ page }) => {
  await setupDictionaryReader(
    page,
    {},
    0,
    { sample: [] },
    [localStarDict()],
    {
      'dict-oxford': {
        sample: starDictEntry('sample', ['a synthetic local explanation']),
      },
    },
    {},
    {},
    'en-US',
  )
  await selectFixtureText(page, 'sample')
  await page.getByRole('button', { name: msg('menu.dictionary'), exact: true }).click()

  const popup = dictionaryPopup(page)
  await expect(popup.getByText('a synthetic local explanation', { exact: true })).toBeVisible()
  await expect(popup.getByRole('heading', { name: 'Merriam-Webster', exact: true })).toBeVisible()
  await expect(popup.getByText(msg('dictionary.no_result'), { exact: true })).toBeVisible()
  const empty = popup.getByRole('button', {
    name: 'Merriam-Webster',
    exact: true,
  })
  const successful = popup.getByRole('button', {
    name: 'Oxford English-Chinese Dictionary',
    exact: true,
  })
  await expect(empty).toBeDisabled()
  await expect(empty).toHaveAttribute('aria-pressed', 'false')
  await expect(successful).toBeEnabled()
  await expect(successful).toHaveAttribute('aria-pressed', 'true')
})

test('uses fixed source buttons to locate flat results and track scrolling', async ({ page }) => {
  const onlineDefinitions = Array.from({ length: 18 }, (_, index) => `synthetic online explanation ${index + 1}`)
  await setupDictionaryReader(
    page,
    {},
    0,
    {
      sample: merriamWebsterEntry('sample', onlineDefinitions),
    },
    [localStarDict()],
    {
      'dict-oxford': {
        sample: starDictEntry(
          'sample',
          Array.from({ length: 18 }, (_, index) => `synthetic local explanation ${index + 1}`),
        ),
      },
    },
    {},
    {},
    'en-US',
  )
  await selectFixtureText(page, 'sample')
  await page.getByRole('button', { name: msg('menu.dictionary'), exact: true }).click()

  const popup = dictionaryPopup(page)
  const online = popup.getByRole('button', {
    name: 'Merriam-Webster',
    exact: true,
  })
  const local = popup.getByRole('button', {
    name: 'Oxford English-Chinese Dictionary',
    exact: true,
  })
  await expect(online).toHaveAttribute('aria-pressed', 'true')
  await expect(local).toHaveAttribute('aria-pressed', 'false')
  await expect(popup.locator('[data-dictionary-current-source]')).toHaveText('Merriam-Webster')
  await expect(popup.getByText('synthetic online explanation 1', { exact: true })).toBeVisible()
  await expect(popup.getByText('synthetic local explanation 1', { exact: true })).toBeAttached()

  await local.click()
  await expect(online).toHaveAttribute('aria-pressed', 'false')
  await expect(local).toHaveAttribute('aria-pressed', 'true')
  await expect(popup.locator('[data-dictionary-current-source]')).toHaveText('Oxford English-Chinese Dictionary')
  await expect(popup.getByText('synthetic local explanation 1', { exact: true })).toBeVisible()
  const localHeaderOffset = await popup
    .getByRole('heading', {
      name: 'Oxford English-Chinese Dictionary',
      exact: true,
    })
    .evaluate((heading) => {
      const header = heading.parentElement
      const scroll = heading.closest('[data-dictionary-scroll]')
      if (!header || !scroll) throw new Error('Missing dictionary geometry')
      return header.getBoundingClientRect().bottom - scroll.getBoundingClientRect().top
    })
  expect(localHeaderOffset).toBeLessThanOrEqual(1)

  const scroll = popup.locator('[data-dictionary-scroll]')
  const reservedScrollbarWidth = await scroll.evaluate(
    (element) => element.getBoundingClientRect().width - element.clientWidth,
  )
  expect(reservedScrollbarWidth).toBeLessThanOrEqual(1)
  await scroll.evaluate((element) => {
    element.scrollTop = 0
    element.dispatchEvent(new Event('scroll', { bubbles: true }))
  })
  await expect(online).toHaveAttribute('aria-pressed', 'true')
  await expect(popup.locator('[data-dictionary-current-source]')).toHaveText('Merriam-Webster')
})

test('looks up an English selection in an enabled StarDict and releases its session', async ({ page }) => {
  await setupDictionaryReader(page, {}, 0, {}, [localStarDict()], {
    'dict-oxford': {
      sky: {
        entries: [
          {
            definitions: ['the region of the atmosphere seen from earth'],
            headword: 'sky',
          },
        ],
      },
    },
  })
  await selectFixtureText(page, 'sky')
  await page.getByRole('button', { name: msg('menu.dictionary'), exact: true }).click()

  const popup = page.getByRole('dialog')
  await expect(popup.getByRole('heading', { name: 'Oxford English-Chinese Dictionary' })).toBeVisible()
  await expect(popup.getByText('the region of the atmosphere seen from earth')).toBeVisible()

  await dictionaryCloseButton(page).click()
  await expect.poll(async () => (await getDictionaryMockState(page)).stardictRequests).toHaveLength(1)
  const state = await getDictionaryMockState(page)
  expect(state.stardictRequests[0]).toEqual({
    dictionaryId: 'dict-oxford',
    query: 'sky',
    sessionId: expect.any(Number),
  })
  expect(state.cancelledDictionarySessions).toContain(state.stardictRequests[0]!.sessionId)
})

test('MDict follows an exact mixed-script internal key in the originating dictionary', async ({ page }) => {
  await setupDictionaryReader(
    page,
    {},
    0,
    {},
    [localMdict()],
    {},
    {
      'dict-synthetic-zh': {
        合成查询: {
          entry: {
            headword: '合成查询',
            html: '<a href="entry://internal-42 合成">打开合成索引</a>',
          },
        },
        'internal-42 合成': {
          entry: {
            headword: 'internal-42 合成',
            html: '<h1>合成索引</h1><p>这是合成的内部索引内容。</p>',
          },
        },
      },
    },
  )
  await selectFixtureText(page, '合成查询')
  await page.getByRole('button', { name: msg('menu.dictionary'), exact: true }).click()

  const popup = dictionaryPopup(page)
  const frame = popup.locator('[data-dictionary-rich-content]').contentFrame()
  await frame.getByText('打开合成索引', { exact: true }).click()

  await expect(frame.getByRole('heading', { name: '合成索引' })).toBeVisible()
  await expect(frame.getByText('这是合成的内部索引内容。', { exact: true })).toBeVisible()
})

test('MDict keeps internal links in a source-only bounded detail history', async ({ page }) => {
  await page.route('http://dictionary.localhost/**', async (route) => {
    const url = decodeURIComponent(route.request().url())
    if (url.endsWith('/figure.png') || url.endsWith('/waveline.png')) {
      await route.fulfill({
        body: Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
          'base64',
        ),
        contentType: 'image/png',
      })
      return
    }
    await route.fulfill({ status: 404 })
  })
  const richHtml = `
    <link rel="stylesheet" href="cy3.css">
    <main onclick="window.evil = true">
      <p class="sense">安全释义</p>
      ${'<p>用于形成总览滚动区域的安全文本。</p>'.repeat(8)}
      <a href="entry://新词">跳到新词</a>
      ${'<p>用于形成总览滚动区域的安全文本。</p>'.repeat(24)}
      <img src="figure.png" alt="本地图">
      <img src="https://tracker.invalid/pixel.png" alt="外部图">
      <script>window.evil = true</script>
      <iframe src="https://tracker.invalid/frame"></iframe>
      <audio src="sound.mp3"></audio>
    </main>`
  await setupDictionaryReader(
    page,
    { 词: wordHtml },
    0,
    {},
    [localMdict()],
    {},
    {
      'dict-synthetic-zh': {
        词: {
          entry: { headword: '词', html: richHtml },
        },
        新词: {
          entry: {
            headword: '新词',
            html: '<p>第一层内部跳转结果</p><a href="entry://第三词">继续跳转</a>',
          },
        },
        第三词: {
          entry: { headword: '第三词', html: '<p>第二层内部跳转结果</p>' },
        },
      },
    },
    {
      'dict-synthetic-zh': {
        'cy3.css': `
          @import url("https://tracker.invalid/import.css");
          @font-face { font-family: Fixture; src: url("fixture.ttf"); }
          .sense { background: url("waveline.png"); behavior: url("evil.htc"); }
          .escape { background: url("../secret.png"); }
          .remote { background: url("https://tracker.invalid/remote.png"); }
        `,
      },
    },
  )
  await selectFixtureText(page, '词')
  await page.getByRole('button', { name: msg('menu.dictionary'), exact: true }).click()

  const popup = page.getByRole('dialog')
  await expect(popup.getByRole('heading', { name: 'Synthetic Chinese MDict' })).toBeVisible()
  const iframe = popup.locator('[data-dictionary-rich-content]')
  await expect(iframe).toHaveAttribute('sandbox', 'allow-same-origin allow-scripts')
  await expect(iframe).toHaveAttribute('scrolling', 'no')
  const frame = iframe.contentFrame()
  await expect(frame.getByText('安全释义', { exact: true })).toBeVisible()
  await expect(frame.locator('script, iframe, audio, [onclick]')).toHaveCount(0)
  await expect(frame.getByAltText('外部图')).toHaveCount(0)
  await expect(frame.getByAltText('本地图')).toHaveAttribute('src', /http:\/\/dictionary\.localhost\/.*\/figure\.png$/)
  const documentSafety = await frame.locator('html').evaluate((element) => ({
    csp: element.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') ?? '',
    style: Array.from(element.querySelectorAll('style'))
      .map((node) => node.textContent ?? '')
      .join('\n'),
  }))
  expect(documentSafety.csp).toContain("default-src 'none'")
  expect(documentSafety.csp).toContain("script-src 'none'")
  expect(documentSafety.style).toContain('dictionary.localhost')
  expect(documentSafety.style).not.toMatch(/@import|behavior|tracker\.invalid|\.\.\/secret/)
  const contextMenu = await frame.locator('body').evaluate((body) => {
    const event = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
    })
    const dispatchResult = body.dispatchEvent(event)
    return {
      defaultPrevented: event.defaultPrevented,
      dispatchResult,
    }
  })
  expect(contextMenu).toEqual({
    defaultPrevented: true,
    dispatchResult: false,
  })

  const scroll = popup.locator('[data-dictionary-scroll]')
  const rootScrollTop = await scroll.evaluate((element) => {
    element.scrollTop = 180
    return element.scrollTop
  })
  expect(rootScrollTop).toBeGreaterThan(0)
  const sourceButtons = popup.locator('[data-dictionary-navigator] button')
  await expect(sourceButtons).toHaveCount(2)
  await expect(sourceButtons.nth(0)).toBeEnabled()
  await expect(sourceButtons.nth(1)).toBeEnabled()

  await frame.getByText('跳到新词', { exact: true }).evaluate((anchor) => {
    const selection = anchor.ownerDocument.defaultView?.getSelection()
    const range = anchor.ownerDocument.createRange()
    range.selectNodeContents(anchor)
    selection?.removeAllRanges()
    selection?.addRange(range)
    anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
  await expect.poll(async () => (await getDictionaryMockState(page)).mdictRequests).toHaveLength(1)
  await frame.locator('body').evaluate((body) => {
    body.ownerDocument.defaultView?.getSelection()?.removeAllRanges()
  })
  await frame.getByText('跳到新词', { exact: true }).scrollIntoViewIfNeeded()
  const navigationScrollTop = await scroll.evaluate((element) => element.scrollTop)

  await frame.getByText('跳到新词', { exact: true }).click()
  await expect(popup.locator('header').getByText('词', { exact: true })).toBeVisible()
  await expect(sourceButtons.nth(0)).toBeDisabled()
  await expect(sourceButtons.nth(1)).toBeDisabled()
  await expect.poll(async () => (await getDictionaryMockState(page)).mdictRequests).toHaveLength(2)
  await expect(popup.getByRole('heading', { name: '汉典' })).toHaveCount(0)
  await expect(popup.locator('[data-dictionary-rich-content]')).toHaveCount(1)
  await expect(frame.getByText('第一层内部跳转结果', { exact: true })).toBeVisible()
  await iframe.evaluate((element) => {
    element.dataset.mdictInstance = 'first-detail'
  })
  expect((await getDictionaryMockState(page)).dictionaryRequests).toHaveLength(1)

  await frame.getByText('继续跳转', { exact: true }).click()
  await expect(popup.locator('header').getByText('词', { exact: true })).toBeVisible()
  await expect(frame.getByText('第二层内部跳转结果', { exact: true })).toBeVisible()
  await expect(popup.locator('[data-dictionary-rich-content]')).toHaveCount(1)

  await iframe.evaluate((element: HTMLIFrameElement) => {
    const frameWindow = element.contentWindow
    frameWindow?.document.body.dispatchEvent(
      new (frameWindow as Window & { MouseEvent: typeof MouseEvent }).MouseEvent('mousedown', {
        bubbles: true,
        button: 3,
        cancelable: true,
      }),
    )
  })
  await expect(popup.locator('header').getByText('词', { exact: true })).toBeVisible()
  await expect(frame.getByText('第一层内部跳转结果', { exact: true })).toBeVisible()
  await expect(iframe).toHaveAttribute('data-mdict-instance', 'first-detail')

  await popup.locator('header').dispatchEvent('mousedown', { button: 3 })
  await expect(popup.getByRole('heading', { name: '汉典' })).toBeVisible()
  await expect(sourceButtons.nth(0)).toBeEnabled()
  await expect(sourceButtons.nth(1)).toBeEnabled()
  await expect(frame.getByText('安全释义', { exact: true })).toBeVisible()
  await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBe(navigationScrollTop)
  const navigationState = await getDictionaryMockState(page)
  expect(navigationState.dictionaryRequests).toHaveLength(1)
  expect(navigationState.mdictRequests.map(({ query }) => query)).toEqual(['词', '新词', '第三词'])

  await dictionaryCloseButton(page).click()
  const state = await getDictionaryMockState(page)
  expect(state.mdictStylesheetRequests).toEqual([
    {
      dictionaryId: 'dict-synthetic-zh',
      key: 'cy3.css',
      sessionId: state.mdictRequests[0]!.sessionId,
    },
  ])
  expect(new Set(state.cancelledDictionarySessions)).toEqual(
    new Set(state.mdictRequests.map(({ sessionId }) => sessionId)),
  )
})

test('MDict keeps readable text when an optional stylesheet is missing', async ({ page }) => {
  await setupDictionaryReader(
    page,
    { 词: wordHtml },
    0,
    {},
    [localMdict()],
    {},
    {
      'dict-synthetic-zh': {
        词: {
          entry: {
            headword: '词',
            html: '<link rel="stylesheet" href="missing.css"><p>无样式仍可阅读</p>',
          },
        },
      },
    },
  )
  await selectFixtureText(page, '词')
  await page.getByRole('button', { name: msg('menu.dictionary'), exact: true }).click()

  const popup = dictionaryPopup(page)
  const frame = popup.locator('[data-dictionary-rich-content]').contentFrame()
  await expect(frame.getByText('无样式仍可阅读', { exact: true })).toBeVisible()
  await expect(popup.getByText('Lookup failed.')).toHaveCount(0)
})

test('MDict does not enlarge or navigate linked images', async ({ page }) => {
  await page.route('http://dictionary.localhost/**/page.png', (route) =>
    route.fulfill({
      body: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64',
      ),
      contentType: 'image/png',
    }),
  )
  await setupDictionaryReader(
    page,
    {},
    0,
    {},
    [localMdict()],
    {},
    {
      'dict-synthetic-zh': {
        图片词: {
          entry: {
            headword: '图片词',
            html: `
              <link rel="stylesheet" href="fixture.css">
              <p class="entry">图片词条</p>
              <a href="entry://不应跳转"><img class="page" src="/page.png" alt="词典页"></a>
            `,
          },
        },
        不应跳转: {
          entry: { headword: '不应跳转', html: '<p>错误跳转结果</p>' },
        },
      },
    },
    {
      'dict-synthetic-zh': {
        'fixture.css': `
          .page { width: 100%; cursor: pointer; }
          .entry { background-image: url("./page.png"); }
        `,
      },
    },
  )
  await selectFixtureText(page, '图片词')
  await page.getByRole('button', { name: msg('menu.dictionary'), exact: true }).click()

  const popup = dictionaryPopup(page)
  const frame = popup.locator('[data-dictionary-rich-content]').contentFrame()
  const image = frame.getByAltText('词典页')
  await expect(image).toBeVisible()
  await expect
    .poll(() =>
      frame.getByText('图片词条', { exact: true }).evaluate((element) => getComputedStyle(element).backgroundImage),
    )
    .toContain('dictionary.localhost')
  await expect.poll(() => image.evaluate((element) => element.getBoundingClientRect().width)).toBe(1)

  await image.click()
  await expect(frame.getByText('图片词条', { exact: true })).toBeVisible()
  await expect(frame.getByText('错误跳转结果', { exact: true })).toHaveCount(0)
  await expect.poll(async () => (await getDictionaryMockState(page)).mdictRequests).toHaveLength(1)
})

test('outside dismissal releases the local dictionary session before showing actions', async ({ page }) => {
  await setupDictionaryReader(
    page,
    { 词: wordHtml },
    0,
    {},
    [localMdict()],
    {},
    {
      'dict-synthetic-zh': {
        词: {
          entry: { headword: '词', html: '<p>关闭路径测试</p>' },
        },
      },
    },
  )
  await selectFixtureText(page, '词')
  await page.getByRole('button', { name: msg('menu.dictionary'), exact: true }).click()
  await expect(dictionaryPopup(page).locator('[data-dictionary-rich-content]')).toBeVisible()
  const sessionId = (await getDictionaryMockState(page)).mdictRequests[0]!.sessionId

  await page.mouse.click(2, 2)

  await expect(page.getByRole('button', { name: msg('menu.dictionary'), exact: true })).toBeVisible()
  await expect
    .poll(async () => (await getDictionaryMockState(page)).cancelledDictionarySessions.includes(sessionId))
    .toBe(true)
})
