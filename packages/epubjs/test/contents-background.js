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
