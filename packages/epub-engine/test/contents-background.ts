import type Section from '../src/section'
import { double } from './support/double'
import { assert } from 'vitest'

import Contents from '../src/contents'

function createContents(markup = '') {
  const frame = document.createElement('iframe')
  document.body.appendChild(frame)

  const doc = frame.contentDocument!
  doc.open()
  doc.write(`<!doctype html><html><head></head><body>${markup}</body></html>`)
  doc.close()

  const contents = new Contents(doc, doc.body)

  return {
    contents,
    doc,
    cleanup() {
      contents.destroy()
      frame.remove()
    },
  }
}

describe('Contents page backgrounds', function () {
  it('detects vertical writing declared on the body or dominant content wrapper', function () {
    const bodyVertical = createContents('<p>Synthetic body text.</p>')
    const wrapperVertical = createContents(
      '<main id="primary"><p>Synthetic wrapper text.</p></main><aside>Short note.</aside>',
    )
    bodyVertical.doc.body.style.writingMode = 'vertical-rl'
    wrapperVertical.doc.querySelector<HTMLElement>(
      '#primary',
    )!.style.writingMode = 'vertical-rl'

    try {
      assert.equal(bodyVertical.contents.writingMode(), 'vertical-rl')
      assert.equal(wrapperVertical.contents.writingMode(), 'vertical-rl')
      assert.equal(
        wrapperVertical.contents.writingMode(undefined, 'pre-paginated'),
        'horizontal-tb',
      )
    } finally {
      bodyVertical.cleanup()
      wrapperVertical.cleanup()
    }
  })

  it('keeps the horizontal physical page frame when content uses vertical-rl', function () {
    const horizontal = createContents('<p>Synthetic horizontal text.</p>')
    const vertical = createContents(
      `<p>${'Synthetic vertical pagination text. '.repeat(300)}</p>`,
    )
    vertical.doc.documentElement.style.writingMode = 'vertical-rl'
    vertical.doc.body.style.writingMode = 'vertical-rl'

    try {
      horizontal.contents.columns(1000, 600, 460, 40, 'ltr')
      vertical.contents.columns(1000, 600, 460, 40, 'rtl')

      const horizontalStyle = horizontal.doc.defaultView!.getComputedStyle(
        horizontal.doc.body,
      )
      const verticalStyle = vertical.doc.defaultView!.getComputedStyle(
        vertical.doc.body,
      )
      const frameProperties: (keyof CSSStyleDeclaration & string)[] = [
        'width',
        'height',
        'boxSizing',
        'paddingTop',
        'paddingRight',
        'paddingBottom',
        'paddingLeft',
      ]

      frameProperties.forEach((property) => {
        assert.equal(
          verticalStyle[property],
          horizontalStyle[property],
          `${property} must remain a physical page-frame property`,
        )
      })
      assert.equal(verticalStyle.writingMode, 'vertical-rl')
      assert.equal(verticalStyle.direction, 'ltr')
      assert.equal(verticalStyle.columnWidth, '580px')
      assert.equal(verticalStyle.getPropertyValue('column-height'), '460px')
      assert.equal(verticalStyle.columnCount, '1')
      assert.equal(verticalStyle.getPropertyValue('column-wrap'), 'wrap')
      assert.equal(verticalStyle.columnGap, '0px')
      assert.equal(verticalStyle.rowGap, '40px')

      const text = vertical.doc.querySelector<HTMLElement>('p')!.firstChild
      const first = vertical.doc.createRange()
      const second = vertical.doc.createRange()
      first.setStart(text!, 0)
      first.setEnd(text!, 1)
      second.setStart(text!, 1)
      second.setEnd(text!, 2)
      assert.ok(
        second.getBoundingClientRect().top > first.getBoundingClientRect().top,
        'inline text must advance from top to bottom',
      )

      const allText = vertical.doc.createRange()
      allText.selectNodeContents(text!)
      const rects = Array.prototype.slice.call(allText.getClientRects())
      const bodyRect = vertical.doc.body.getBoundingClientRect()
      assert.ok(
        rects.some(
          (rect) =>
            rect.left >= bodyRect.left + 520 &&
            rect.right <= bodyRect.left + 980,
        ),
        'the earlier page must occupy the physical right slot',
      )
      assert.ok(
        rects.some(
          (rect) =>
            rect.left >= bodyRect.left + 20 &&
            rect.right <= bodyRect.left + 480,
        ),
        'the later page must occupy the physical left slot',
      )
      assert.equal(
        rects.some(
          (rect) =>
            rect.left < bodyRect.left + 520 && rect.right > bodyRect.left + 480,
        ),
        false,
        'no vertical text may cross the physical middle gap',
      )
      assert.ok(vertical.doc.body.scrollWidth > 1000)
      assert.equal(vertical.doc.body.scrollHeight, 600)
    } finally {
      horizontal.cleanup()
      vertical.cleanup()
    }
  })

  it('keeps a single-page vertical row stride equal to the physical page width', function () {
    const vertical = createContents(
      `<p>${'Synthetic vertical pagination text. '.repeat(300)}</p>`,
    )
    vertical.doc.documentElement.style.writingMode = 'vertical-rl'
    vertical.doc.body.style.writingMode = 'vertical-rl'

    try {
      vertical.contents.columns(1000, 600, 1000, 40, 'rtl')
      const style = vertical.doc.defaultView!.getComputedStyle(
        vertical.doc.body,
      )

      assert.equal(style.getPropertyValue('column-height'), '960px')
      assert.equal(style.rowGap, '40px')
    } finally {
      vertical.cleanup()
    }
  })

  it('keeps paginated column fragments paintable when author CSS sets overflow auto', function () {
    const { contents, doc, cleanup } = createContents('<p>Readable body</p>')
    doc.documentElement.style.overflow = 'auto'
    doc.body.style.overflow = 'auto'

    try {
      contents.columns(800, 600, 380, 40, 'ltr')

      assert.equal(doc.documentElement.style.overflow, 'hidden')
      assert.equal(doc.body.style.overflow, 'visible')
    } finally {
      cleanup()
    }
  })

  it('keeps authored root margins from shifting horizontal paginated pages', function () {
    const layouts = [
      { columnWidth: 800, label: 'single page' },
      { columnWidth: 360, label: 'double page' },
    ]

    layouts.forEach(({ columnWidth, label }) => {
      const { contents, doc, cleanup } = createContents(
        '<p>Readable body text for the current page.</p>',
      )
      const style = doc.createElement('style')
      style.textContent = 'html, body { margin: 0 1%; }'
      doc.head.appendChild(style)
      const authoredRootMargin = doc.defaultView!.getComputedStyle(
        doc.documentElement,
      ).marginLeft

      try {
        assert.notEqual(authoredRootMargin, '0px')

        contents.columns(800, 600, columnWidth, 40, 'ltr')

        const paginatedRootStyle = doc.defaultView!.getComputedStyle(
          doc.documentElement,
        )
        assert.equal(
          paginatedRootStyle.marginLeft,
          '0px',
          `${label} must start at the physical page edge`,
        )
        assert.equal(
          paginatedRootStyle.marginRight,
          '0px',
          `${label} must end at the physical page edge`,
        )

        contents.size(800, 600)

        assert.equal(
          doc.defaultView!.getComputedStyle(doc.documentElement).marginLeft,
          authoredRootMargin,
          `${label} must restore the authored margin outside pagination`,
        )
      } finally {
        cleanup()
      }
    })
  })

  it('sizes only a sole normal-flow text wrapper to its content during horizontal pagination', function () {
    const text = 'Synthetic paragraph text for pagination. '.repeat(25)
    const cases = [
      { markup: `<div id="wrapper">${`<p>${text}</p>`.repeat(30)}</div>`, grows: true },
      { markup: '<!-- ignored -->\n<div id="wrapper"><p><br></p><p>Short text.</p></div>', grows: false },
      { markup: '<p id="wrapper">Short text.</p>', grows: false },
      { markup: '<div id="wrapper"><p>Short text.</p></div><p>Sibling.</p>' },
      { markup: 'Sibling text<div id="wrapper"><p>Short text.</p></div>' },
      { markup: '<div id="wrapper"><p><img alt="Cover"></p></div>' },
      { markup: '<div id="wrapper"><h1>Title</h1></div>' },
      { markup: '<div id="wrapper" style="display:flex"><p>Short text.</p></div>' },
      { markup: '<div id="wrapper" style="display:grid"><p>Short text.</p></div>' },
      { markup: '<div id="wrapper" style="position:absolute"><p>Short text.</p></div>' },
      { markup: '<div id="wrapper" style="overflow:auto"><p>Short text.</p></div>' },
      { markup: '<div id="wrapper"><p>Short text.</p></div>', vertical: true },
    ]

    for (const scenario of cases) {
      const { contents, doc, cleanup } = createContents(scenario.markup)
      const wrapper = doc.getElementById('wrapper')!
      const style = doc.createElement('style')
      style.textContent = '#wrapper { height: 200%; background: rgba(255,255,255,.9); border: 1px solid red; padding: 8px; border-radius: 8px; } p { margin: 0; font: 16px/24px serif; }'
      doc.head.appendChild(style)
      if (scenario.vertical) doc.body.style.writingMode = 'vertical-rl'

      try {
        for (const columnWidth of [800, 360]) {
          contents.columns(800, 400, columnWidth, 40, 'ltr')
          const computed = doc.defaultView!.getComputedStyle(wrapper)
          const height = Number.parseFloat(computed.height)
          assert.equal(doc.body.style.height, '400px', 'body remains the pagination frame')
          assert.equal(computed.backgroundColor, 'rgba(255, 255, 255, 0.9)')
          assert.equal(computed.borderTopWidth, '1px')
          assert.equal(computed.paddingTop, '8px')
          assert.equal(computed.borderTopLeftRadius, '8px')
          if (scenario.grows === true) {
            assert.isAbove(height, 800, 'long text must extend its own background container')
            const range = doc.createRange()
            range.selectNodeContents(wrapper.lastElementChild!)
            const lastLine = Array.from(range.getClientRects()).at(-1)!
            assert.isTrue(Array.from(wrapper.getClientRects()).some(rect =>
              rect.width > 0 && rect.height > 0 &&
              rect.left <= lastLine.left && rect.right >= lastLine.right &&
              rect.top <= lastLine.top && rect.bottom >= lastLine.bottom,
            ), 'the last text line must remain inside a painted wrapper fragment')
          } else if (scenario.grows === false) {
            assert.isBelow(height, 400, 'short text must not retain authored blank pages')
          } else {
            wrapper.style.setProperty('height', '200%', 'important')
            assert.equal(height, Number.parseFloat(doc.defaultView!.getComputedStyle(wrapper).height),
              'excluded structures retain authored height')
            wrapper.style.removeProperty('height')
          }
        }
        contents.size(800, 400)
        const scrollingHeight = doc.defaultView!.getComputedStyle(wrapper).height
        wrapper.style.setProperty('height', '200%', 'important')
        assert.equal(scrollingHeight, doc.defaultView!.getComputedStyle(wrapper).height,
          'scrolling must restore the authored height')
      } finally {
        cleanup()
      }
    }
  })

  it('ignores comments and non-content text when detecting readable text', function () {
    const { contents, cleanup } = createContents(
      '<!-- comment --><script>var ignored = true</script><style>body { color: red }</style>',
    )

    try {
      assert.equal(contents.backgrounds.hasReadableTextContent(), false)
    } finally {
      cleanup()
    }
  })

  it('ignores hidden heading text when detecting readable text', function () {
    const { contents, cleanup } = createContents(
      '<h2 style="display:none">作品简介</h2><p>&#160;</p>',
    )

    try {
      assert.equal(contents.backgrounds.hasReadableTextContent(), false)
    } finally {
      cleanup()
    }
  })

  it('detects body text for page background fill mode', function () {
    const { contents, cleanup } = createContents('<p>Readable body</p>')

    try {
      assert.equal(contents.backgrounds.hasReadableTextContent(), true)
    } finally {
      cleanup()
    }
  })

  it('makes only fully opaque white page backgrounds transparent', function () {
    const cases = [
      { authored: 'rgb(255, 255, 255)', normalized: 'rgba(0, 0, 0, 0)' },
      { authored: 'rgb(245, 240, 225)', normalized: 'rgb(245, 240, 225)' },
    ]

    cases.forEach(({ authored, normalized }) => {
      const { contents, doc, cleanup } = createContents('<p>Readable body</p>')
      doc.body.style.backgroundColor = authored

      try {
        contents.backgrounds.normalizePageBackgrounds(400, 600, 'ltr')
        assert.equal(
          doc.defaultView!.getComputedStyle(doc.body).backgroundColor,
          normalized,
        )
      } finally {
        cleanup()
      }
    })
  })

  it('preserves authored background constraints within each readable text page', function () {
    for (const size of ['cover', 'contain', '100% auto', '80px 60px']) {
      const { contents, doc, cleanup } = createContents('<p>Readable body</p>')
      doc.body.style.backgroundImage =
        'url("data:image/png;base64,iVBORw0KGgo=")'
      doc.body.style.backgroundRepeat = 'no-repeat'
      doc.body.style.backgroundPosition = 'center center'
      doc.body.style.backgroundSize = size
      doc.body.style.backgroundAttachment = 'fixed'
      doc.body.style.backgroundColor = 'rgba(20, 30, 40, 0.7)'
      doc.body.style.border = '2px solid red'
      doc.body.style.borderRadius = '12px'
      doc.body.style.padding = '16px'
      doc.body.style.opacity = '0.9'
      const otherStyles = () =>
        [...doc.body.style]
          .filter((property) => property !== 'background-image')
          .map((property) => [
            property,
            doc.body.style.getPropertyValue(property),
          ])
      const originalStyles = otherStyles()
      const authoredSize = doc.body.style.backgroundSize
      const resolvedSize = doc.defaultView!.getComputedStyle(
        doc.body,
      ).backgroundSize

      try {
        assert.equal(
          contents.backgrounds.normalizePageBackgrounds(400, 600, 'ltr'),
          true,
        )
        assert.equal(doc.body.style.backgroundSize, authoredSize)
        assert.equal(doc.body.style.backgroundRepeat, 'no-repeat')
        assert.equal(doc.body.style.backgroundPosition, 'center center')
        assert.equal(doc.body.style.backgroundAttachment, 'fixed')

        const before = doc.body
          .firstElementChild!.getBoundingClientRect()
          .toJSON()
        assert.equal(
          contents.backgrounds.fillReadablePageBackgrounds(
            400,
            600,
            1200,
            'ltr',
          ),
          true,
        )
        const host = doc.querySelector('flow-page-backgrounds')!
        assert.deepEqual(otherStyles(), originalStyles)
        const pages = [...host.shadowRoot!.children] as HTMLElement[]
        assert.equal(pages.length, 3)
        for (const [index, page] of pages.entries()) {
          const style = doc.defaultView!.getComputedStyle(page)
          assert.equal(style.backgroundSize, resolvedSize)
          assert.equal(style.backgroundPosition, '50% 50%')
          assert.equal(style.backgroundRepeat, 'no-repeat')
          assert.equal(style.backgroundAttachment, 'scroll')
          assert.equal(page.getBoundingClientRect().width, 400)
          assert.equal(page.getBoundingClientRect().height, 600)
          assert.equal(page.getBoundingClientRect().left, index * 400)
        }
        assert.deepEqual(
          doc.body.firstElementChild!.getBoundingClientRect().toJSON(),
          before,
        )
        contents.backgrounds.fillReadablePageBackgrounds(400, 600, 1200, 'ltr')
        assert.strictEqual(doc.querySelector('flow-page-backgrounds'), host)

        contents.backgrounds.fillReadablePageBackgrounds(400, 600, 400, 'ltr')
        assert.isNull(doc.querySelector('flow-page-backgrounds'))
        assert.notEqual(doc.body.style.backgroundImage, 'none')

        contents.backgrounds.clearPageBackgroundNormalization()
        assert.equal(doc.body.style.backgroundSize, authoredSize)
        assert.equal(doc.body.style.backgroundRepeat, 'no-repeat')
        assert.equal(doc.body.style.backgroundPosition, 'center center')
        assert.equal(doc.body.style.backgroundAttachment, 'fixed')
        assert.isNull(doc.querySelector('flow-page-backgrounds'))
      } finally {
        cleanup()
      }
    }
  })

  it('does not paginate local, layered, or repeating authored backgrounds', function () {
    const { contents, doc, cleanup } = createContents(
      '<div style="width:400px;height:600px">Readable body</div>',
    )
    const local = doc.body.firstElementChild as HTMLElement
    local.style.background = 'url("local.png") no-repeat center / contain'
    try {
      for (const image of [
        'url("one.png"), url("two.png")',
        'url("texture.png")',
      ]) {
        doc.body.style.backgroundImage = image
        doc.body.style.backgroundRepeat = image.includes('two')
          ? 'no-repeat'
          : 'repeat'
        const before = doc.body.style.cssText
        const localBefore = local.style.cssText
        contents.backgrounds.normalizePageBackgrounds(400, 600, 'ltr')
        contents.backgrounds.fillReadablePageBackgrounds(400, 600, 1200, 'ltr')
        assert.equal(doc.body.style.cssText, before)
        assert.equal(local.style.cssText, localBefore)
        assert.isNull(doc.querySelector('flow-page-backgrounds'))
        contents.backgrounds.clearPageBackgroundNormalization()
      }
    } finally {
      cleanup()
    }
  })

  it('fills readable section backgrounds when css has no layout constraints', function () {
    const { contents, doc, cleanup } = createContents('<p>Readable body</p>')
    doc.body.style.backgroundImage = 'url("data:image/png;base64,iVBORw0KGgo=")'

    try {
      assert.equal(
        contents.backgrounds.normalizePageBackgrounds(400, 600, 'ltr'),
        true,
      )
      assert.equal(doc.body.style.backgroundSize, '400px 600px')
      assert.equal(doc.body.style.backgroundRepeat, 'no-repeat')
      assert.equal(doc.body.style.backgroundPosition, '0px top')
      assert.equal(doc.body.style.backgroundAttachment, 'scroll')
    } finally {
      cleanup()
    }
  })

  it('preserves stylesheet-authored readable background constraints', function () {
    const { contents, doc, cleanup } = createContents('<p>Readable body</p>')
    const style = doc.createElement('style')
    style.textContent = `
      body {
        background-image: url("data:image/png;base64,iVBORw0KGgo=");
        background-size: contain;
        background-repeat: no-repeat;
        background-position: center center;
      }
    `
    doc.head.appendChild(style)

    try {
      assert.equal(
        contents.backgrounds.normalizePageBackgrounds(400, 600, 'ltr'),
        true,
      )
      const computed = doc.defaultView!.getComputedStyle(doc.body)
      assert.equal(computed.backgroundSize, 'contain')
      assert.equal(computed.backgroundRepeat, 'no-repeat')
      assert.equal(computed.backgroundPosition, '50% 50%')
      assert.equal(doc.body.style.backgroundSize, '')
      assert.equal(doc.body.style.backgroundRepeat, '')
      assert.equal(doc.body.style.backgroundPosition, '')
    } finally {
      cleanup()
    }
  })

  it('uses one stretched no-repeat background layer per text page', function () {
    const { contents, doc, cleanup } = createContents('<p>Readable body</p>')
    doc.body.style.backgroundImage = 'url("data:image/png;base64,iVBORw0KGgo=")'

    try {
      assert.equal(
        contents.backgrounds.normalizePageBackgrounds(400, 600, 'ltr'),
        true,
      )
      assert.equal(
        contents.backgrounds.fillReadablePageBackgrounds(400, 600, 1200, 'ltr'),
        true,
      )
      assert.equal(
        doc.body.style.backgroundSize,
        '400px 600px, 400px 600px, 400px 600px',
      )
      assert.equal(
        doc.body.style.backgroundRepeat,
        'no-repeat, no-repeat, no-repeat',
      )
      assert.equal(
        doc.body.style.backgroundPosition,
        '0px top, 400px top, 800px top',
      )
      assert.equal(
        doc.body.style.backgroundAttachment,
        'scroll, scroll, scroll',
      )
      assert.equal(doc.body.style.backgroundImage.split('url(').length - 1, 3)
    } finally {
      cleanup()
    }
  })

  it('uses the layout page width for paginated readable backgrounds', function () {
    const { contents, doc, cleanup } = createContents('<p>Readable body</p>')
    doc.body.style.backgroundImage = 'url("data:image/png;base64,iVBORw0KGgo=")'

    try {
      contents.columns(1000, 600, 460, 40, 'ltr')
      assert.equal(doc.body.style.backgroundSize, '500px 600px')
      assert.equal(doc.body.style.backgroundRepeat, 'no-repeat')
      assert.equal(doc.body.style.backgroundPosition, '0px top')
    } finally {
      cleanup()
    }
  })

  it('preserves a local vertical block height without forcing a new page', function () {
    const { contents, doc, cleanup } = createContents(
      `<p id="before">${'Horizontal text. '.repeat(
        12,
      )}</p><div id="vertical" style="writing-mode: vertical-rl; height: 60px">Vertical block with enough text to require its intrinsic height.</div>`,
    )

    try {
      assert.equal(contents.writingMode(), 'horizontal-tb')
      contents.columns(1000, 600, 460, 40, 'ltr')

      const before = doc
        .querySelector<HTMLElement>('#before')!
        .getBoundingClientRect()
      const vertical = doc.querySelector<HTMLElement>('#vertical')
      const verticalRect = vertical!.getBoundingClientRect()
      const verticalStyle = doc.defaultView!.getComputedStyle(vertical!)

      assert.ok(before.left < 500)
      assert.ok(verticalRect.left < 500)
      assert.ok(verticalRect.height > 60)
      assert.equal(verticalStyle.writingMode, 'vertical-rl')
    } finally {
      cleanup()
    }
  })

  it('keeps cover-like backgrounds fitted inside a textless page', function () {
    const { contents, cleanup } = createContents()

    try {
      assert.deepEqual(
        contents.backgrounds.resolveBackgroundSize(
          'cover',
          { width: 800, height: 800 },
          400,
          600,
        ),
        { width: 400, height: 400, overflow: true },
      )
    } finally {
      cleanup()
    }
  })

  it('forces repeated textless backgrounds to display once and fit inside the page', function () {
    const { contents, doc, cleanup } = createContents()
    doc.body.style.backgroundImage =
      'url("data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%27800%27 height=%27800%27/%3E")'
    doc.body.style.backgroundRepeat = 'repeat'
    doc.body.style.backgroundPosition = 'left top'
    doc.body.style.backgroundSize = 'cover'
    doc.body.style.backgroundAttachment = 'fixed'
    contents.backgrounds.backgroundImageSize = (_url, callback) => {
      callback({ width: 800, height: 800 })
    }

    try {
      contents.backgrounds.normalizePageBackgrounds(400, 600, 'ltr')
      assert.equal(doc.body.style.backgroundSize, '400px 400px')
      assert.equal(doc.body.style.backgroundRepeat, 'no-repeat')
      assert.equal(doc.body.style.backgroundPosition, 'center center')
      assert.equal(doc.body.style.backgroundAttachment, 'scroll')
    } finally {
      cleanup()
    }
  })
})

describe('Contents fixed layout viewport fallback', function () {
  it('centers a fixed-layout page vertically inside its slot', function () {
    const { contents, doc, cleanup } = createContents()
    const viewport = doc.createElement('meta')
    viewport.setAttribute('name', 'viewport')
    viewport.setAttribute('content', 'width=1600,height=900')
    doc.head.appendChild(viewport)

    try {
      contents.fit(800, 800)

      assert.equal(doc.body.style.marginTop, '175px')
    } finally {
      cleanup()
    }
  })

  it('fits an SVG spine document from its authored viewBox', function () {
    const { contents, doc, cleanup } = createContents(
      '<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox="0 0 1240 1612"><image width="1240" height="1612"/></svg>',
    )
    const section = double<Section>({
      type: 'image/svg+xml',
      properties: ['page-spread-left'],
    })

    try {
      contents.fit(700, 800, section, undefined, 2, 'left')

      const scale = 800 / 1612
      assert.equal(doc.body.style.width, '1240px')
      assert.equal(doc.body.style.height, '1612px')
      assert.closeTo(
        parseFloat(doc.body.style.transform.match(/scale\(([^)]+)/)![1]!),
        scale,
        0.000001,
      )
      assert.closeTo(
        parseFloat(doc.body.style.marginLeft),
        700 - 1240 * scale,
        0.001,
      )
    } finally {
      cleanup()
    }
  })

  it('fits fixed-layout content using a fallback viewport when the page omits one', function () {
    const { contents, doc, cleanup } = createContents(
      '<img src="../Images/page.jpeg" width="1200" height="1920"/>',
    )

    try {
      contents.fit(600, 960, undefined, 'width=1200,height=1920')

      assert.equal(doc.body.style.width, '1200px')
      assert.equal(doc.body.style.height, '1920px')
      assert.match(doc.body.style.transform, /scale\(0\.5\)/)
    } finally {
      cleanup()
    }
  })

  it('keeps the page viewport when both page and fallback viewport exist', function () {
    const { contents, doc, cleanup } = createContents()
    const viewport = doc.createElement('meta')
    viewport.setAttribute('name', 'viewport')
    viewport.setAttribute('content', 'width=800,height=1000')
    doc.head.appendChild(viewport)

    try {
      contents.fit(400, 500, undefined, 'width=1200,height=1920')

      assert.equal(doc.body.style.width, '800px')
      assert.equal(doc.body.style.height, '1000px')
      assert.match(doc.body.style.transform, /scale\(0\.5\)/)
    } finally {
      cleanup()
    }
  })
})
