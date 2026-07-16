import path from 'node:path'

import { expect, test, type Page } from '@playwright/test'

import type { BookRecord } from '../src/db'
import type { LocalDictionaryRecord } from '../src/dictionary/native'

import { getDictionaryMockState, installTauriMock } from './tauri-mock'

const aliceEpubPath = path.resolve('packages/epubjs/test/fixtures/alice.epub')
const alicePackageUrl = '/test-assets/dictionary/alice.epub'

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

function dictionaryBook(): BookRecord {
  return {
    id: 'dictionary-book',
    name: 'Dictionary Fixture.epub',
    size: 128000,
    metadata: {
      title: 'Dictionary Fixture',
      creator: 'Flow Test',
      language: 'zh-CN',
    },
    createdAt: 1,
    updatedAt: 1,
    cfi: 'chapter_001.xhtml',
    definitions: [],
    annotations: [],
    stateLoaded: true,
  } as BookRecord
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
) {
  await page.route(`**${alicePackageUrl}`, (route) =>
    route.fulfill({
      path: aliceEpubPath,
      contentType: 'application/epub+zip',
    }),
  )
  await installTauriMock(page, {
    books: [dictionaryBook()],
    readerSources: { 'dictionary-book': alicePackageUrl },
    settings: {
      librarySidebarOpen: false,
      dictionary: {
        merriamWebster: {
          apiKey: Object.keys(merriamWebsterResponses).length
            ? 'test-only-mw-key'
            : '',
          enabled: Object.keys(merriamWebsterResponses).length > 0,
        },
      },
    },
    merriamWebsterResponses,
    localDictionaries,
    mdictResponses,
    mdictStylesheets,
    stardictResponses,
    zdicResponses,
    zdicResponseDelayMs,
  })
  await page.goto('/')
  await page.addStyleTag({
    content:
      'nextjs-portal{display:none!important;pointer-events:none!important}',
  })
  await page
    .locator('ul.grid [data-flow-library-book-card]')
    .filter({ hasText: 'Dictionary Fixture' })
    .click()
  await expect
    .poll(() =>
      page.evaluate(() => {
        const pane = document.querySelector(
          '[data-flow-reader-pane][aria-hidden="false"]',
        )
        return Array.from(pane?.querySelectorAll('iframe') ?? []).some(
          (frame) =>
            frame.getBoundingClientRect().width > 0 &&
            Boolean((frame as HTMLIFrameElement).contentDocument?.body),
        )
      }),
    )
    .toBe(true)
}

function localStarDict(): LocalDictionaryRecord {
  return {
    createdAt: 1,
    enabled: true,
    files: [],
    fingerprint: { modifiedMs: 1, sampleHash: 'fixture', size: 1 },
    format: 'stardict',
    id: 'dict-oxford',
    language: { source: 'manual', value: 'en' },
    name: 'Oxford English-Chinese Dictionary',
    order: 0,
    sourcePath: 'C:\\fixture\\oxford.ifo',
    sourceStatus: 'available',
    updatedAt: 1,
  }
}

function localMdict(): LocalDictionaryRecord {
  return {
    createdAt: 1,
    enabled: true,
    files: [],
    fingerprint: { modifiedMs: 1, sampleHash: 'fixture', size: 1 },
    format: 'mdict',
    id: 'dict-ciyuan',
    language: { source: 'manual', value: 'zh' },
    name: 'Synthetic Chinese MDict',
    order: 0,
    sourcePath: 'C:\\fixture\\ciyuan.mdx',
    sourceStatus: 'available',
    updatedAt: 1,
  }
}

async function selectFixtureText(
  page: Page,
  query: string,
  expectDictionary = true,
) {
  await page.evaluate((selectedText) => {
    const pane = document.querySelector(
      '[data-flow-reader-pane][aria-hidden="false"]',
    )
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
    const range = doc.createRange()
    range.selectNodeContents(target)
    const selection = frame.contentWindow.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    const rect = range.getBoundingClientRect()
    frame.contentWindow.dispatchEvent(
      new frame.contentWindow.MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
      }),
    )
  }, query)
  await expect(page.getByRole('button', { name: 'Copy' })).toBeVisible()
  if (expectDictionary) {
    await expect(
      page.getByRole('button', { name: 'Dictionary', exact: true }),
    ).toBeVisible()
  }
}

test('does not offer Han Dian for an English selection', async ({ page }) => {
  await setupDictionaryReader(page, {})
  await selectFixtureText(page, 'sky', false)

  await expect(
    page.getByRole('button', { name: 'Dictionary', exact: true }),
  ).toHaveCount(0)
  expect((await getDictionaryMockState(page)).dictionaryRequests).toEqual([])
})

test('parses only the first Han Dian character explanation into semantic groups', async ({
  page,
}) => {
  await setupDictionaryReader(page, { 天: characterHtml })
  await selectFixtureText(page, '天')
  await page.getByRole('button', { name: 'Dictionary', exact: true }).click()

  const popup = page.getByRole('dialog', { name: 'Dictionary: 天' })
  await expect(popup).toBeVisible()
  await expect(popup.getByText('tiān', { exact: true })).toBeVisible()
  await expect(popup.getByText('tiàn', { exact: true })).toBeVisible()
  await expect(popup.getByText('高处的空间。', { exact: true })).toBeVisible()
  await expect(
    popup.getByText('例如：仰望天空。', { exact: true }),
  ).toBeVisible()
  await expect(popup.getByText('不应显示的详细解释')).toHaveCount(0)
  await expect(popup.locator('[data-dictionary-sense-marker]')).toHaveText([
    '1',
    '2',
    '1',
  ])
})

test('parses adjacent Han Dian word reading groups and respects unnumbered senses', async ({
  page,
}) => {
  await setupDictionaryReader(page, { 天空: wordHtml })
  await selectFixtureText(page, '天空')
  await page.getByRole('button', { name: 'Dictionary', exact: true }).click()

  const popup = page.getByRole('dialog', { name: 'Dictionary: 天空' })
  await expect(popup.getByText('tiān kōng', { exact: true })).toBeVisible()
  await expect(popup.getByText('tiān kòng', { exact: true })).toBeVisible()
  await expect(
    popup.getByText('地面以上的广阔空间。', { exact: true }),
  ).toBeVisible()
  await expect(popup.getByText('合成的无编号补充。')).toBeVisible()
  await expect(popup.getByText('不应显示的详细解释')).toHaveCount(0)
  await expect(popup.getByText('不应显示的成语解释')).toHaveCount(0)
  await expect(popup.locator('[data-dictionary-sense-marker]')).toHaveText([
    '1',
    '1',
  ])
})

test('falls back to cleaned item text without exposing active or raw HTML', async ({
  page,
}) => {
  const fallbackHtml = `<!doctype html><html><body>
    <section id="jbjs" data-section="基本解释">
      <div class="jbjs-reading"><div class="jbjs-reading__py">cè</div><ol class="jbjs-list">
        <li class="jbjs-item" onclick="alert(1)">缺少内部 class 的回退文本<script>危险脚本</script><style>.x{color:red}</style></li>
      </ol></div>
    </section>
  </body></html>`
  await setupDictionaryReader(page, { 测: fallbackHtml })
  await selectFixtureText(page, '测')
  await page.getByRole('button', { name: 'Dictionary', exact: true }).click()

  const popup = page.getByRole('dialog', { name: 'Dictionary: 测' })
  await expect(popup.getByText('缺少内部 class 的回退文本')).toBeVisible()
  await expect(popup.getByText('危险脚本')).toHaveCount(0)
  await expect(popup.locator('script, style, [onclick]')).toHaveCount(0)
})

test('keeps the source link on parse failure and uses two-stage outside dismissal', async ({
  page,
}) => {
  await setupDictionaryReader(page, {
    词: '<html><body><section data-section="其他解释">无目标区</section></body></html>',
  })
  await selectFixtureText(page, '词')
  await page.getByRole('button', { name: 'Dictionary', exact: true }).click()

  const popup = page.getByRole('dialog', { name: 'Dictionary: 词' })
  await expect(popup.getByText('Could not parse this entry.')).toBeVisible()
  await popup.getByRole('button', { name: 'View on Han Dian' }).click()
  await expect
    .poll(async () => (await getDictionaryMockState(page)).openedExternalUrls)
    .toEqual(['https://zdic.net/hans/%E8%AF%8D'])

  await page.mouse.click(2, 2)
  await expect(popup).toBeHidden()
  await expect(
    page.getByRole('button', { name: 'Dictionary', exact: true }),
  ).toBeVisible()
  await page.mouse.click(2, 2)
  await expect(
    page.getByRole('button', { name: 'Dictionary', exact: true }),
  ).toBeHidden()
})

test('back cancels an active native lookup and restores the action menu', async ({
  page,
}) => {
  await setupDictionaryReader(page, { 天: characterHtml }, 2_000)
  await selectFixtureText(page, '天')
  await page.getByRole('button', { name: 'Dictionary', exact: true }).click()
  await expect(
    page.getByRole('dialog', { name: 'Dictionary: 天' }),
  ).toBeVisible()
  await expect
    .poll(
      async () =>
        (await getDictionaryMockState(page)).dictionaryRequests.length,
    )
    .toBeGreaterThan(0)
  const latestSessionId = (
    await getDictionaryMockState(page)
  ).dictionaryRequests.at(-1)!.sessionId
  await page.getByRole('button', { name: 'Back to selection actions' }).click()

  await expect(
    page.getByRole('button', { name: 'Dictionary', exact: true }),
  ).toBeVisible()
  await expect
    .poll(async () => {
      const state = await getDictionaryMockState(page)
      return state.cancelledDictionarySessions.includes(latestSessionId)
    })
    .toBe(true)
})

test('keeps the larger popup inside a narrow horizontal reader', async ({
  page,
}) => {
  await page.setViewportSize({ width: 620, height: 520 })
  await setupDictionaryReader(page, { 天: characterHtml })
  await selectFixtureText(page, '天')
  await page.getByRole('button', { name: 'Dictionary', exact: true }).click()

  const popup = page.getByRole('dialog', { name: 'Dictionary: 天' })
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
  await expect(
    popup.locator('.overflow-y-auto.overscroll-contain'),
  ).toHaveCount(1)
})

test('looks up an English selection only in Merriam-Webster', async ({
  page,
}) => {
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
                    dt: [
                      [
                        'text',
                        '{bc}a place or condition beyond reach {sx|heaven||}',
                      ],
                    ],
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
            sseq: [
              [['sense', { dt: [['text', '{bc}to hit high into the air']] }]],
            ],
          },
        ],
      },
      {
        meta: { id: 'sky blue', stems: ['sky blue'] },
        hwi: { hw: 'sky blue' },
        fl: 'adjective',
        def: [
          {
            sseq: [
              [
                [
                  'sense',
                  { dt: [['text', '{bc}a returned phrase to exclude']] },
                ],
              ],
            ],
          },
        ],
      },
    ],
  })
  await selectFixtureText(page, 'sky')
  await page.getByRole('button', { name: 'Dictionary', exact: true }).click()

  const popup = page.getByRole('dialog', { name: 'Dictionary: sky' })
  await expect(
    popup.getByRole('heading', { name: 'Merriam-Webster' }),
  ).toBeVisible()
  await expect(
    popup.getByText('the upper atmosphere seen from earth'),
  ).toBeVisible()
  await expect(popup.getByText('the sky grew dark')).toBeVisible()
  await expect(popup.getByText('sky blue', { exact: true })).toHaveCount(0)
  await expect(popup.locator('[data-dictionary-sense-level="1"]')).toHaveCount(
    2,
  )
  const layout = await popup.locator('article').evaluateAll((articles) => {
    const noun = articles[0]
    const verb = articles[1]
    const markerLefts = (kind: string) =>
      Array.from(
        noun?.querySelectorAll<HTMLElement>(
          `[data-dictionary-sense-marker="${kind}"]`,
        ) ?? [],
      ).map((marker) => marker.getBoundingClientRect().left)
    const definitionLefts = (depth: string) =>
      Array.from(
        noun?.querySelectorAll<HTMLElement>(
          `[data-dictionary-marker-depth="${depth}"] [data-dictionary-sense-content]`,
        ) ?? [],
      ).map((content) => content.getBoundingClientRect().left)
    const verbHeading = verb?.querySelector<HTMLElement>('h3')
    const verbDefinition = verb?.querySelector<HTMLElement>(
      '[data-dictionary-sense-content]',
    )
    const reference = noun?.querySelector<HTMLElement>(
      '[data-dictionary-text-kind="reference"]',
    )
    const referenceContainer = reference?.closest<HTMLElement>(
      '[data-dictionary-sense-content]',
    )
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
      referenceContainerColor: referenceContainer
        ? getComputedStyle(referenceContainer).color
        : null,
      unnumberedOffset:
        (verbDefinition?.getBoundingClientRect().left ?? 0) -
        (verbHeading?.getBoundingClientRect().left ?? 0),
    }
  })
  expect(layout.markerLefts.number).toHaveLength(2)
  expect(layout.markerLefts.letter).toHaveLength(3)
  expect(layout.markerLefts.subnumber).toHaveLength(2)
  for (const markerGroup of Object.values(layout.markerLefts)) {
    expect(
      Math.max(...markerGroup) - Math.min(...markerGroup),
    ).toBeLessThanOrEqual(1)
  }
  for (const definitionGroup of Object.values(layout.definitionLefts)) {
    expect(
      Math.max(...definitionGroup) - Math.min(...definitionGroup),
    ).toBeLessThanOrEqual(1)
  }
  expect(layout.referenceColor).toBe(layout.referenceContainerColor)
  expect(Math.abs(layout.unnumberedOffset)).toBeLessThanOrEqual(1)
  await expect(popup.getByRole('heading', { name: 'Han Dian' })).toHaveCount(0)
  await popup.getByRole('button', { name: 'View on Merriam-Webster' }).click()

  const state = await getDictionaryMockState(page)
  expect(state.merriamWebsterRequests).toHaveLength(1)
  expect(state.merriamWebsterRequests[0]).toEqual({
    query: 'sky',
    sessionId: expect.any(Number),
  })
  expect(state.openedExternalUrls).toEqual([
    'https://www.merriam-webster.com/dictionary/sky',
  ])
})

test('looks up an English selection in an enabled StarDict and releases its session', async ({
  page,
}) => {
  await setupDictionaryReader(page, {}, 0, {}, [localStarDict()], {
    'dict-oxford': {
      sky: {
        diagnostics: { bytesRead: 48, decompressedBlocks: 1 },
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
  await page.getByRole('button', { name: 'Dictionary', exact: true }).click()

  const popup = page.getByRole('dialog', { name: 'Dictionary: sky' })
  await expect(
    popup.getByRole('heading', { name: 'Oxford English-Chinese Dictionary' }),
  ).toBeVisible()
  await expect(
    popup.getByText('the region of the atmosphere seen from earth'),
  ).toBeVisible()

  await popup.getByRole('button', { name: 'Close' }).click()
  await expect
    .poll(async () => (await getDictionaryMockState(page)).stardictRequests)
    .toHaveLength(1)
  const state = await getDictionaryMockState(page)
  expect(state.stardictRequests[0]).toEqual({
    dictionaryId: 'dict-oxford',
    query: 'sky',
    sessionId: expect.any(Number),
  })
  expect(state.cancelledDictionarySessions).toContain(
    state.stardictRequests[0]!.sessionId,
  )
})

test('MDict renders sanitized rich content and follows internal entry links', async ({
  page,
}) => {
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
      <a href="entry://新词">跳到新词</a>
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
      'dict-ciyuan': {
        词: {
          diagnostics: { recordBytes: richHtml.length, resourceBytes: 0 },
          entry: { headword: '词', html: richHtml },
        },
        新词: {
          diagnostics: { recordBytes: 16, resourceBytes: 0 },
          entry: { headword: '新词', html: '<p>内部跳转结果</p>' },
        },
      },
    },
    {
      'dict-ciyuan': {
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
  await page.getByRole('button', { name: 'Dictionary', exact: true }).click()

  const popup = page.getByRole('dialog', { name: 'Dictionary: 词' })
  await expect(
    popup.getByRole('heading', { name: 'Synthetic Chinese MDict' }),
  ).toBeVisible()
  const iframe = popup.locator('[data-dictionary-rich-content]')
  await expect(iframe).toHaveAttribute('sandbox', 'allow-same-origin')
  await expect(iframe).toHaveAttribute('scrolling', 'no')
  const frame = iframe.contentFrame()
  await expect(frame.getByText('安全释义', { exact: true })).toBeVisible()
  await expect(frame.locator('script, iframe, audio, [onclick]')).toHaveCount(0)
  await expect(frame.getByAltText('外部图')).toHaveCount(0)
  await expect(frame.getByAltText('本地图')).toHaveAttribute(
    'src',
    /http:\/\/dictionary\.localhost\/.*\/figure\.png$/,
  )
  const documentSafety = await frame.locator('html').evaluate((element) => ({
    csp:
      element
        .querySelector('meta[http-equiv="Content-Security-Policy"]')
        ?.getAttribute('content') ?? '',
    style: Array.from(element.querySelectorAll('style'))
      .map((node) => node.textContent ?? '')
      .join('\n'),
  }))
  expect(documentSafety.csp).toContain("default-src 'none'")
  expect(documentSafety.csp).toContain("script-src 'none'")
  expect(documentSafety.style).toContain('dictionary.localhost')
  expect(documentSafety.style).not.toMatch(
    /@import|behavior|tracker\.invalid|\.\.\/secret/,
  )

  await frame.getByText('跳到新词', { exact: true }).click()
  await expect(popup.getByText('新词', { exact: true })).toBeVisible()
  await expect
    .poll(async () => (await getDictionaryMockState(page)).mdictRequests)
    .toHaveLength(2)
  await expect(frame.getByText('内部跳转结果', { exact: true })).toBeVisible()

  await popup.getByRole('button', { name: 'Close' }).click()
  const state = await getDictionaryMockState(page)
  expect(state.mdictStylesheetRequests).toEqual([
    {
      dictionaryId: 'dict-ciyuan',
      key: 'cy3.css',
      sessionId: state.mdictRequests[0]!.sessionId,
    },
  ])
  expect(state.cancelledDictionarySessions).toContain(
    state.mdictRequests.at(-1)!.sessionId,
  )
})

test('MDict keeps readable text when an optional stylesheet is missing', async ({
  page,
}) => {
  await setupDictionaryReader(
    page,
    { 词: wordHtml },
    0,
    {},
    [localMdict()],
    {},
    {
      'dict-ciyuan': {
        词: {
          diagnostics: { recordBytes: 64, resourceBytes: 0 },
          entry: {
            headword: '词',
            html: '<link rel="stylesheet" href="missing.css"><p>无样式仍可阅读</p>',
          },
        },
      },
    },
  )
  await selectFixtureText(page, '词')
  await page.getByRole('button', { name: 'Dictionary', exact: true }).click()

  const popup = page.getByRole('dialog', { name: 'Dictionary: 词' })
  const frame = popup.locator('[data-dictionary-rich-content]').contentFrame()
  await expect(frame.getByText('无样式仍可阅读', { exact: true })).toBeVisible()
  await expect(popup.getByText('Lookup failed.')).toHaveCount(0)
})
