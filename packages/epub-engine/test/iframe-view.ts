import type PageBackgrounds from '../src/page-backgrounds'
import type Section from '../src/section'
import Layout from '../src/layout'
import Contents from '../src/contents'
import { createContentZoomCss } from '../src/content-zoom'
import type { LegacyWindow } from '../src/utils/core'
import { double } from './support/double'
import { assert } from 'vitest'
import Views from '../src/managers/helpers/views'
import { underlineGeometry } from '../src/managers/helpers/annotation-marks'
import IframeView from '../src/managers/views/iframe'
import Rendition from '../src/rendition'
import { EVENTS } from '../src/utils/constants'

type Rect = {
  left: number
  right: number
  top: number
  bottom: number
  width?: number
  height?: number
}

function createView({
  pageCount = 1,
  direction = 'ltr',
  rect,
}: {
  pageCount?: number
  direction?: string
  rect?: Rect
}) {
  const view = new IframeView(double<Section>({ index: 0 }), {
    axis: 'horizontal',
    direction,
    layout: double<Layout>({
      name: 'reflowable',
      pageWidth: 500,
    }),
  })

  view.layout = view.settings.layout!
  view._contentPageCount = pageCount
  view.contents = double<Contents>({
    content: document.createElement('div'),
  })
  view.contentBounds = () => rect

  return view
}

function setContentRects(view: IframeView, rects: Rect[]) {
  view.eachContentRect = (callback) => {
    for (const rect of rects) {
      if (callback(double<DOMRect>(rect))) {
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

  view.contents = double<Contents>({
    content: body,
    document,
    window: double<LegacyWindow>({
      getComputedStyle(element) {
        if (element === block) {
          return double<CSSStyleDeclaration>({
            marginBottom: `${marginBottom}px`,
            width: `${blockWidth}px`,
          })
        }

        return double<CSSStyleDeclaration>({
          marginBottom: '0px',
          width: '500px',
        })
      },
    }),
  })

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

  view.contents = double<Contents>({
    content: body,
    document,
    window: double<LegacyWindow>({
      getComputedStyle(element) {
        if (element === body) {
          return double<CSSStyleDeclaration>({
            paddingLeft,
            paddingRight,
          })
        }

        if (element === heading) {
          return double<CSSStyleDeclaration>({
            backgroundColor,
            backgroundImage,
            marginLeft,
            marginRight,
          })
        }

        return double<CSSStyleDeclaration>({
          backgroundColor: 'rgba(0, 0, 0, 0)',
          backgroundImage: 'none',
          marginLeft: '0px',
          marginRight: '0px',
        })
      },
    }),
  })

  return { heading, view }
}

describe('IframeView destruction', function () {
  it('releases resources when removed before display completes', async function () {
    const container = document.createElement('div')
    const views = new Views(container)
    const view = createView({})
    const iframe = view.create()
    const blobUrl = URL.createObjectURL(new Blob(['epub view']))
    const loading = view.load('<html><body>Pending view</body></html>')
    const loadSettlement = loading.then(
      () => 'resolved',
      (error) => error,
    )
    let contentsDestroyed = false

    view.blobUrl = blobUrl
    view.contents = double<Contents>({
      destroy() {
        contentsDestroyed = true
      },
    })
    views.append(view)

    views.remove(view)
    const loadResult = await Promise.race([
      loadSettlement,
      new Promise((resolve) => setTimeout(() => resolve('pending'), 0)),
    ])

    assert.equal(contentsDestroyed, true)
    assert.instanceOf(loadResult, Error)
    assert.match(loadResult.message, /destroyed/i)
    assert.equal(view.element.contains(iframe), false)
    assert.equal(view.blobUrl, undefined)
    assert.equal(view.iframe, undefined)
    assert.equal(view.contents, undefined)
  })
})

describe('IframeView vertical writing pagination', function () {
  it('reports vertical-rl writing independently from the horizontal page axis', async function () {
    let formattedAxis
    let emittedAxis
    const layout = double<Layout>({
      name: 'reflowable',
      height: 800,
      pageWidth: 500,
      delta: 500,
      format(_contents, _section, axis) {
        formattedAxis = axis
      },
    })
    const view = new IframeView(
      double<Section>({
        index: 0,
        render: async () =>
          '<html><body>Synthetic vertical text.</body></html>',
      }),
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
      view.contents = double<Contents>({
        writingMode: () => 'vertical-rl',
      })
      return view.contents
    }
    view.fitLeadingBlockBackgroundsBeforeMeasure = () => false
    view.fitLeadingTitleImagesBeforeMeasure = () => false
    view.fitMediaBeforeMeasure = () => undefined
    view.expand = () => undefined
    view.on(EVENTS.VIEWS.AXIS, (axis) => {
      emittedAxis = axis
    })

    await view.render(() => undefined!)

    assert.equal(view.writingMode, 'vertical-rl')
    assert.equal(view.settings.axis, 'horizontal')
    assert.equal(emittedAxis, 'horizontal')
    assert.equal(formattedAxis, 'horizontal')
    assert.equal(layout.delta, 500)
  })

  it('places vertical-rl definition and annotation underlines on the glyph left side', function () {
    for (const gap of [2, 1.5]) {
      const geometry = underlineGeometry(
        { left: 300, top: 100, width: 24, height: 180 },
        { gap, writingMode: 'vertical-rl' },
      )

      assert.equal(geometry.orientation, 'vertical')
      assert.equal(geometry.side, 'left')
      assert.equal(geometry.x! < 300, true)
      assert.equal(geometry.start, 100)
      assert.equal(geometry.length, 180)
    }
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

    view.setLayout(
      double<Layout>({
        name: 'reflowable',
        pageWidth: 1000,
        format: () => undefined,
      }),
    )

    assert.deepEqual(stateDuringExpand, {
      contentPageCount: undefined,
      contentWidth: undefined,
      needsReframe: true,
    })
  })
})

describe('IframeView first page positioning', function () {
  it('fits overflowing leading whitespace after pagination without collapsing real content pages', async function () {
    for (const tag of ['h1', 'div']) {
      const layout = new Layout({ layout: 'reflowable', spread: 'auto' })
      layout.calculate(1373, 906, 48)
      const view = new IframeView(double<Section>({
        index: 0,
        cfiBase: '/6/2',
        render: async () => `<!doctype html><html><head><style>
          body { font-size: 20px; }
          .spaced { margin: 155% 0 0; font-size: 20px; line-height: 140%; text-align: center; }
          span { font-size: 32px; }
        </style></head><body><${tag} class="spaced">Part One<br/><span>Sample title</span></${tag}></body></html>`,
      }), {
        layout, width: 1373, height: 906,
        axis: 'horizontal', direction: 'ltr', flow: 'paginated',
      })
      document.body.appendChild(view.element)
      try {
        await view.render(() => undefined!)
        await view.document!.fonts.ready
        for (const [width, height] of [[1373, 906], [2226, 1280], [1000, 780], [1000, 900], [1373, 906]]) {
          layout.calculate(width!, height!, 48)
          view.lockedWidth = width!
          view.lockedHeight = height!
          view.setLayout(layout)
          const rect = view.contentBounds()!
          assert.equal(view._contentPageCount, 1, 'leading whitespace must not require another content page')
          assert.isAtLeast(rect.left, 0)
          assert.isAtMost(rect.right, layout.pageWidth)
          assert.isAtLeast(rect.top, height! * 0.6, 'overflowing leading whitespace keeps content toward the bottom')
          assert.isAtMost(rect.bottom, height!, 'all text remains visible')
          if (height === 900) {
            assert.closeTo(view.document!.body.firstElementChild!.getBoundingClientRect().top, 710.6, 1, 'restore authored spacing when it fits')
          }
        }
        const block = view.document!.body.firstElementChild!
        block.textContent = 'Synthetic body text with real content spanning pages. '.repeat(1000)
        view.refreshContents()
        assert.isAbove(view._contentPageCount!, 1, 'real text overflow retains pagination')
      } finally {
        view.destroy()
        view.element.remove()
      }
    }
  })

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
    assert.equal(view.contents!.content.style.translate, '-225px')

    view.clearSinglePageFirstPageOffset()
    assert.equal(view.contents!.content.style.translate, '')
  })
})

describe('IframeView leading title image fitting', function () {
  it('clamps narrow negative-margin title images before measurement', function () {
    const { image, view } = createTitleImageView()

    assert.equal(view.fitLeadingTitleImagesBeforeMeasure(), true)
    assert.equal(
      image.getAttribute('data-flow-epub-leading-title-image-clamped'),
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
      image.hasAttribute('data-flow-epub-leading-title-image-clamped'),
      false,
    )
  })

  it('does not clamp leading images without following headings', function () {
    const { image, view } = createTitleImageView({ withHeading: false })

    assert.equal(view.fitLeadingTitleImagesBeforeMeasure(), false)
    assert.equal(
      image.hasAttribute('data-flow-epub-leading-title-image-clamped'),
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
  it('fits percentage images through their container across page modes and zoom', async function () {
    for (const { spread, width } of [
      { spread: false, width: 1000 },
      { spread: false, width: 1868 },
      { spread: true, width: 1868 },
    ]) {
      for (const zoom of [0.8, 1, 1.5]) {
        const frame = document.createElement('iframe')
        frame.style.width = width + 'px'
        frame.style.height = '800px'
        document.body.appendChild(frame)
        const doc = frame.contentDocument!
        doc.open()
        doc.write(`<!doctype html><html><head><style>
          .art { margin: 0 -1.5% 1em; text-align: center; }
          .art img { display: block; width: 100%; max-width: 100%; height: auto; }
        </style></head><body><div class="art"><img alt="Synthetic chapter art" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1600' height='900'/%3E"></div><h2>Synthetic chapter</h2></body></html>`)
        doc.close()
        const contents = new Contents(doc, doc.body)
        try {
          const view = createView({})
          Object.assign(view.layout, {
            width,
            height: 800,
            columnWidth: spread ? width / 2 - 40 : width,
            gap: 40,
          })
          view.contents = contents
          const image = doc.querySelector('img')!
          await image.decode()
          contents.columns(width, 800, view.layout.columnWidth, 40)
          view.fitMediaBeforeMeasure()
          await Rendition.prototype.adjustImages.call(
            { _layout: view.layout },
            contents,
          )
          contents.addStylesheetCss(
            createContentZoomCss(
              contents,
              view.layout,
              'horizontal',
              zoom,
              'horizontal-tb',
            ),
            'custom',
          )
          const imageRect = image.getBoundingClientRect()
          const containerRect = image.parentElement!.getBoundingClientRect()
          const contentWidth = spread ? width / 2 - 40 : width - 40
          assert.closeTo(
            containerRect.width,
            contentWidth,
            1,
            'container fits the writable page column',
          )
          assert.closeTo(
            imageRect.width,
            containerRect.width,
            1,
            '100% image fills its container',
          )
          assert.closeTo(
            containerRect.left,
            20,
            1,
            'container starts at the writable page edge',
          )
        } finally {
          contents.destroy()
          frame.remove()
        }
      }
    }
  })

  it('preserves the containing block width cap after rendition hooks', async function () {
    const view = createView({})
    const content = document.createElement('div')
    const section = document.createElement('section')
    const image = document.createElement('img')
    const stylesheets: HTMLStyleElement[] = []

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

    view.contents = double<Contents>({
      content,
      window,
      addStylesheetRules(nextRules) {
        const stylesheet = document.createElement('style')
        stylesheet.textContent = `img { max-width: ${(nextRules as Record<string, Record<string, string>>).img!['max-width']}; }`
        document.head.appendChild(stylesheet)
        stylesheets.push(stylesheet)
      },
    })

    try {
      view.fitMediaBeforeMeasure()
      await Rendition.prototype.adjustImages.call(
        { _layout: view.layout },
        view.contents!,
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
    view.contents = double<Contents>({
      content: body,
      textWidth: () => (wrapper.style.height === '100%' ? 500 : 1500),
      backgrounds: double<PageBackgrounds>({
        fillReadablePageBackgrounds: () => false,
      }),
    })
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
    view.contentRangeSummary = () =>
      double<NonNullable<ReturnType<IframeView['contentRangeSummary']>>>({
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
    view.contentRangeSummary = () =>
      double<NonNullable<ReturnType<IframeView['contentRangeSummary']>>>({
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
    view.contentRangeSummary = () =>
      double<NonNullable<ReturnType<IframeView['contentRangeSummary']>>>({
        bounds: { left: 24, right: 700, top: 0, bottom: 700 },
        crossesPageBoundary: true,
        startsInsideSecondPage: true,
      })

    assert.equal(view.trimTrailingBlankPages(1000), 1000)
  })
})
