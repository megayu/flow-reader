import { assert } from 'vitest'

import DefaultViewManager from '../src/managers/default'

function createManager(settings = {}) {
  const manager = new DefaultViewManager({
    settings: {
      axis: 'horizontal',
      direction: 'ltr',
      ...settings,
    },
    view: function View() {},
    request: function request() {},
    queue: {},
  })

  manager.layout = {
    width: 1000,
    height: 800,
    pageWidth: 500,
    columnWidth: 460,
    gap: 40,
    divisor: 2,
    name: 'reflowable',
  }
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

function createSections(counts) {
  const sections = counts.map((pageCount, index) => ({
    index,
    pageCount,
    next() {
      return sections[index + 1]
    },
    prev() {
      return sections[index - 1]
    },
  }))

  return sections
}

function withMeasuredSections(manager, sections) {
  manager.measureReflowableSectionPageCount = async (section) => {
    const measuredSection = sections[section.index]
    return measuredSection ? measuredSection.pageCount : 0
  }
}

function stubRenderedViews(manager) {
  const createView = (section) => ({
    section,
    element: {
      style: {},
    },
    pageCount() {
      return section.pageCount
    },
    offset() {
      return { left: 0 }
    },
  })

  manager.clear = function () {}
  manager.updateLayout = function () {}
  manager.add = async (section) => createView(section)
  manager.append = async (section) => createView(section)
  manager.prepend = async (section) => createView(section)
}

describe('DefaultViewManager reflowable spread', function () {
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
      manager.reflowablePage(sections[0], 0),
    )

    assert.equal(spread.right.section.index, 0)
    assert.equal(spread.right.pageIndex, 0)
    assert.equal(spread.left.section.index, 0)
    assert.equal(spread.left.pageIndex, 1)
    assert.equal(spread.anchor, 'right')
  })

  it('maps vertical-rl targets from the physical right edge to logical pages', function () {
    const manager = createVerticalRtlManager()
    const section = createSections([3])[0]
    const offsets = new Map([
      ['first', { left: 1450, top: 20 }],
      ['second', { left: 950, top: 20 }],
      ['third', { left: 450, top: 20 }],
    ])
    const view = {
      section,
      locationOf(target) {
        return offsets.get(target)
      },
      pageCount() {
        return 3
      },
      width() {
        return 1500
      },
    }

    assert.equal(
      manager.reflowablePageForRenderedTarget(view, 'first').pageIndex,
      0,
    )
    assert.equal(
      manager.reflowablePageForRenderedTarget(view, 'second').pageIndex,
      1,
    )
    assert.equal(
      manager.reflowablePageForRenderedTarget(view, 'third').pageIndex,
      2,
    )
  })

  it('right aligns an explicit vertical chapter target instead of reusing the current cross-section phase', async function () {
    const manager = createVerticalRtlManager()
    const sections = createSections([1, 2])
    withMeasuredSections(manager, sections)
    manager.currentReflowableSpread = {
      right: manager.reflowablePage(sections[0], 0),
      left: manager.reflowablePage(sections[1], 0),
      anchor: 'right',
    }

    const spread = await manager.reflowableSpreadForTarget(
      manager.reflowablePage(sections[1], 0),
      { alignTargetAsSpreadStart: true },
    )

    assert.equal(spread.right.section.index, 1)
    assert.equal(spread.right.pageIndex, 0)
    assert.equal(spread.left.section.index, 1)
    assert.equal(spread.left.pageIndex, 1)
  })

  it('left aligns an explicit horizontal chapter target without changing ordinary horizontal phase rules', async function () {
    const manager = createManager()
    const sections = createSections([1, 2])
    withMeasuredSections(manager, sections)
    manager.currentReflowableSpread = {
      left: manager.reflowablePage(sections[0], 0),
      right: manager.reflowablePage(sections[1], 0),
      anchor: 'left',
    }

    const spread = await manager.reflowableSpreadForTarget(
      manager.reflowablePage(sections[1], 0),
      { alignTargetAsSpreadStart: true },
    )

    assert.equal(spread.left.section.index, 1)
    assert.equal(spread.left.pageIndex, 0)
    assert.equal(spread.right.section.index, 1)
    assert.equal(spread.right.pageIndex, 1)
  })

  it('right anchors the odd final vertical-rl page with a blank left slot', async function () {
    const manager = createVerticalRtlManager()
    const sections = createSections([3])
    withMeasuredSections(manager, sections)

    const spread = await manager.reflowableSpreadContaining(
      manager.reflowablePage(sections[0], 2),
    )

    assert.ok(spread.right, 'the terminal page must occupy the right slot')
    assert.equal(spread.right.section.index, 0)
    assert.equal(spread.right.pageIndex, 2)
    assert.equal(spread.left, undefined)
    assert.equal(spread.anchor, 'right')
    assert.equal(spread.endsAtSectionEnd, true)
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
      right: manager.reflowablePage(sections[0], 0),
      anchor: 'right',
    }
    await manager.nextReflowableSpread()
    assert.equal(renderedSpread.right.pageIndex, 1)
    assert.equal(renderedSpread.left, undefined)

    manager.currentReflowableSpread = {
      right: manager.reflowablePage(sections[0], 2),
      anchor: 'right',
    }
    await manager.previousReflowableSpread()
    assert.equal(renderedSpread.right.pageIndex, 1)
    assert.equal(renderedSpread.left, undefined)
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
      right: manager.reflowablePage(sections[0], 2),
      anchor: 'right',
      endsAtSectionEnd: true,
    }

    await manager.nextReflowableSpread()

    assert.equal(renderedSpread.right.section.index, 1)
    assert.equal(renderedSpread.right.pageIndex, 0)
    assert.equal(renderedSpread.left.section.index, 1)
    assert.equal(renderedSpread.left.pageIndex, 1)
  })

  it('reports vertical-rl locations in right-to-left reading order', function () {
    const manager = createVerticalRtlManager()
    const section = {
      ...createSections([3])[0],
      href: 'synthetic-vertical.xhtml',
      cfiBase: '/6/2[synthetic]',
    }
    const ranges = []
    const view = {
      section,
      contents: {},
      pageCount() {
        return 3
      },
      width() {
        return 1500
      },
    }

    manager.currentReflowableSpread = {
      right: manager.reflowablePage(section, 0),
      left: manager.reflowablePage(section, 1),
      anchor: 'right',
    }
    manager.views = {
      find(candidate) {
        return candidate?.index === section.index ? view : undefined
      },
    }
    manager.mapping = {
      page(_contents, _cfiBase, start, end) {
        ranges.push({ start, end })
        return { start: `start:${start}`, end: `end:${end}` }
      },
    }

    const location = manager.reflowableSpreadLocation()

    assert.deepEqual(location[0].pages, [1, 2])
    assert.equal(location[0].startSlot, 'right')
    assert.equal(location[0].endSlot, 'left')
    assert.deepEqual(ranges[0], { start: 500, end: 1500 })
  })

  it('uses layout style signature as part of the page count cache key', function () {
    const manager = createManager()
    const section = { index: 1 }

    manager.viewSettings.layoutStyleSignature = 'font-size:16'
    const small = manager.reflowableLayoutCacheKey(section)

    manager.viewSettings.layoutStyleSignature = 'font-size:20'
    const large = manager.reflowableLayoutCacheKey(section)

    assert.notEqual(small, large)
    assert.equal(small.endsWith(':font-size:16'), true)
    assert.equal(large.endsWith(':font-size:20'), true)
  })

  it('can reset the current spread without clearing measured page counts', function () {
    const manager = createManager()

    manager.currentReflowableSpread = { left: { pageIndex: 0 } }
    manager.reflowablePageCountCache.cached = 3
    manager.resetReflowablePageState(false)

    assert.equal(manager.currentReflowableSpread, undefined)
    assert.equal(manager.reflowablePageCountCache.cached, 3)
  })

  it('can reset the current spread and measured page counts together', function () {
    const manager = createManager()

    manager.currentReflowableSpread = { left: { pageIndex: 0 } }
    manager.reflowablePageCountCache.cached = 3
    manager.resetReflowablePageState(true)

    assert.equal(manager.currentReflowableSpread, undefined)
    assert.deepEqual(manager.reflowablePageCountCache, {})
  })

  it('fills the right page with the next section when the left section ends', async function () {
    const manager = createManager()
    const sections = createSections([3, 6])
    withMeasuredSections(manager, sections)

    const spread = await manager.reflowableSpreadFromLeft(
      manager.reflowablePage(sections[0], 2),
    )

    assert.equal(spread.left.section.index, 0)
    assert.equal(spread.left.pageIndex, 2)
    assert.equal(spread.right.section.index, 1)
    assert.equal(spread.right.pageIndex, 0)
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
      left: manager.reflowablePage(sections[0], 2),
      right: manager.reflowablePage(sections[1], 0),
    }

    await manager.nextReflowableSpread()

    assert.equal(renderedSpread.left.section.index, 1)
    assert.equal(renderedSpread.left.pageIndex, 1)
    assert.equal(renderedSpread.right.section.index, 1)
    assert.equal(renderedSpread.right.pageIndex, 2)
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
      left: manager.reflowablePage(sections[1], 0),
      right: manager.reflowablePage(sections[1], 1),
    }

    await manager.previousReflowableSpread()

    assert.equal(renderedSpread.left.section.index, 0)
    assert.equal(renderedSpread.left.pageIndex, 7)
    assert.equal(renderedSpread.right.section.index, 0)
    assert.equal(renderedSpread.right.pageIndex, 8)
    assert.equal(renderedSpread.endsAtSectionEnd, true)
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
      right: manager.reflowablePage(sections[1], 0),
      anchor: 'right',
      endsAtSectionEnd: true,
    }

    await manager.renderReflowableSpread(requestedSpread)

    assert.equal(requestedSpread.right.section.index, 1)
    assert.equal(requestedSpread.right.pageIndex, 0)
    assert.equal(renderedSpread.right.section.index, 1)
    assert.equal(renderedSpread.right.pageIndex, 9)
  })
})
