const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

export const FEATURE_CATALOG = [
  { id: 'startup', name: '启动与恢复', sources: ['src/main.tsx', 'src/library/LibraryPage.tsx'] },
  { id: 'import-open', name: '导入与打开', sources: ['src/library/LibraryPage.tsx'] },
  {
    id: 'library',
    name: '书架浏览、搜索、筛选和排序',
    sources: ['src/library/LibraryPage.tsx', 'src/components/Layout.tsx'],
  },
  { id: 'book-management', name: '标签、阅读状态、删除与批量操作', sources: ['src/library/LibraryPage.tsx'] },
  {
    id: 'reader-navigation',
    name: '翻页、目录和进度跳转',
    sources: ['src/components/Reader.tsx', 'src/models/reader/navigation.ts'],
  },
  {
    id: 'tabs-modes',
    name: '标签切换与书架/阅读器切换',
    sources: ['src/components/Reader.tsx', 'src/components/Layout.tsx'],
  },
  {
    id: 'search',
    name: '全书搜索与章节查找',
    sources: ['src/components/viewlets/SearchView.tsx', 'src/components/reader/ChapterFind.tsx'],
  },
  {
    id: 'typography',
    name: '排版、主题、缩放和视图模式',
    sources: ['src/components/viewlets/TypographyView.tsx', 'src/components/viewlets/ThemePanel.tsx'],
  },
  { id: 'geometry', name: '窗口和侧栏几何变化', sources: ['src/components/Layout.tsx', 'src/components/Reader.tsx'] },
  {
    id: 'annotations-images',
    name: '选区、批注、笔记和图片',
    sources: ['src/components/Annotation.tsx', 'src/components/reader/ReaderImagePreview.tsx'],
  },
  {
    id: 'dictionary-translation',
    name: '字典与翻译',
    sources: ['src/components/DictionaryPopup.tsx', 'src/components/TranslationPopup.tsx'],
  },
  {
    id: 'settings-global',
    name: '设置与全局 UI',
    sources: ['src/settings/SettingsPanel.tsx', 'src/components/Layout.tsx'],
  },
  { id: 'native-update', name: '原生打开、深链、更新与关闭恢复', sources: ['src/main.tsx', 'src/updater-entry.tsx'] },
]

async function waitForApp(page) {
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => Boolean(document.querySelector('#layout') && window.reader), null, {
    timeout: 30_000,
  })
}

async function ensureReader(page, books, tabCount = 1) {
  await waitForApp(page)
  await page.evaluate(
    async ({ fixtureBooks, tabCount }) => {
      await window.reader.closeAllTabs?.()
      for (const book of fixtureBooks.slice(0, tabCount)) await window.reader.addTab(book)
      window.reader.selectTab(0)
    },
    { fixtureBooks: books, tabCount },
  )
  await page.waitForFunction(
    (expectedTabs) => window.reader?.tabs?.length === expectedTabs && Boolean(window.reader?.focusedBookTab?.rendered),
    tabCount,
    { timeout: 60_000 },
  )
  const libraryVisible = await page
    .locator('[data-flow-library-grid="true"]')
    .isVisible()
    .catch(() => false)
  if (libraryVisible) await page.keyboard.press('v')
  await page.waitForFunction(() => Boolean(document.querySelector('[data-flow-reader-content]')))
  await wait(500)
}

async function ensureLargeReader(page, books, tabCount) {
  await waitForApp(page)
  await page.evaluate(async () => window.reader.closeAllTabs?.())
  for (const [index, book] of books.slice(0, tabCount).entries()) {
    await page.evaluate((fixtureBook) => window.reader.addTab(fixtureBook, { activate: false }), book)
    await page.waitForFunction((expectedTabs) => window.reader?.tabs?.length === expectedTabs, index + 1)
  }
  await page.evaluate((lastIndex) => window.reader.selectTab(lastIndex), tabCount - 1)
  await page.waitForFunction(() => Boolean(window.reader?.focusedBookTab?.rendered), null, { timeout: 60_000 })
  await page.evaluate(() => window.reader.selectTab(0))
  await page.waitForFunction(() => Boolean(window.reader?.focusedBookTab?.rendered), null, { timeout: 60_000 })
  const libraryVisible = await page
    .locator('[data-flow-library-grid="true"]')
    .isVisible()
    .catch(() => false)
  if (libraryVisible) await page.keyboard.press('v')
  await page.waitForFunction(() => Boolean(document.querySelector('[data-flow-reader-content]')))
  await wait(500)
}

async function clickActivity(page, label) {
  const button = page.getByRole('button', { name: label, exact: true })
  await button.click()
  await wait(250)
}

async function ensureReaderPanel(page, label) {
  await clickActivity(page, label)
  const sidebar = page.locator('.SideBar')
  if (!(await sidebar.isVisible())) await clickActivity(page, label)
  await sidebar.waitFor({ state: 'visible' })
}

async function readReaderState(page) {
  return page.evaluate(() => ({
    selectedIndex: window.reader?.selectedIndex ?? -1,
    location: window.reader?.focusedBookTab?.location?.start?.cfi ?? window.reader?.focusedBookTab?.book?.cfi ?? null,
    turning: Boolean(window.reader?.focusedBookTab?.turning),
  }))
}

export const AUTOMATED_SCENARIOS = [
  {
    id: 'control.idle-library',
    featureId: 'library',
    group: 'control',
    sourceEntries: ['src/library/LibraryPage.tsx'],
    description: '书架稳定后保持空闲，用于识别后台渲染。',
    async prepare(page) {
      await waitForApp(page)
      await page.locator('[data-flow-library-grid="true"]').waitFor({ state: 'visible' })
    },
    async action() {
      await wait(350)
      return { idleMs: 350 }
    },
  },
  {
    id: 'library.search-input',
    featureId: 'library',
    group: 'pilot',
    sourceEntries: ['src/library/LibraryPage.tsx'],
    description: '在书架标题搜索框输入一个可命中的完整标题。',
    async prepare(page) {
      await waitForApp(page)
      await page.getByRole('textbox', { name: 'Search titles', exact: true }).waitFor()
    },
    async action(page) {
      const input = page.getByRole('textbox', { name: 'Search titles', exact: true })
      await input.fill('Flow Render B')
      await page.waitForFunction(
        () =>
          document.querySelector('[data-flow-library-grid]')?.getAttribute('data-flow-library-grid-total-count') ===
          '1',
      )
      return {
        query: await input.inputValue(),
        visibleBooks: await page.locator('[data-flow-library-book-card]').count(),
      }
    },
  },
  {
    id: 'library.filter-open',
    featureId: 'library',
    group: 'pilot',
    sourceEntries: ['src/components/Layout.tsx'],
    description: '打开书架筛选侧栏。',
    async prepare(page) {
      await waitForApp(page)
      await page.locator('[data-flow-library-grid="true"]').waitFor({ state: 'visible' })
    },
    async action(page) {
      await clickActivity(page, 'Filter')
      await page.locator('.SideBar').waitFor({ state: 'visible' })
      return { sidebarVisible: await page.locator('.SideBar').isVisible() }
    },
  },
  {
    id: 'reader.page-turn-keyboard',
    featureId: 'reader-navigation',
    group: 'pilot',
    sourceEntries: ['src/components/Reader.tsx', 'src/models/reader/navigation.ts'],
    description: '阅读器稳定后通过 ArrowRight 翻一页。',
    async prepare(page, books) {
      await ensureReader(page, books, 1)
    },
    async action(page) {
      const before = await readReaderState(page)
      await page.keyboard.press('ArrowRight')
      await page.waitForFunction(
        (previous) => {
          const tab = window.reader?.focusedBookTab
          const current = tab?.location?.start?.cfi ?? tab?.book?.cfi ?? null
          return !tab?.turning && current !== previous
        },
        before.location,
        { timeout: 30_000 },
      )
      return { before, after: await readReaderState(page) }
    },
  },
  {
    id: 'reader.tab-click',
    featureId: 'tabs-modes',
    group: 'pilot',
    sourceEntries: ['src/components/Reader.tsx'],
    description: '点击第二个已就绪的阅读标签。',
    async prepare(page, books) {
      await ensureReader(page, books, 3)
    },
    async action(page) {
      await page.locator('[data-flow-reader-tab-index="1"]').click()
      await page.waitForFunction(
        () => window.reader?.selectedIndex === 1 && Boolean(window.reader?.focusedBookTab?.rendered),
      )
      return await readReaderState(page)
    },
  },
  {
    id: 'reader.tab-click-large',
    featureId: 'tabs-modes',
    group: 'pilot',
    fixtureBookCount: 20,
    sourceEntries: ['src/components/Reader.tsx', 'src/components/Tab.tsx'],
    description: '在 20 个已打开的阅读标签中点击最后一个标签。',
    async prepare(page, books) {
      await ensureLargeReader(page, books, 20)
      await page.waitForFunction(() => document.querySelectorAll('[data-flow-reader-tab-index]').length === 20)
    },
    async action(page) {
      await page.locator('[data-flow-reader-tab-index="19"]').click()
      await page.waitForFunction(
        () => window.reader?.selectedIndex === 19 && Boolean(window.reader?.focusedBookTab?.rendered),
      )
      return {
        ...(await readReaderState(page)),
        tabCount: await page.locator('[data-flow-reader-tab-index]').count(),
      }
    },
  },
  {
    id: 'reader.search-input',
    featureId: 'search',
    group: 'pilot',
    sourceEntries: ['src/components/viewlets/SearchView.tsx'],
    description: '在全书搜索面板输入查询。',
    async prepare(page, books) {
      await ensureReader(page, books, 1)
      await ensureReaderPanel(page, 'Search')
    },
    async action(page) {
      const input = page.getByRole('textbox', { name: 'Search', exact: true })
      await input.fill('deterministic')
      await page.waitForFunction(() => window.reader?.focusedBookTab?.keyword === 'deterministic')
      await wait(300)
      return { query: await input.inputValue() }
    },
  },
  {
    id: 'reader.typography-font-size',
    featureId: 'typography',
    group: 'pilot',
    sourceEntries: ['src/components/viewlets/TypographyView.tsx', 'src/components/Reader.tsx'],
    description: '在排版面板设置书籍字号。',
    async prepare(page, books) {
      await ensureReader(page, books, 1)
      await ensureReaderPanel(page, 'Typography')
    },
    async action(page) {
      const input = page.locator('input[name="Font size"]')
      await input.fill('20')
      await input.blur()
      await page.waitForFunction(
        () => window.reader?.focusedBookTab?.book?.configuration?.typography?.fontSize === '20px',
      )
      await wait(500)
      return { value: await input.inputValue() }
    },
  },
  {
    id: 'reader.selection-menu',
    featureId: 'annotations-images',
    group: 'pilot',
    sourceEntries: ['src/components/TextSelectionMenu.tsx', 'src/components/reader/useBookPaneFrameContent.ts'],
    description: '在阅读 iframe 中创建文本选区并打开选区工具。',
    async prepare(page, books) {
      await ensureReader(page, books, 1)
      await page.waitForFunction(() =>
        Boolean(document.querySelector('[data-flow-reader-content] iframe')?.contentDocument?.querySelector('p')),
      )
    },
    async action(page) {
      const selectedText = await page.evaluate(() => {
        const frame = document.querySelector('[data-flow-reader-content] iframe')
        const paragraph = frame?.contentDocument?.querySelector('p')
        const frameWindow = frame?.contentWindow
        if (!paragraph || !frameWindow) throw new Error('reader selection target is unavailable')
        const range = frame.contentDocument.createRange()
        range.selectNodeContents(paragraph)
        const selection = frameWindow.getSelection()
        selection?.removeAllRanges()
        selection?.addRange(range)
        const rect = range.getBoundingClientRect()
        frameWindow.dispatchEvent(
          new frameWindow.MouseEvent('contextmenu', {
            bubbles: true,
            cancelable: true,
            clientX: rect.left + rect.width / 2,
            clientY: rect.top + rect.height / 2,
          }),
        )
        return selection?.toString() ?? ''
      })
      await page.locator('[data-flow-keyboard-capture="true"]').waitFor({ state: 'visible' })
      return { selectedTextLength: selectedText.length }
    },
  },
]

export function selectScenarios({ ids, set }) {
  let selected = AUTOMATED_SCENARIOS
  if (set === 'pilot') selected = selected.filter((scenario) => scenario.group === 'pilot')
  if (set === 'control') selected = selected.filter((scenario) => scenario.group === 'control')
  if (ids.length) {
    const requested = new Set(ids)
    selected = selected.filter((scenario) => requested.has(scenario.id))
    const missing = [...requested].filter((id) => !selected.some((scenario) => scenario.id === id))
    if (missing.length) throw new Error(`unknown or excluded render scenario: ${missing.join(', ')}`)
  }
  return selected
}
