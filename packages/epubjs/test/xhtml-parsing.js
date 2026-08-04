import { assert } from 'vitest'

import { parse } from '../src/utils/core'

describe('XHTML parsing', function () {
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
    assert.equal(link.getAttribute('href'), 'https://example.test/?first=1&second=2')
    assert.equal(link.textContent, 'A & B')
  })
})
