import assert from 'node:assert/strict'

import { test } from 'vitest'

import * as annotationModule from '../../src/annotation.ts'
import { BookLayoutTransactionController } from '../../src/models/reader/layoutTransaction.ts'
import * as readerModelModule from '../../src/models/reader/model.ts'
import * as readerSearchModule from '../../src/models/reader/search.ts'
import { createTestBook } from '../support/book-fixtures.ts'

const annotation = annotationModule as Record<string, any>
const readerModel = readerModelModule as Record<string, any>
const readerSearch = readerSearchModule as Record<string, any>

function testAnnotationSpineDoesNotRequireNavItem() {
  assert.strictEqual(
    typeof annotation.createAnnotationSpine,
    'function',
    'Expected annotation spine creation to be independent of navitem',
  )

  assert.deepStrictEqual(
    annotation.createAnnotationSpine({
      index: 3,
      href: 'Text/chapter-3.xhtml',
      navitem: { label: 'Chapter 3' },
    }),
    {
      index: 3,
      href: 'Text/chapter-3.xhtml',
      title: 'Chapter 3',
    },
  )

  assert.deepStrictEqual(
    annotation.createAnnotationSpine({
      index: 4,
      href: 'Text/chapter-4.xhtml',
    }),
    {
      index: 4,
      href: 'Text/chapter-4.xhtml',
    },
  )
}

function testChapterFindUsesTheReadingOrderStartSection() {
  assert.strictEqual(
    typeof readerModel.readingOrderStartSectionIndex,
    'function',
    'Expected chapter find to share the pagination-model reading order',
  )

  const spread = {
    left: { section: { index: 11 } },
    right: { section: { index: 12 } },
  }
  assert.strictEqual(readerModel.readingOrderStartSectionIndex(spread, 'left-first', 20), 11)
  assert.strictEqual(readerModel.readingOrderStartSectionIndex(spread, 'right-first', 20), 12)
  assert.strictEqual(readerModel.readingOrderStartSectionIndex(undefined, undefined, 20), 20)
}

function testSectionMatchesDoNotRequireNavItem() {
  const cfi = 'epubcfi(/6/8!/4/2/1:0)'
  const result = readerSearch.searchInSection(
    {
      getNavPath: () => {
        throw new Error('A section without a nav item must not request a nav path')
      },
    },
    'Technology',
    {
      document: { body: {} },
      find: (query: string) => {
        assert.strictEqual(query, 'Technology')
        return [{ cfi, excerpt: 'Technology' }]
      },
      href: 'Text/dedication.xhtml',
    },
  )

  assert.strictEqual(result?.id, 'Text/dedication.xhtml')
  assert.deepStrictEqual(result?.subitems, [{ cfi, excerpt: 'Technology', id: cfi }])
}

async function testDeepLinkWaitsForPendingPageTurn() {
  const cfi = 'epubcfi(/6/4!/4/2/1:0)'
  let finishPageTurn: (() => void) | undefined
  const pageTurn = new Promise<void>((resolve) => {
    finishPageTurn = resolve
  })
  const displays: string[] = []
  const tab = new readerModel.BookTab(createTestBook({ id: 'deep-link-navigation' }))
  tab.rendered = true
  tab.epub = {
    spine: {
      get: () => ({ href: 'chapter.xhtml', index: 0 }),
    },
  }
  tab.rendition = {
    display: async (target: string) => {
      displays.push(target)
    },
    next: () => pageTurn,
  }

  const turning = tab.next()
  tab.navigateFromDeepLink(cfi)
  await Promise.resolve()
  assert.deepStrictEqual(displays, [])

  finishPageTurn?.()
  await turning
  await tab.displayPendingDeepLinkTarget()
  assert.deepStrictEqual(displays, [cfi])
}

async function testDeepLinkRecordsReturnLocationOnlyWhenLeavingCurrentPage() {
  const section = { href: 'chapter.xhtml', index: 0 }
  const currentLocation = {
    start: { cfi: 'epubcfi(/6/4!/4/2:0)' },
    end: { cfi: 'epubcfi(/6/4!/4/2:8)' },
  }
  const samePageCfi = 'epubcfi(/6/4!/4/2:4)'
  const nextPageCfi = 'epubcfi(/6/4!/4/4:0)'
  const nextPageEndCfi = 'epubcfi(/6/4!/4/4:8)'
  const nextPageLocation = {
    start: { cfi: nextPageCfi },
    end: { cfi: nextPageEndCfi },
  }
  const initialSpread = {
    version: 1,
    anchor: 'left',
    exact: true,
    sectionIndex: 0,
    pageIndex: 0,
    left: { sectionIndex: 0, pageIndex: 0 },
  } as const
  const nextPageSpread = {
    ...initialSpread,
    pageIndex: 1,
    left: { sectionIndex: 0, pageIndex: 1 },
  }
  const order = [currentLocation.start.cfi, samePageCfi, currentLocation.end.cfi, nextPageCfi, nextPageEndCfi]
  const compare = (left: string, right: string) => order.indexOf(left) - order.indexOf(right)

  const openFromDeepLink = async (target: string, alreadyOpen = false) => {
    const tab = new readerModel.BookTab(
      createTestBook({
        cfi: currentLocation.start.cfi,
        configuration: { spread: initialSpread },
        id: `deep-link-history-${target === samePageCfi ? 'same' : 'different'}-${alreadyOpen ? 'open' : 'closed'}`,
      }),
    )
    tab.epub = {
      spine: {
        get: () => section,
      },
    }
    tab.sections = [section]
    const displays: string[] = []
    const restoredSpreads: unknown[] = []
    tab.rendition = {
      display: async (displayTarget: string) => {
        displays.push(displayTarget)
        tab.currentLocation = displayTarget === nextPageCfi ? nextPageLocation : currentLocation
        if (displayTarget === nextPageCfi) {
          tab.book = {
            ...tab.book,
            configuration: { spread: nextPageSpread },
          }
        }
      },
      epubcfi: {
        compare,
      },
      manager: {
        canUseLogicalReflowableSpread: () => true,
        renderReflowableSpread: async (spread: unknown) => {
          restoredSpreads.push(spread)
        },
      },
      reportLocation: async () => undefined,
    }

    if (alreadyOpen) {
      tab.currentLocation = currentLocation
      tab.rendered = true
    }
    tab.navigateFromDeepLink(target)
    if (!alreadyOpen) {
      await new BookLayoutTransactionController().displayInitialPosition(tab)
      tab.rendered = true
    }
    await tab.displayPendingDeepLinkTarget()
    return { displays, restoredSpreads, tab }
  }

  const assertReturnsToCurrentPage = async ({
    displays,
    restoredSpreads,
    tab,
  }: Awaited<ReturnType<typeof openFromDeepLink>>) => {
    assert.strictEqual(tab.returnToPreviousLocation(), true)
    await tab.waitForPendingNavigation()
    if (restoredSpreads.length) {
      assert.deepStrictEqual(restoredSpreads, [
        {
          anchor: 'left',
          exact: true,
          left: { section, pageIndex: 0 },
        },
      ])
      return
    }

    const returnTarget = displays.at(-1)!
    assert.ok(compare(returnTarget, currentLocation.start.cfi) >= 0)
    assert.ok(compare(returnTarget, currentLocation.end.cfi) <= 0)
  }

  for (const alreadyOpen of [false, true]) {
    const samePage = await openFromDeepLink(samePageCfi, alreadyOpen)
    if (alreadyOpen) assert.deepStrictEqual(samePage.displays, [])
    assert.strictEqual(samePage.tab.returnToPreviousLocation(), false)

    const differentPage = await openFromDeepLink(nextPageCfi, alreadyOpen)
    await assertReturnsToCurrentPage(differentPage)
  }
}

async function testPositionJumpsIgnoreTheCurrentSpreadAndSerializeDuplicates() {
  const section = { href: 'chapter.xhtml', index: 0 }
  const navigateFromPages = async (
    startPage: number,
    endPage: number,
    {
      concurrent = false,
      history = [],
      repeats = 1,
    }: { concurrent?: boolean; history?: { target: string }[]; repeats?: number } = {},
  ) => {
    const tab = new readerModel.BookTab(createTestBook({ id: `chapter-history-${startPage}-${endPage}` }))
    tab.currentLocation = {
      start: {
        cfi: `epubcfi(/6/4!/4/${startPage * 2}:0)`,
        displayed: { page: startPage },
        index: section.index,
      },
      end: {
        cfi: `epubcfi(/6/4!/4/${endPage * 2}:0)`,
        displayed: { page: endPage },
        index: section.index,
      },
    }
    tab.epub = { spine: { get: () => section } }
    tab.locationsToReturn = [...history]
    let displays = 0
    let releaseDisplay: (() => void) | undefined
    const displayGate = concurrent
      ? new Promise<void>((resolve) => {
          releaseDisplay = resolve
        })
      : Promise.resolve()
    tab.rendition = {
      display: async () => {
        displays++
        await displayGate
        tab.currentLocation = {
          start: {
            cfi: 'epubcfi(/6/4!/4/2:0)',
            displayed: { page: 1 },
            index: section.index,
          },
          end: {
            cfi: 'epubcfi(/6/4!/4/4:0)',
            displayed: { page: 2 },
            index: section.index,
          },
        }
      },
    }

    const navigations = Array.from({ length: repeats }, () => tab.displaySectionStart(section, true))
    releaseDisplay?.()
    await Promise.all(navigations)
    return { displays, history: [...tab.locationsToReturn] }
  }

  assert.deepStrictEqual(await navigateFromPages(1, 2, { history: [{ target: 'existing' }], repeats: 2 }), {
    displays: 0,
    history: [{ target: 'existing' }],
  })
  assert.deepStrictEqual(await navigateFromPages(2, 3, { concurrent: true, repeats: 2 }), {
    displays: 1,
    history: [{ target: 'epubcfi(/6/4!/4/4:0)' }],
  })

  const nextSection = { href: 'next.xhtml', index: 1 }
  const crossSectionTab = new readerModel.BookTab(createTestBook({ id: 'cross-section-chapter-history' }))
  crossSectionTab.currentLocation = {
    start: {
      cfi: 'epubcfi(/6/4!/4/8:0)',
      displayed: { page: 4 },
      index: section.index,
    },
    end: {
      cfi: 'epubcfi(/6/6!/4/2:0)',
      displayed: { page: 1 },
      index: nextSection.index,
    },
  }
  crossSectionTab.epub = { spine: { get: () => nextSection } }
  let crossSectionDisplays = 0
  crossSectionTab.rendition = {
    display: async () => {
      crossSectionDisplays++
    },
  }
  await crossSectionTab.displaySectionStart(nextSection, true)
  assert.strictEqual(crossSectionDisplays, 0)
  assert.deepStrictEqual(crossSectionTab.locationsToReturn, [])

  const endBoundaryTab = new readerModel.BookTab(createTestBook({ id: 'end-boundary-history' }))
  const endBoundary = 'epubcfi(/6/4!/4/6:0)'
  endBoundaryTab.currentLocation = {
    start: { cfi: 'epubcfi(/6/4!/4/2:0)', index: section.index },
    end: { cfi: endBoundary, index: section.index },
  }
  endBoundaryTab.epub = { spine: { get: () => section } }
  let endBoundaryDisplays = 0
  endBoundaryTab.rendition = {
    display: async () => {
      endBoundaryDisplays++
    },
    epubcfi: {
      compare: (left: string, right: string) => left.localeCompare(right, undefined, { numeric: true }),
    },
  }
  endBoundaryTab.display(endBoundary, true)
  await endBoundaryTab.waitForPendingNavigation()
  assert.strictEqual(endBoundaryDisplays, 1)
  assert.deepStrictEqual(endBoundaryTab.locationsToReturn, [{ target: 'epubcfi(/6/4!/4/2:0)' }])
}

async function testReturnHistoryKeepsTheOriginAndRestoresItsExactSpread() {
  const section = { href: 'chapter.xhtml', index: 0 }
  const tab = new readerModel.BookTab(createTestBook({ id: 'bounded-return-history' }))
  const startCfi = (index: number) => `epubcfi(/6/4!/4/${index * 4 + 2}:0)`
  const endCfi = (index: number) => `epubcfi(/6/4!/4/${index * 4 + 6}:0)`
  const spread = (index: number) => ({
    version: 1,
    anchor: 'right',
    exact: true,
    layoutStyleSignature: 'test-layout',
    sectionIndex: section.index,
    pageIndex: index * 2 + 1,
    left: { sectionIndex: section.index, pageIndex: index * 2 },
    right: { sectionIndex: section.index, pageIndex: index * 2 + 1 },
  })

  tab.sections = [section]
  tab.layoutStyleSignature = 'test-layout'
  for (let index = 0; index < 52; index++) {
    tab.currentLocation = {
      start: { cfi: startCfi(index) },
      end: { cfi: endCfi(index) },
    }
    tab.currentSpreadState = spread(index)
    tab.showPrevLocation()
  }

  assert.deepStrictEqual(
    tab.locationsToReturn.map((location: { target: string }) => location.target),
    [startCfi(0), ...Array.from({ length: 49 }, (_, index) => startCfi(index + 3))],
  )

  let visiblePages: number[] = []
  const manager = {
    canUseLogicalReflowableSpread: () => true,
    renderReflowableSpread: async (restored: { left?: { pageIndex: number }; right?: { pageIndex: number } }) => {
      visiblePages = [restored.left, restored.right]
        .filter((page): page is { pageIndex: number } => Boolean(page))
        .map((page) => page.pageIndex + 1)
    },
  }
  tab.epub = { spine: { get: () => section } }
  tab.rendition = {
    display: async () => {
      visiblePages = [3, 4]
    },
    epubcfi: {
      compare: (left: string, right: string) => left.localeCompare(right, undefined, { numeric: true }),
    },
    manager,
    reportLocation: async () => undefined,
  }
  tab.currentLocation = {
    start: { cfi: startCfi(51) },
    end: { cfi: endCfi(51) },
  }

  assert.strictEqual(tab.returnToFirstLocation(), true)
  await tab.waitForPendingNavigation()
  assert.deepStrictEqual(visiblePages, [1, 2])
}

for (const run of [
  testAnnotationSpineDoesNotRequireNavItem,
  testPositionJumpsIgnoreTheCurrentSpreadAndSerializeDuplicates,
  testChapterFindUsesTheReadingOrderStartSection,
  testDeepLinkRecordsReturnLocationOnlyWhenLeavingCurrentPage,
  testDeepLinkWaitsForPendingPageTurn,
  testReturnHistoryKeepsTheOriginAndRestoresItsExactSpread,
  testSectionMatchesDoNotRequireNavItem,
]) {
  test(run.name, run)
}
