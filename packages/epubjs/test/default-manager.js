/* eslint-env mocha */

import assert from 'assert'

import DefaultViewManager from '../src/managers/default'

function createManager() {
  const manager = new DefaultViewManager({
    settings: {
      axis: 'horizontal',
      direction: 'ltr',
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
