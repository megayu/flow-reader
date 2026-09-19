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
  })
})
