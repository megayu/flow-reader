/* eslint-env mocha */

import assert from 'assert'

import Contents from '../src/contents'

function createContents(markup = '') {
  const frame = document.createElement('iframe')
  document.body.appendChild(frame)

  const doc = frame.contentDocument
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
    wrapperVertical.doc.querySelector('#primary').style.writingMode =
      'vertical-rl'

    try {
      assert.equal(bodyVertical.contents.writingMode(), 'vertical-rl')
      assert.equal(wrapperVertical.contents.writingMode(), 'vertical-rl')
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

      const horizontalStyle = horizontal.doc.defaultView.getComputedStyle(
        horizontal.doc.body,
      )
      const verticalStyle = vertical.doc.defaultView.getComputedStyle(
        vertical.doc.body,
      )
      const frameProperties = [
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

      const text = vertical.doc.querySelector('p').firstChild
      const first = vertical.doc.createRange()
      const second = vertical.doc.createRange()
      first.setStart(text, 0)
      first.setEnd(text, 1)
      second.setStart(text, 1)
      second.setEnd(text, 2)
      assert.ok(
        second.getBoundingClientRect().top > first.getBoundingClientRect().top,
        'inline text must advance from top to bottom',
      )

      const allText = vertical.doc.createRange()
      allText.selectNodeContents(text)
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
      const style = vertical.doc.defaultView.getComputedStyle(vertical.doc.body)

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

  it('ignores comments and non-content text when detecting readable text', function () {
    const { contents, cleanup } = createContents(
      '<!-- comment --><script>var ignored = true</script><style>body { color: red }</style>',
    )

    try {
      assert.equal(contents.hasReadableTextContent(), false)
    } finally {
      cleanup()
    }
  })

  it('ignores hidden heading text when detecting readable text', function () {
    const { contents, cleanup } = createContents(
      '<h2 style="display:none">作品简介</h2><p>&#160;</p>',
    )

    try {
      assert.equal(contents.hasReadableTextContent(), false)
    } finally {
      cleanup()
    }
  })

  it('detects body text for page background fill mode', function () {
    const { contents, cleanup } = createContents('<p>Readable body</p>')

    try {
      assert.equal(contents.hasReadableTextContent(), true)
    } finally {
      cleanup()
    }
  })

  it('preserves authored readable section background constraints', function () {
    const { contents, doc, cleanup } = createContents('<p>Readable body</p>')
    doc.body.style.backgroundImage = 'url("data:image/png;base64,iVBORw0KGgo=")'
    doc.body.style.backgroundRepeat = 'no-repeat'
    doc.body.style.backgroundPosition = 'center center'
    doc.body.style.backgroundSize = 'cover'
    doc.body.style.backgroundAttachment = 'fixed'

    try {
      assert.equal(contents.normalizePageBackgrounds(400, 600, 'ltr'), true)
      assert.equal(doc.body.style.backgroundSize, 'cover')
      assert.equal(doc.body.style.backgroundRepeat, 'no-repeat')
      assert.equal(doc.body.style.backgroundPosition, 'center center')
      assert.equal(doc.body.style.backgroundAttachment, 'fixed')

      contents.clearPageBackgroundNormalization()
      assert.equal(doc.body.style.backgroundSize, 'cover')
      assert.equal(doc.body.style.backgroundRepeat, 'no-repeat')
      assert.equal(doc.body.style.backgroundPosition, 'center center')
      assert.equal(doc.body.style.backgroundAttachment, 'fixed')
    } finally {
      cleanup()
    }
  })

  it('fills readable section backgrounds when css has no layout constraints', function () {
    const { contents, doc, cleanup } = createContents('<p>Readable body</p>')
    doc.body.style.backgroundImage = 'url("data:image/png;base64,iVBORw0KGgo=")'

    try {
      assert.equal(contents.normalizePageBackgrounds(400, 600, 'ltr'), true)
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
      assert.equal(contents.normalizePageBackgrounds(400, 600, 'ltr'), true)
      const computed = doc.defaultView.getComputedStyle(doc.body)
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
      assert.equal(contents.normalizePageBackgrounds(400, 600, 'ltr'), true)
      assert.equal(
        contents.fillReadablePageBackgrounds(400, 600, 1200, 'ltr'),
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

  it('keeps cover-like backgrounds fitted inside a textless page', function () {
    const { contents, cleanup } = createContents()

    try {
      assert.deepEqual(
        contents.resolveBackgroundSize(
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
    contents.backgroundImageSize = (_url, callback) => {
      callback({ width: 800, height: 800 })
    }

    try {
      contents.normalizePageBackgrounds(400, 600, 'ltr')
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
