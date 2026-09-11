import type Section from '../src/section'
import type Layout from '../src/layout'
import type Mapping from '../src/mapping'
import type Contents from '../src/contents'
import type { ManagerSettings, ReaderPage } from '../src/managers/default'
import IframeView from '../src/managers/views/iframe'
import { double } from './support/double'
import { assert, vi } from 'vitest'
import DefaultViewManager from '../src/managers/default'
import Views from '../src/managers/helpers/views'

type PageAddress = { sectionIndex: number; pageIndex: number }
type MeasuredSection = Section & { pageCount: number; writingMode?: string }

function createManager(settings: ManagerSettings = {}) {
  const manager = new DefaultViewManager({
    settings: {
      axis: 'horizontal',
      direction: 'ltr',
      ...settings,
    },
    view: IframeView,
    request: async function request() {},
    queue: {},
  })

  manager.layout = double<Layout>({
    width: 1000,
    height: 800,
    pageWidth: 500,
    columnWidth: 460,
    gap: 40,
    divisor: 2,
    name: 'reflowable',
  })
  manager.isPaginated = true

  return manager
}

function createVerticalRtlManager({ divisor = 2 } = {}) {
  const manager = createManager({ direction: 'rtl' })

  manager.layout.width = divisor > 1 ? 1000 : 500
  manager.layout.columnWidth = divisor > 1 ? 460 : 500
  manager.layout.gap = divisor > 1 ? 40 : 0
  manager.layout.divisor = divisor
  manager.updateWritingMode('vertical-rl')

  return manager
}

function createSections(counts: number[]) {
  const sections: MeasuredSection[] = counts.map((pageCount, index) =>
    double<MeasuredSection>({
      index,
      pageCount,
      next() {
        return sections[index + 1]
      },
      prev() {
        return sections[index - 1]
      },
    }),
  )

  return sections
}

function withMeasuredSections(
  manager: DefaultViewManager,
  sections: MeasuredSection[],
) {
  manager.sectionMeasurements.count = async (section) => {
    const measuredSection = sections[section!.index]
    return measuredSection ? measuredSection.pageCount : 0
  }
}

function stubRenderedViews(manager: DefaultViewManager) {
  const createView = (section: Section) =>
    double<IframeView>({
      section,
      element: document.createElement('div'),
      pageCount() {
        return (section as MeasuredSection).pageCount
      },
      offset() {
        return { left: 0, top: 0 }
      },
    })

  manager.clear = function () {}
  manager.updateLayout = function () {}
  manager.add = async (section) => createView(section)
  manager.append = async (section) => createView(section)
  manager.prepend = async (section) => createView(section)
}

describe('DefaultViewManager pre-paginated spread', function () {
  it('removes the window unload listener when a manager is torn down', function () {
    const addListener = vi.spyOn(window, 'addEventListener')
    const removeListener = vi.spyOn(window, 'removeEventListener')

    try {
      const manager = createManager()
      manager.container = document.createElement('div')
      manager.addEventListeners()
      manager.removeEventListeners()

      assert.ok(
        addListener.mock.calls.some(
          ([event, listener]) =>
            event === 'unload' && listener === manager._onUnload,
        ),
      )
      assert.ok(
        removeListener.mock.calls.some(
          ([event, listener]) =>
            event === 'unload' && listener === manager._onUnload,
        ),
      )
    } finally {
      addListener.mockRestore()
      removeListener.mockRestore()
    }
  })

  it('pairs and navigates fixed-layout RTL spreads in reading order', async function () {
    const manager = createManager({ direction: 'rtl' })
    manager.layout.name = 'pre-paginated'
    manager.views = double<Views>({ length: 1 })
    const sections: Section[] = [
      ['page-spread-left'],
      ['page-spread-right'],
      ['page-spread-left'],
      ['page-spread-right'],
    ].map((properties, index) =>
      double<Section>({
        index,
        properties,
        next() {
          return sections[index + 1]
        },
        prev() {
          return sections[index - 1]
        },
      }),
    )

    assert.deepEqual(
      manager.prePaginatedSpreadContaining(sections[0]!),
      {
        left: sections[0]!,
        right: undefined,
      }!,
    )
    assert.deepEqual(
      manager.prePaginatedSpreadContaining(sections[1]!),
      {
        left: sections[2]!,
        right: sections[1]!,
      }!,
    )

    const displayed: {
      left: number | null | undefined
      right: number | null | undefined
    }[] = []
    manager.displayPrePaginatedSpread = async (section) => {
      const spread = manager.prePaginatedSpreadContaining(section)
      displayed.push({
        left: spread.left && spread.left.index,
        right: spread.right && spread.right.index,
      })
    }

    manager.currentPrePaginatedSpread = manager.prePaginatedSpreadContaining(
      sections[0]!,
    )
    await manager.next()
    manager.currentPrePaginatedSpread = manager.prePaginatedSpreadContaining(
      sections[1]!,
    )
    await manager.prev()

    assert.deepEqual(displayed, [
      { left: 2, right: 1 },
      { left: 0, right: undefined },
    ])
  })

  it('navigates away from fixed-layout spreads with an intentional blank slot', async function () {
    const cases = [
      {
        properties: [
          ['page-spread-right'],
          ['page-spread-right'],
          ['page-spread-left'],
        ],
        currentIndex: 1,
        direction: 'prev' as const,
        expectedIndex: 0,
      },
      {
        properties: [
          ['page-spread-left'],
          ['page-spread-left'],
          ['page-spread-right'],
        ],
        currentIndex: 0,
        direction: 'next' as const,
        expectedIndex: 1,
      },
    ]

    for (const testCase of cases) {
      const manager = createManager()
      manager.layout.name = 'pre-paginated'
      manager.views = double<Views>({ length: 1 })
      const sections: Section[] = testCase.properties.map((properties, index) =>
        double<Section>({
          index,
          properties,
          next() {
            return sections[index + 1]
          },
          prev() {
            return sections[index - 1]
          },
        }),
      )
      const displayed: number[] = []
      manager.currentPrePaginatedSpread = manager.prePaginatedSpreadContaining(
        sections[testCase.currentIndex]!,
      )
      manager.displayPrePaginatedSpread = async (section) => {
        displayed.push(section.index)
      }

      await manager[testCase.direction]()

      assert.deepEqual(displayed, [testCase.expectedIndex])
    }
  })

  it('resolves stable fixed-layout pairs from explicit and undecided slots', function () {
    const manager = createManager()
    manager.layout.name = 'pre-paginated'
    const createFixedSections = (properties: string[][]) => {
      const sections: Section[] = properties.map((sectionProperties, index) =>
        double<Section>({
          index,
          properties: sectionProperties,
          next() {
            return sections[index + 1]
          },
          prev() {
            return sections[index - 1]
          },
        }),
      )
      return sections
    }

    const beforeLeft = createFixedSections([
      ['page-spread-center'],
      ['page-spread-left'],
      ['page-spread-right'],
    ])
    const beforeRight = createFixedSections([
      ['page-spread-center'],
      ['page-spread-right'],
    ])
    const malformed = createFixedSections([
      ['page-spread-left'],
      ['page-spread-left'],
      ['page-spread-right'],
    ])

    assert.deepEqual(
      manager.prePaginatedSpreadContaining(beforeLeft[0]!),
      {
        left: undefined,
        right: beforeLeft[0]!,
      }!,
    )
    assert.deepEqual(
      manager.prePaginatedSpreadContaining(beforeLeft[1]!),
      {
        left: beforeLeft[1]!,
        right: beforeLeft[2]!,
      }!,
    )
    assert.deepEqual(
      manager.prePaginatedSpreadContaining(beforeLeft[2]!),
      {
        left: beforeLeft[1]!,
        right: beforeLeft[2]!,
      }!,
    )
    assert.deepEqual(
      manager.prePaginatedSpreadContaining(beforeRight[0]!),
      {
        left: beforeRight[0]!,
        right: beforeRight[1]!,
      }!,
    )
    assert.deepEqual(
      manager.prePaginatedSpreadContaining(malformed[0]!),
      {
        left: malformed[0]!,
        right: undefined,
      }!,
    )
    assert.deepEqual(
      manager.prePaginatedSpreadContaining(malformed[1]!),
      {
        left: malformed[1]!,
        right: malformed[2]!,
      }!,
    )
  })

  it('pairs an ordinary first spine item but preserves an explicit right page', async function () {
    const manager = createManager()
    manager.layout.name = 'pre-paginated'
    const second = double<Section>({
      index: 1,
      properties: [],
    })
    const first = double<Section>({
      index: 0,
      properties: [],
      next() {
        return second
      },
    })
    const appended: Section[] = []
    const append = async (section: Section) => {
      appended.push(section)
      return double<IframeView>({ section })
    }

    await manager.handleNextPrePaginated(false, first, append)
    await manager.handleNextPrePaginated(true, first, append)

    assert.deepEqual(appended, [second])
  })

  it('reports both fixed-layout sections in a two-page spread', function () {
    const manager = createManager()
    manager.layout.name = 'pre-paginated'
    manager.layout.width = 500
    manager.layout.columnWidth = 500
    manager.layout.pageWidth = 500
    manager.layout.spreadWidth = 1000
    manager.container = double<HTMLDivElement>({
      scrollLeft: 0,
      getBoundingClientRect() {
        return double<DOMRect>({ left: 0, right: 1000 })
      },
    })
    manager.mapping = double<Mapping>({
      page(_contents, cfiBase) {
        return { start: `${cfiBase}:start`, end: `${cfiBase}:end` }
      },
    })

    const views = [0, 1].map((index) =>
      double<IframeView>({
        section: double<Section>({
          index,
          href: `page-${index + 1}.xhtml`,
          cfiBase: `/6/${index * 2 + 2}`,
        }),
        contents: double<Contents>({}),
        offset() {
          return { left: index * 500, top: 0 }
        },
        position() {
          return double<DOMRect>({
            left: index * 500,
            right: (index + 1) * 500,
            width: 500,
          })
        },
        width() {
          return 500
        },
        pageCount() {
          return 1
        },
      }),
    )
    manager.visible = () => views

    const location = manager.paginatedLocation()

    assert.deepEqual(
      location.map(({ index, pages, totalPages }) => ({
        index,
        pages,
        totalPages,
      })),
      [
        { index: 0, pages: [1], totalPages: 1 },
        { index: 1, pages: [1], totalPages: 1 },
      ],
    )
  })

  it('reports a lone fixed-layout RTL left page from the logical spread', function () {
    const manager = createManager({ direction: 'rtl' })
    manager.layout.name = 'pre-paginated'
    manager.updateLayout = function () {}
    const section = double<Section>({
      index: 0,
      href: 'page-1.xhtml',
      cfiBase: '/6/2',
    })
    const view = double<IframeView>({
      section,
      contents: double<Contents>({}),
      width() {
        return 500
      },
      pageCount() {
        return 1
      },
    })
    const mappedRanges: number[][] = []
    manager.mapping = double<Mapping>({
      page(_contents, cfiBase, start, end) {
        mappedRanges.push([start, end])
        return { start: `${cfiBase}:start`, end: `${cfiBase}:end` }
      },
    })
    manager.views = double<Views>({
      find(candidate) {
        return candidate === section ? view : undefined
      },
    })
    manager.visible = () => []
    manager.currentPrePaginatedSpread = {
      left: section,
      right: undefined,
    }

    const location = manager.currentLocation()

    assert.deepEqual(location, [
      {
        index: 0,
        href: 'page-1.xhtml',
        pages: [1],
        totalPages: 1,
        mapping: {
          start: '/6/2:start',
          end: '/6/2:end',
        },
        startSlot: 'left',
        endSlot: 'left',
      },
    ])
    assert.deepEqual(mappedRanges, [[0, 500]])
  })
})

describe('DefaultViewManager reflowable spread', function () {
  it('uses book page progression for slot order independently of writing mode', async function () {
    const ltrVertical = createManager({ direction: 'ltr' })
    ltrVertical.updateWritingMode('vertical-rl')
    const ltrSections = createSections([2])
    withMeasuredSections(ltrVertical, ltrSections)

    const rtlHorizontal = createManager({ direction: 'rtl' })
    rtlHorizontal.updateWritingMode('horizontal-tb')
    const rtlSections = createSections([2])
    withMeasuredSections(rtlHorizontal, rtlSections)

    const ltrSpread = await ltrVertical.reflowableSpreadContaining(
      ltrVertical.reflowablePage(ltrSections[0]!, 0),
    )
    const rtlSpread = await rtlHorizontal.reflowableSpreadContaining(
      rtlHorizontal.reflowablePage(rtlSections[0]!, 0),
    )

    assert.equal(ltrSpread!.left!.pageIndex, 0)
    assert.equal(ltrSpread!.right!.pageIndex, 1)
    assert.equal(rtlSpread!.right!.pageIndex, 0)
    assert.equal(rtlSpread!.left!.pageIndex, 1)

    stubRenderedViews(rtlHorizontal)
    let renderedRtlSpread
    rtlHorizontal.applyReflowableSpreadPosition = (spread) => {
      renderedRtlSpread = spread
    }
    await rtlHorizontal.renderReflowableSpread(rtlSpread)

    assert.equal(renderedRtlSpread!.right.pageIndex, 0)
    assert.equal(renderedRtlSpread!.left.pageIndex, 1)
  })

  it('uses logical horizontal pagination for vertical-rl rtl content', function () {
    const singlePageManager = createVerticalRtlManager({ divisor: 1 })
    const spreadManager = createVerticalRtlManager({ divisor: 2 })

    assert.equal(singlePageManager.settings.axis, 'horizontal')
    assert.equal(spreadManager.settings.axis, 'horizontal')
    assert.equal(singlePageManager.canUseLogicalReflowableSpread(), true)
    assert.equal(spreadManager.canUseLogicalReflowableSpread(), true)
  })

  it('places the earlier vertical-rl page in the physical right slot', async function () {
    const manager = createVerticalRtlManager()
    const sections = createSections([3])
    withMeasuredSections(manager, sections)

    const spread = await manager.reflowableSpreadContaining(
      manager.reflowablePage(sections[0]!, 0),
    )

    assert.equal(spread!.right!.section.index, 0)
    assert.equal(spread!.right!.pageIndex, 0)
    assert.equal(spread!.left!.section.index, 0)
    assert.equal(spread!.left!.pageIndex, 1)
    assert.equal(spread!.anchor, 'right')
  })

  it('maps vertical-rl targets from the physical right edge to logical pages', function () {
    const manager = createVerticalRtlManager()
    const section = createSections([3])[0]
    const offsets = new Map([
      ['first', { left: 1450, top: 20 }],
      ['second', { left: 950, top: 20 }],
      ['third', { left: 450, top: 20 }],
    ])
    const view = double<IframeView>({
      section,
      locationOf(target) {
        return offsets.get(target.toString())!
      },
      pageCount() {
        return 3
      },
      width() {
        return 1500
      },
    })

    assert.equal(
      manager.reflowablePageForRenderedTarget(view, 'first')!.pageIndex,
      0,
    )
    assert.equal(
      manager.reflowablePageForRenderedTarget(view, 'second')!.pageIndex,
      1,
    )
    assert.equal(
      manager.reflowablePageForRenderedTarget(view, 'third')!.pageIndex,
      2,
    )
  })

  it('right aligns an explicit vertical chapter target instead of reusing the current cross-section phase', async function () {
    const manager = createVerticalRtlManager()
    const sections = createSections([1, 2])
    withMeasuredSections(manager, sections)
    manager.currentReflowableSpread = {
      right: manager.reflowablePage(sections[0]!, 0),
      left: manager.reflowablePage(sections[1]!, 0),
      anchor: 'right' as const,
    }

    const spread = await manager.reflowableSpreadForTarget(
      manager.reflowablePage(sections[1]!, 0),
      { alignTargetAsSpreadStart: true },
    )

    assert.equal(spread!.right!.section.index, 1)
    assert.equal(spread!.right!.pageIndex, 0)
    assert.equal(spread!.left!.section.index, 1)
    assert.equal(spread!.left!.pageIndex, 1)
  })

  it('left aligns an explicit horizontal chapter target without changing ordinary horizontal phase rules', async function () {
    const manager = createManager()
    const sections = createSections([1, 2])
    withMeasuredSections(manager, sections)
    manager.currentReflowableSpread = {
      left: manager.reflowablePage(sections[0]!, 0),
      right: manager.reflowablePage(sections[1]!, 0),
      anchor: 'left',
    }

    const spread = await manager.reflowableSpreadForTarget(
      manager.reflowablePage(sections[1]!, 0),
      { alignTargetAsSpreadStart: true },
    )

    assert.equal(spread!.left!.section.index, 1)
    assert.equal(spread!.left!.pageIndex, 0)
    assert.equal(spread!.right!.section.index, 1)
    assert.equal(spread!.right!.pageIndex, 1)
  })

  it('right anchors the odd final vertical-rl page with a blank left slot', async function () {
    const manager = createVerticalRtlManager()
    const sections = createSections([3])
    withMeasuredSections(manager, sections)

    const spread = await manager.reflowableSpreadContaining(
      manager.reflowablePage(sections[0]!, 2),
    )

    assert.ok(spread!.right, 'the terminal page must occupy the right slot')
    assert.equal(spread!.right.section.index, 0)
    assert.equal(spread!.right.pageIndex, 2)
    assert.equal(spread!.left, undefined)
    assert.equal(spread!.anchor, 'right')
    assert.equal(spread!.endsAtSectionEnd, true)
  })

  it('moves vertical-rl single pages forward and backward in logical order', async function () {
    const manager = createVerticalRtlManager({ divisor: 1 })
    const sections = createSections([3])
    withMeasuredSections(manager, sections)
    let renderedSpread
    manager.renderReflowableSpread = async (spread) => {
      renderedSpread = spread
    }

    manager.currentReflowableSpread = {
      right: manager.reflowablePage(sections[0]!, 0),
      anchor: 'right' as const,
    }
    await manager.nextReflowableSpread()
    assert.equal(renderedSpread!.right.pageIndex, 1)
    assert.equal(renderedSpread!.left, undefined)

    manager.currentReflowableSpread = {
      right: manager.reflowablePage(sections[0]!, 2),
      anchor: 'right' as const,
    }
    await manager.previousReflowableSpread()
    assert.equal(renderedSpread!.right.pageIndex, 1)
    assert.equal(renderedSpread!.left, undefined)
  })

  it('advances from an odd terminal page to the next section start on the right', async function () {
    const manager = createVerticalRtlManager()
    const sections = createSections([3, 4])
    withMeasuredSections(manager, sections)
    let renderedSpread
    manager.renderReflowableSpread = async (spread) => {
      renderedSpread = spread
    }
    manager.currentReflowableSpread = {
      right: manager.reflowablePage(sections[0]!, 2),
      anchor: 'right' as const,
      endsAtSectionEnd: true,
    }

    await manager.nextReflowableSpread()

    assert.equal(renderedSpread!.right.section.index, 1)
    assert.equal(renderedSpread!.right.pageIndex, 0)
    assert.equal(renderedSpread!.left.section.index, 1)
    assert.equal(renderedSpread!.left.pageIndex, 1)
  })

  it('reports vertical-rl locations in right-to-left reading order', function () {
    const manager = createVerticalRtlManager()
    const section = double<MeasuredSection>({
      ...createSections([3])[0]!,
      href: 'synthetic-vertical.xhtml',
      cfiBase: '/6/2[synthetic]',
    })
    const ranges: { start: number; end: number }[] = []
    const view = double<IframeView>({
      section,
      contents: double<Contents>({}),
      pageCount() {
        return 3
      },
      width() {
        return 1500
      },
    })

    manager.currentReflowableSpread = {
      right: manager.reflowablePage(section, 0),
      left: manager.reflowablePage(section, 1),
      anchor: 'right' as const,
    }
    manager.views = double<Views>({
      find(candidate) {
        return candidate?.index === section.index ? view : undefined
      },
    })
    manager.mapping = double<Mapping>({
      page(_contents, _cfiBase, start, end) {
        ranges.push({ start, end })
        return { start: `start:${start}`, end: `end:${end}` }
      },
    })

    const location = manager.reflowableSpreadLocation()

    assert.deepEqual(location[0]!.pages, [1, 2])
    assert.equal(location[0]!.startSlot, 'right')
    assert.equal(location[0]!.endSlot, 'left')
    assert.deepEqual(ranges[0], { start: 500, end: 1500 })
  })

  it('uses layout style signature as part of the page count cache key', function () {
    const manager = createManager()
    const section = double<Section>({ index: 1 })

    manager.viewSettings.layoutStyleSignature = 'font-size:16'
    const small = manager.sectionMeasurements.layoutKey(section)

    manager.viewSettings.layoutStyleSignature = 'font-size:20'
    const large = manager.sectionMeasurements.layoutKey(section)

    assert.notEqual(small, large)
    assert.equal(small.endsWith(':font-size:16'), true)
    assert.equal(large.endsWith(':font-size:20'), true)
  })

  it('can reset the current spread without clearing measured page counts', function () {
    const manager = createManager()

    manager.currentReflowableSpread = {
      left: double<ReaderPage>({ pageIndex: 0 }),
    }
    manager.sectionMeasurements.pageCounts.cached = 3
    manager.resetReflowablePageState(false)

    assert.equal(manager.currentReflowableSpread, undefined)
    assert.equal(manager.sectionMeasurements.pageCounts.cached, 3)
  })

  it('can reset the current spread and measured page counts together', function () {
    const manager = createManager()

    manager.currentReflowableSpread = {
      left: double<ReaderPage>({ pageIndex: 0 }),
    }
    manager.sectionMeasurements.pageCounts.cached = 3
    manager.resetReflowablePageState(true)

    assert.equal(manager.currentReflowableSpread, undefined)
    assert.deepEqual(manager.sectionMeasurements.pageCounts, {})
  })

  it('fills the right page with the next section when the left section ends', async function () {
    const manager = createManager()
    const sections = createSections([3, 6])
    withMeasuredSections(manager, sections)

    const spread = await manager.reflowableSpreadFromLeft(
      manager.reflowablePage(sections[0]!, 2),
    )

    assert.equal(spread!.left!.section.index, 0)
    assert.equal(spread!.left!.pageIndex, 2)
    assert.equal(spread!.right!.section.index, 1)
    assert.equal(spread!.right!.pageIndex, 0)
  })

  it('continues from a cross-section right page without repeating it on next', async function () {
    const manager = createManager()
    const sections = createSections([3, 6])
    withMeasuredSections(manager, sections)

    let renderedSpread
    manager.renderReflowableSpread = async (spread) => {
      renderedSpread = spread
    }
    manager.currentReflowableSpread = {
      left: manager.reflowablePage(sections[0]!, 2),
      right: manager.reflowablePage(sections[1]!, 0),
    }

    await manager.nextReflowableSpread()

    assert.equal(renderedSpread!.left.section.index, 1)
    assert.equal(renderedSpread!.left.pageIndex, 1)
    assert.equal(renderedSpread!.right.section.index, 1)
    assert.equal(renderedSpread!.right.pageIndex, 2)
  })

  it('returns to the previous section last spread from a section first page', async function () {
    const manager = createManager()
    const sections = createSections([9, 10])
    withMeasuredSections(manager, sections)

    let renderedSpread
    manager.renderReflowableSpread = async (spread) => {
      renderedSpread = spread
    }
    manager.currentReflowableSpread = {
      left: manager.reflowablePage(sections[1]!, 0),
      right: manager.reflowablePage(sections[1]!, 1),
    }

    await manager.previousReflowableSpread()

    assert.equal(renderedSpread!.left.section.index, 0)
    assert.equal(renderedSpread!.left.pageIndex, 7)
    assert.equal(renderedSpread!.right.section.index, 0)
    assert.equal(renderedSpread!.right.pageIndex, 8)
    assert.equal(renderedSpread!.endsAtSectionEnd, true)
  })

  it('keeps a one-page previous section in the right slot when turning backward', async function () {
    const manager = createManager()
    const sections = createSections([1, 2])
    withMeasuredSections(manager, sections)
    stubRenderedViews(manager)

    let renderedSpread
    manager.applyReflowableSpreadPosition = (spread) => {
      renderedSpread = spread
    }
    manager.currentReflowableSpread = {
      left: manager.reflowablePage(sections[1]!, 0),
      right: manager.reflowablePage(sections[1]!, 1),
    }

    await manager.previousReflowableSpread()

    assert.equal(renderedSpread!.left, undefined)
    assert.equal(renderedSpread!.right.section.index, 0)
    assert.equal(renderedSpread!.right.pageIndex, 0)
    assert.equal(renderedSpread!.anchor, 'right')
    assert.equal(renderedSpread!.endsAtSectionEnd, true)
  })

  it('keeps LTR and RTL page turns continuous while retaining compatible rendered views', async function () {
    const cases = [
      { direction: 'ltr', create: () => createManager() },
      { direction: 'rtl', create: () => createVerticalRtlManager() },
    ]

    for (const testCase of cases) {
      const manager = testCase.create()
      const sections = createSections([3, 1, 6])
      if (testCase.direction === 'rtl') {
        sections[0]!.writingMode = 'horizontal-tb'
        sections[1]!.writingMode = 'vertical-rl'
      }
      withMeasuredSections(manager, sections)
      manager.views = new Views()
      manager.scrollTo = function () {}
      manager.updateLayout = function () {}
      manager.mapping = double<Mapping>({
        page(_contents, _cfiBase, start, end) {
          return { start: String(start), end: String(end) }
        },
      })
      const clear = vi.spyOn(manager, 'clear')

      const createView = (section: Section) =>
        double<IframeView>({
          section,
          displayed: true,
          destroyed: false,
          writingMode:
            (section as MeasuredSection).writingMode || 'horizontal-tb',
          contents: double<Contents>({}),
          settings: {
            layoutStyleSignature:
              manager.viewSettings.layoutStyleSignature || '',
          },
          element: double<HTMLDivElement>({
            style: double<CSSStyleDeclaration>({}),
          }),
          pageCount() {
            return (section as MeasuredSection).pageCount
          },
          width() {
            return (
              (section as MeasuredSection).pageCount * manager.layout.pageWidth
            )
          },
          offset() {
            return { left: 0, top: 0 }
          },
          show() {},
          hide() {},
          destroy() {
            this.displayed = false
            this.destroyed = true
          },
        })
      const addView = (
        section: Section,
        position: 'append' | 'prepend' = 'append',
      ) => {
        const view = createView(section)
        manager.views[position](view)
        manager.updateWritingMode(view.writingMode)
        return view
      }
      manager.add = vi.fn(async (section) => addView(section))
      manager.append = vi.fn(async (section) => addView(section))
      manager.prepend = vi.fn(async (section) => addView(section, 'prepend'))
      const lifecycleMethods = [
        clear,
        manager.add,
        manager.append,
        manager.prepend,
      ]

      const spreadSnapshot = () => {
        const address = (page: ReaderPage | undefined) =>
          page
            ? { sectionIndex: page.section.index, pageIndex: page.pageIndex }
            : undefined

        return {
          left: address(manager.currentReflowableSpread!.left),
          right: address(manager.currentReflowableSpread!.right),
          endsAtSectionEnd:
            manager.currentReflowableSpread!.endsAtSectionEnd === true,
        }
      }
      const expectedSpread = (
        earlier: PageAddress | undefined,
        later: PageAddress | undefined,
        endsAtSectionEnd = false,
      ) =>
        testCase.direction === 'rtl'
          ? { right: earlier, left: later, endsAtSectionEnd }
          : { left: earlier, right: later, endsAtSectionEnd }
      const page = (sectionIndex: number, pageIndex: number) => ({
        sectionIndex,
        pageIndex,
      })
      const turn = async (
        direction: 'nextReflowableSpread' | 'previousReflowableSpread',
        expected: ReturnType<typeof expectedSpread>,
      ) => {
        await manager[direction]()
        assert.deepEqual(spreadSnapshot(), expected)
      }

      const initialView = addView(sections[0]!)
      manager.currentReflowableSpread =
        testCase.direction === 'rtl'
          ? await manager.reflowableSpreadFromEarlier(
              manager.reflowablePage(sections[0]!, 0),
            )
          : await manager.reflowableSpreadFromLeft(
              manager.reflowablePage(sections[0]!, 0),
            )
      manager.applyReflowableSpreadPosition(manager.currentReflowableSpread!, {
        [sections[0]!.index]: initialView,
      })

      const initialSpread = expectedSpread(page(0, 0), page(0, 1))
      assert.deepEqual(spreadSnapshot(), initialSpread)
      await turn('nextReflowableSpread', expectedSpread(page(0, 2), page(1, 0)))
      await turn('nextReflowableSpread', expectedSpread(page(2, 0), page(2, 1)))

      const stableView = manager.views.find(sections[2]!)
      assert.ok(stableView)
      lifecycleMethods.forEach((method) => vi.mocked(method).mockClear())
      await turn('nextReflowableSpread', expectedSpread(page(2, 2), page(2, 3)))
      assert.equal(manager.views.find(sections[2]!), stableView)
      assert.equal(stableView.destroyed, false)
      await turn(
        'previousReflowableSpread',
        expectedSpread(page(2, 0), page(2, 1)),
      )
      assert.equal(manager.views.find(sections[2]!), stableView)
      await turn('nextReflowableSpread', expectedSpread(page(2, 2), page(2, 3)))
      assert.equal(manager.views.find(sections[2]!), stableView)
      await turn(
        'previousReflowableSpread',
        expectedSpread(page(2, 0), page(2, 1)),
      )
      assert.equal(manager.views.find(sections[2]!), stableView)
      lifecycleMethods.forEach((method) =>
        assert.equal(vi.mocked(method).mock.calls.length, 0),
      )

      await turn(
        'previousReflowableSpread',
        expectedSpread(page(0, 2), page(1, 0), true),
      )
      const crossSectionView = manager.views.find(sections[0]!)
      assert.ok(crossSectionView)
      await turn('previousReflowableSpread', initialSpread)
      assert.equal(manager.views.find(sections[0]!), crossSectionView)
      assert.deepEqual(spreadSnapshot(), initialSpread)
      if (testCase.direction === 'rtl') {
        assert.deepEqual(manager.reflowableSpreadLocation()[0]!.mapping, {
          start: '0',
          end: '1000',
        })
      }
    }
  })

  it('resolves a render spread without mutating the requested spread', async function () {
    const manager = createManager()
    const sections = createSections([9, 10])
    withMeasuredSections(manager, sections)
    stubRenderedViews(manager)

    let renderedSpread
    manager.applyReflowableSpreadPosition = (spread) => {
      renderedSpread = spread
    }

    const requestedSpread = {
      right: manager.reflowablePage(sections[1]!, 0),
      anchor: 'right' as const,
      endsAtSectionEnd: true,
    }

    await manager.renderReflowableSpread(requestedSpread)

    assert.equal(requestedSpread.right.section.index, 1)
    assert.equal(requestedSpread.right.pageIndex, 0)
    assert.equal(renderedSpread!.right.section.index, 1)
    assert.equal(renderedSpread!.right.pageIndex, 9)
  })

  it('keeps a left-slot terminal page left while resolving the new last page', async function () {
    const manager = createManager()
    const sections = createSections([3])
    withMeasuredSections(manager, sections)
    stubRenderedViews(manager)

    let renderedSpread
    manager.applyReflowableSpreadPosition = (spread) => {
      renderedSpread = spread
    }

    await manager.renderReflowableSpread({
      left: manager.reflowablePage(sections[0]!, 0),
      anchor: 'left',
      endsAtSectionEnd: true,
    })

    assert.equal(renderedSpread!.left.section.index, 0)
    assert.equal(renderedSpread!.left.pageIndex, 2)
    assert.equal(renderedSpread!.right, undefined)
    assert.equal(renderedSpread!.anchor, 'left')
    assert.equal(renderedSpread!.endsAtSectionEnd, true)
  })
})
