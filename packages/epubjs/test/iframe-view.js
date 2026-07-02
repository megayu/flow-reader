/* eslint-env mocha */

import assert from 'assert'

import IframeView from '../src/managers/views/iframe'

function createView({ pageCount = 1, direction = 'ltr', rect }) {
  const view = new IframeView(
    { index: 0 },
    {
      axis: 'horizontal',
      direction,
      layout: {
        name: 'reflowable',
        pageWidth: 500,
      },
    },
  )

  view.layout = view.settings.layout
  view._contentPageCount = pageCount
  view.contents = {
    content: document.createElement('div'),
  }
  view.contentBounds = () => rect

  return view
}

describe('IframeView first page positioning', function () {
  it('centers clipped first-page content for single-page sections', function () {
    const view = createView({
      rect: { left: 300, right: 650, top: 0, bottom: 100 },
    })

    assert.equal(view.singlePageFirstPageOffset(500), -225)
  })

  it('does not offset multi-page sections', function () {
    const view = createView({
      pageCount: 2,
      rect: { left: 300, right: 650, top: 0, bottom: 100 },
    })

    assert.equal(view.singlePageFirstPageOffset(1000), 0)
  })

  it('does not offset content already inside the first page', function () {
    const view = createView({
      rect: { left: 360, right: 490, top: 0, bottom: 100 },
    })

    assert.equal(view.singlePageFirstPageOffset(500), 0)
  })

  it('applies and clears the single-page first-page translate', function () {
    const view = createView({
      rect: { left: 300, right: 650, top: 0, bottom: 100 },
    })

    view.applySinglePageFirstPageOffset(500)
    assert.equal(view.contents.content.style.translate, '-225px')

    view.clearSinglePageFirstPageOffset()
    assert.equal(view.contents.content.style.translate, '')
  })
})

describe('IframeView trailing blank page trimming', function () {
  it('treats a two-page background-only visual section as one page', function () {
    const view = createView({})
    view.hasContentInRange = () => false
    view.hasPageVisualBackground = () => true

    assert.equal(view.trimTrailingBlankPages(1000), 500)
  })

  it('treats centered single-page content crossing the page edge as one page', function () {
    const view = createView({
      rect: { left: 300, right: 650, top: 0, bottom: 100 },
    })
    view.hasContentInRange = (start) => start >= 500
    view.contentRangeSummary = () => ({
      bounds: { left: 300, right: 650, top: 0, bottom: 100 },
      crossesPageBoundary: true,
      startsInsideSecondPage: false,
    })

    assert.equal(view.trimTrailingBlankPages(1000), 500)
  })

  it('keeps real two-page content as two pages', function () {
    const view = createView({
      rect: { left: 24, right: 960, top: 0, bottom: 700 },
    })
    view.hasContentInRange = (start) => start >= 500
    view.contentRangeSummary = () => ({
      bounds: { left: 24, right: 960, top: 0, bottom: 700 },
      crossesPageBoundary: true,
      startsInsideSecondPage: false,
    })

    assert.equal(view.trimTrailingBlankPages(1000), 1000)
  })

  it('keeps compact content that starts inside the second page as two pages', function () {
    const view = createView({
      rect: { left: 24, right: 700, top: 0, bottom: 700 },
    })
    view.hasContentInRange = (start) => start >= 500
    view.contentRangeSummary = () => ({
      bounds: { left: 24, right: 700, top: 0, bottom: 700 },
      crossesPageBoundary: true,
      startsInsideSecondPage: true,
    })

    assert.equal(view.trimTrailingBlankPages(1000), 1000)
  })
})
