import assert from 'assert'

import Navigation from '../src/navigation'

describe('Navigation', function () {
  it('keeps child items from nav lists with stray ol siblings', function () {
    const xml = new DOMParser().parseFromString(
      `<?xml version="1.0" encoding="utf-8"?>
      <html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
        <body>
          <nav epub:type="toc">
            <ol>
              <li id="chapter-1"><a href="chapter-1.xhtml">Chapter 1</a></li>
              <ol>
                <li id="section-1"><a href="section-1.xhtml">Section 1</a></li>
              </ol>
              <li id="chapter-2"><a href="chapter-2.xhtml">Chapter 2</a></li>
            </ol>
          </nav>
        </body>
      </html>`,
      'application/xhtml+xml',
    )

    const nav = new Navigation(xml)

    assert.equal(nav.toc.length, 2)
    assert.equal(nav.toc[0].label, 'Chapter 1')
    assert.equal(nav.toc[0].subitems.length, 1)
    assert.equal(nav.toc[0].subitems[0].label, 'Section 1')
    assert.equal(nav.toc[0].subitems[0].parent, 'chapter-1')
    assert.equal(nav.toc[1].label, 'Chapter 2')
  })
})
