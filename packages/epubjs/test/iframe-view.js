import { assert } from 'vitest'

import IframeView from '../src/managers/views/iframe'
import Rendition from '../src/rendition'
import { EVENTS } from '../src/utils/constants'

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

function setContentRects(view, rects) {
  view.eachContentRect = (callback) => {
    for (const rect of rects) {
      if (callback(rect)) {
        return true
      }
    }

    return false
  }
}

function createTitleImageView({
  blockWidth = 100,
  marginBottom = -100,
  withHeading = true,
} = {}) {
  const view = createView({})
  const body = document.createElement('body')
  const block = document.createElement('div')
  const image = document.createElement('img')

  image.setAttribute('src', '../Images/ch.png')
  block.appendChild(image)
  body.appendChild(block)

  if (withHeading) {
    const heading = document.createElement('h2')
    heading.textContent = '第一章'
    body.appendChild(heading)
  }

  view.contents = {
    content: body,
    document,
    window: {
      getComputedStyle(element) {
        if (element === block) {
          return {
            marginBottom: `${marginBottom}px`,
            width: `${blockWidth}px`,
          }
        }

        return {
          marginBottom: '0px',
          width: '500px',
        }
      },
    },
  }

  return { block, image, view }
}

function createLeadingBackgroundBlockView({
  backgroundColor = 'rgb(72, 117, 185)',
  backgroundImage = 'none',
  direction = 'ltr',
  marginLeft = '-64px',
  marginRight = '-64px',
  paddingLeft = '20px',
  paddingRight = '22px',
} = {}) {
  const view = createView({ direction })
  view.layout.columnWidth = 460

  const body = document.createElement('body')
  const heading = document.createElement('h1')
  const paragraph = document.createElement('p')

  heading.className = 'chapter-title'
  heading.textContent = 'Chapter'
  paragraph.textContent = 'Synthetic paragraph.'
  body.appendChild(heading)
  body.appendChild(paragraph)

  view.contents = {
    content: body,
    document,
    window: {
      getComputedStyle(element) {
        if (element === body) {
          return {
            paddingLeft,
            paddingRight,
          }
        }

        if (element === heading) {
          return {
            backgroundColor,
            backgroundImage,
            marginLeft,
            marginRight,
          }
        }

        return {
          backgroundColor: 'rgba(0, 0, 0, 0)',
          backgroundImage: 'none',
          marginLeft: '0px',
          marginRight: '0px',
        }
      },
    },
  }

  return { heading, view }
}

describe('IframeView vertical writing pagination', function () {
  it('reports vertical-rl writing independently from the horizontal page axis', async function () {
    let formattedAxis
    let emittedAxis
    const layout = {
      name: 'reflowable',
      height: 800,
      pageWidth: 500,
      delta: 500,
      format(_contents, _section, axis) {
        formattedAxis = axis
      },
    }
    const view = new IframeView(
      {
        index: 0,
        render: async () =>
          '<html><body>Synthetic vertical text.</body></html>',
      },
      {
        axis: 'horizontal',
        direction: 'rtl',
        flow: 'paginated',
        height: 800,
        width: 1000,
        layout,
      },
    )

    view.create = () => {
      view.iframe = document.createElement('iframe')
      return view.iframe
    }
    view.size = () => undefined
    view.load = async () => {
      view.contents = {
        writingMode: () => 'vertical-rl',
      }
    }
    view.fitLeadingBlockBackgroundsBeforeMeasure = () => false
    view.fitLeadingTitleImagesBeforeMeasure = () => false
    view.fitMediaBeforeMeasure = () => undefined
    view.addListeners = () => undefined
    view.expand = () => undefined
    view.on(EVENTS.VIEWS.AXIS, (axis) => {
      emittedAxis = axis
    })

    await view.render(() => undefined)

    assert.equal(view.writingMode, 'vertical-rl')
    assert.equal(view.settings.axis, 'horizontal')
    assert.equal(emittedAxis, 'horizontal')
    assert.equal(formattedAxis, 'horizontal')
    assert.equal(layout.delta, 500)
  })

  it('places a vertical-rl wavy definition line on the glyph left side', function () {
    const view = createView({})

    assert.equal(
      typeof view.wavyUnderlineGeometry,
      'function',
      'vertical underline geometry must be exposed by the rendered view',
    )

    const geometry = view.wavyUnderlineGeometry(
      { left: 300, top: 100, width: 24, height: 180 },
      { amplitude: 2, gap: 2, period: 8, writingMode: 'vertical-rl' },
    )

    assert.equal(geometry.orientation, 'vertical')
    assert.equal(geometry.side, 'left')
    assert.equal(geometry.x < 300, true)
    assert.equal(geometry.start, 100)
    assert.equal(geometry.length, 180)
  })

  it('places a vertical-rl annotation underline on the glyph left side', function () {
    const view = createView({})

    const geometry = view.underlineGeometry(
      { left: 300, top: 100, width: 24, height: 180 },
      { gap: 1.5, writingMode: 'vertical-rl' },
    )

    assert.equal(geometry.orientation, 'vertical')
    assert.equal(geometry.side, 'left')
    assert.equal(geometry.x < 300, true)
    assert.equal(geometry.start, 100)
    assert.equal(geometry.length, 180)
  })

  it('invalidates cached page geometry when the physical page width changes', function () {
    const view = createView({ pageCount: 4 })
    view._contentWidth = 2000
    view._needsReframe = false
    let stateDuringExpand
    view.expand = () => {
      stateDuringExpand = {
        contentPageCount: view._contentPageCount,
        contentWidth: view._contentWidth,
        needsReframe: view._needsReframe,
      }
    }

    view.setLayout({
      name: 'reflowable',
      pageWidth: 1000,
      format: () => undefined,
    })

    assert.deepEqual(stateDuringExpand, {
      contentPageCount: undefined,
      contentWidth: undefined,
      needsReframe: true,
    })
  })
})

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

describe('IframeView leading title image fitting', function () {
  it('clamps narrow negative-margin title images before measurement', function () {
    const { image, view } = createTitleImageView()

    assert.equal(view.fitLeadingTitleImagesBeforeMeasure(), true)
    assert.equal(
      image.getAttribute('data-epubjs-leading-title-image-clamped'),
      'true',
    )
    assert.equal(image.style.getPropertyValue('max-width'), '100%')
    assert.equal(image.style.getPropertyPriority('max-width'), 'important')
    assert.equal(image.style.getPropertyValue('height'), 'auto')
    assert.equal(image.style.getPropertyPriority('height'), 'important')
  })

  it('does not clamp normal-width leading images', function () {
    const { image, view } = createTitleImageView({ blockWidth: 360 })

    assert.equal(view.fitLeadingTitleImagesBeforeMeasure(), false)
    assert.equal(
      image.hasAttribute('data-epubjs-leading-title-image-clamped'),
      false,
    )
  })

  it('does not clamp leading images without following headings', function () {
    const { image, view } = createTitleImageView({ withHeading: false })

    assert.equal(view.fitLeadingTitleImagesBeforeMeasure(), false)
    assert.equal(
      image.hasAttribute('data-epubjs-leading-title-image-clamped'),
      false,
    )
  })
})

describe('IframeView leading background block fitting', function () {
  it('clamps leading background heading margins to page padding before measurement', function () {
    const { heading, view } = createLeadingBackgroundBlockView()

    assert.equal(view.fitLeadingBlockBackgroundsBeforeMeasure(), true)
    assert.equal(heading.style.getPropertyValue('margin-left'), '-20px')
    assert.equal(heading.style.getPropertyPriority('margin-left'), 'important')
    assert.equal(heading.style.getPropertyValue('margin-right'), '-22px')
    assert.equal(heading.style.getPropertyPriority('margin-right'), 'important')
  })

  it('does not clamp leading headings without a visible background', function () {
    const { heading, view } = createLeadingBackgroundBlockView({
      backgroundColor: 'rgba(0, 0, 0, 0)',
    })

    assert.equal(view.fitLeadingBlockBackgroundsBeforeMeasure(), false)
    assert.equal(heading.style.getPropertyValue('margin-left'), '')
    assert.equal(heading.style.getPropertyValue('margin-right'), '')
  })

  it('does not clamp leading background headings whose margins stay within page padding', function () {
    const { heading, view } = createLeadingBackgroundBlockView({
      marginLeft: '-12px',
      marginRight: '-16px',
    })

    assert.equal(view.fitLeadingBlockBackgroundsBeforeMeasure(), false)
    assert.equal(heading.style.getPropertyValue('margin-left'), '')
    assert.equal(heading.style.getPropertyValue('margin-right'), '')
  })

  it('does not clamp rtl background headings', function () {
    const { heading, view } = createLeadingBackgroundBlockView({
      direction: 'rtl',
    })

    assert.equal(view.fitLeadingBlockBackgroundsBeforeMeasure(), false)
    assert.equal(heading.style.getPropertyValue('margin-left'), '')
    assert.equal(heading.style.getPropertyValue('margin-right'), '')
  })
})

describe('IframeView media fitting', function () {
  it('preserves the containing block width cap after rendition hooks', async function () {
    const view = createView({})
    const content = document.createElement('div')
    const section = document.createElement('section')
    const image = document.createElement('img')
    const stylesheets = []

    view.layout.columnWidth = 500
    content.style.width = '500px'
    section.style.boxSizing = 'border-box'
    section.style.width = '100%'
    section.style.padding = '0 40px'
    image.setAttribute('width', '1000')
    image.setAttribute('height', '100')
    section.appendChild(image)
    content.appendChild(section)
    document.body.appendChild(content)
    Object.defineProperty(content, 'offsetHeight', { value: 800 })

    view.contents = {
      content,
      window,
      addStylesheetRules(nextRules) {
        const stylesheet = document.createElement('style')
        stylesheet.textContent = `img { max-width: ${nextRules.img['max-width']}; }`
        document.head.appendChild(stylesheet)
        stylesheets.push(stylesheet)
      },
    }

    try {
      view.fitMediaBeforeMeasure()
      await Rendition.prototype.adjustImages.call(
        { _layout: view.layout },
        view.contents,
      )

      const imageBounds = image.getBoundingClientRect()
      const sectionBounds = section.getBoundingClientRect()

      assert.equal(imageBounds.width, 420)
      assert.isAtMost(imageBounds.right, sectionBounds.right - 40)
    } finally {
      stylesheets.forEach((stylesheet) => stylesheet.remove())
      content.remove()
    }
  })
})

describe('IframeView trailing blank page trimming', function () {
  it('normalizes an oversized sole wrapper after content trims to one page', function () {
    const view = createView({})
    const body = document.createElement('body')
    const wrapper = document.createElement('div')

    wrapper.style.height = '300%'
    wrapper.appendChild(document.createElement('img'))
    body.appendChild(wrapper)

    view.settings.flow = 'paginated'
    view.contents = {
      content: body,
      textWidth: () => (wrapper.style.height === '100%' ? 500 : 1500),
      fillReadablePageBackgrounds: () => undefined,
    }
    view.iframe = document.createElement('iframe')
    view.trimTrailingBlankPages = () => 500
    view.reframe = (width, height) => {
      view._width = width
      view._height = height
    }
    view.clearSinglePageFirstPageOffset = () => undefined
    view.applySinglePageFirstPageOffset = () => undefined

    view.expand()

    assert.equal(wrapper.style.height, '100%')
    assert.equal(view._contentWidth, 500)
    assert.equal(view._contentPageCount, 1)
  })

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

  it('treats compact content pinned to the page edge as one page', function () {
    const view = createView({})
    setContentRects(view, [
      { left: 500, right: 548, top: 0, bottom: 24, width: 48, height: 24 },
    ])

    assert.equal(view.trimTrailingBlankPages(1000), 500)
  })

  it('treats compact rtl content on the logical first page as one page', function () {
    const view = createView({ direction: 'rtl' })
    setContentRects(view, [
      { left: 700, right: 748, top: 0, bottom: 24, width: 48, height: 24 },
    ])

    assert.equal(view.trimTrailingBlankPages(1000), 500)
  })

  it('treats a spread-wide wrapper with compact boundary content as one page', function () {
    const view = createView({})
    setContentRects(view, [
      { left: 0, right: 1000, top: 0, bottom: 80, width: 1000, height: 80 },
      { left: 500, right: 548, top: 28, bottom: 52, width: 48, height: 24 },
    ])

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

  it('keeps compact content that starts inside the second page with a spread-wide wrapper as two pages', function () {
    const view = createView({})
    setContentRects(view, [
      { left: 0, right: 1000, top: 0, bottom: 80, width: 1000, height: 80 },
      { left: 520, right: 568, top: 28, bottom: 52, width: 48, height: 24 },
    ])

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
