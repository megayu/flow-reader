import { assert } from 'vitest'

import { parse } from '../src/utils/core'

describe('XHTML parsing', function () {
  it('repairs only orphan closing tags without changing XML content or guessing nesting', function () {
    const wrap = (body: string) =>
      `<html xmlns="http://www.w3.org/1999/xhtml"><head/><body>${body}</body></html>`
    const bodies = [
      '<div>Heading</div><p>Body</p>',
      '<!-- </div> --><p title="&lt;/div&gt; >">Body</p>',
      '<p><![CDATA[Literal </div> and <div>]]></p>',
      '<div/><p>Body</p>',
    ]
    const serializer = new XMLSerializer()
    for (const body of bodies) {
      const expected = new DOMParser().parseFromString(wrap(body), 'application/xhtml+xml')
      const actual = parse(wrap(`${body}</div>`), 'application/xhtml+xml')
      assert.equal(serializer.serializeToString(actual), serializer.serializeToString(expected))
    }
    for (const body of ['<div><p>Body</div></p>', '<div><p>Body</p>', '<p>&unknown;</p></div>']) {
      const invalid = parse(wrap(body), 'application/xhtml+xml')
      assert.ok(invalid.querySelector('parsererror'), 'ambiguous or unrelated errors remain invalid')
    }
  })

  it('recovers bare ampersands without double-escaping entities', function () {
    const document = parse(
      `<?xml version="1.0" encoding="utf-8"?>
      <html xmlns="http://www.w3.org/1999/xhtml">
        <body>
          <a href="https://example.test/?first=1&second=2">A &amp; B</a>
          <p><![CDATA[A & B]]></p>
        </body>
      </html>`,
      'application/xhtml+xml',
    )
    const link = document.getElementsByTagName('a')[0]

    assert.ok(link)
    assert.equal(
      link.getAttribute('href'),
      'https://example.test/?first=1&second=2',
    )
    assert.equal(link.textContent, 'A & B')
    assert.equal(document.querySelector('p')?.textContent, 'A & B')
  })

  it('keeps an SVG image when its xlink namespace is undeclared', function () {
    const document = parse(
      '<!-- <html> --><html xmlns="http://www.w3.org/1999/xhtml" title="a > b"><body><svg xmlns="http://www.w3.org/2000/svg"><image xlink:href="cover.jpg"/></svg></body></html>',
      'application/xhtml+xml',
    )

    assert.isNull(document.querySelector('parsererror'))
    assert.equal(
      document.getElementsByTagName('image')[0]?.getAttributeNS('http://www.w3.org/1999/xlink', 'href'),
      'cover.jpg',
    )
  })

  it('preserves XHTML structure when HTML void tags omit their closing slash', function () {
    const document = parse(
      '<html xmlns="http://www.w3.org/1999/xhtml"><head><meta name="author" content="Writer"></meta><meta charset="utf-8"></head><body><p>Before<br>After</p><br id="paired">Paired</div></br><svg xmlns="http://www.w3.org/2000/svg"><source>Foreign</source></svg></body></html>',
      'application/xhtml+xml',
    )

    assert.isNull(document.querySelector('parsererror'))
    assert.equal(document.querySelector('body > p')?.textContent, 'BeforeAfter')
    assert.equal(document.querySelector('body > p > br')?.nextSibling?.textContent, 'After')
    assert.equal(document.querySelector('svg > source')?.textContent, 'Foreign')
    assert.equal(document.getElementById('paired')?.textContent, 'Paired')
  })

  it('reads common HTML entities in XHTML without a DTD', function () {
    const document = parse(
      '<html xmlns="http://www.w3.org/1999/xhtml"><body><p>One&nbsp;&mdash;&hellip;&copy;</p><p><![CDATA[&nbsp;]]></p></body></html>',
      'application/xhtml+xml',
    )

    assert.isNull(document.querySelector('parsererror'))
    assert.equal(document.querySelector('p')?.textContent, 'One\u00a0—…©')
    assert.equal(document.querySelectorAll('p')[1]?.textContent, '&nbsp;')
  })
})
