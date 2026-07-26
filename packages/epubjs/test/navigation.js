import { assert } from 'vitest'

import Navigation from '../src/navigation'
import { parse } from '../src/utils/core'

describe('Navigation', function () {
  it('keeps NCX entries after unescaped angle brackets in navLabel text', function () {
    const xml = parse(
      `<?xml version="1.0" encoding="utf-8"?>
      <ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
        <navMap>
          <navPoint id="tip-15" playOrder="1">
            <navLabel><text>Parent Topic</text></navLabel>
            <content src="Text/chapter.xhtml#topic-a"/>
            <navPoint id="bad-label" playOrder="2">
              <navLabel><text>Literal key notation <Key-x>{arg}</text></navLabel>
              <content src="Text/chapter.xhtml#topic-b"/>
            </navPoint>
          </navPoint>
          <navPoint id="tip-16" playOrder="3">
            <navLabel><text>Following Topic</text></navLabel>
            <content src="Text/chapter.xhtml#topic-c"/>
          </navPoint>
        </navMap>
      </ncx>`,
      'text/xml',
    )

    const nav = new Navigation(xml)

    assert.equal(nav.toc.length, 2)
    assert.equal(nav.toc[0].subitems.length, 1)
    assert.equal(
      nav.toc[0].subitems[0].label,
      'Literal key notation <Key-x>{arg}',
    )
    assert.equal(nav.toc[1].label, 'Following Topic')
  })

  it('skips NCX navPoints without content instead of throwing', function () {
    const xml = new DOMParser().parseFromString(
      `<?xml version="1.0" encoding="utf-8"?>
      <ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
        <navMap>
          <navPoint id="chapter-1" playOrder="1">
            <navLabel><text>Chapter 1</text></navLabel>
            <content src="Text/chapter-1.xhtml"/>
          </navPoint>
          <navPoint id="bad-label" playOrder="2">
            <navLabel><text>Broken label</text></navLabel>
          </navPoint>
          <navPoint id="chapter-2" playOrder="3">
            <navLabel><text>Chapter 2</text></navLabel>
            <content src="Text/chapter-2.xhtml"/>
          </navPoint>
        </navMap>
      </ncx>`,
      'text/xml',
    )

    const nav = new Navigation(xml)

    assert.equal(nav.toc.length, 2)
    assert.equal(nav.toc[0].label, 'Chapter 1')
    assert.equal(nav.toc[1].label, 'Chapter 2')
  })

  it('promotes NCX child navPoints when their parent has no content', function () {
    const xml = new DOMParser().parseFromString(
      `<?xml version="1.0" encoding="utf-8"?>
      <ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
        <navMap>
          <navPoint id="bad-parent" playOrder="1">
            <navLabel><text>Broken parent</text></navLabel>
            <navPoint id="child-1" playOrder="2">
              <navLabel><text>Child 1</text></navLabel>
              <content src="Text/child-1.xhtml"/>
            </navPoint>
          </navPoint>
        </navMap>
      </ncx>`,
      'text/xml',
    )

    const nav = new Navigation(xml)

    assert.equal(nav.toc.length, 1)
    assert.equal(nav.toc[0].label, 'Child 1')
    assert.equal(nav.toc[0].href, 'Text/child-1.xhtml')
    assert.equal(nav.toc[0].parent, undefined)
  })

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

  it('gives label-only nav groups distinct identities for their child parent links', function () {
    const xml = new DOMParser().parseFromString(
      `<?xml version="1.0" encoding="utf-8"?>
      <html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
        <body>
          <nav epub:type="toc">
            <ol>
              <li>
                <span>First Author</span>
                <ol>
                  <li id="chapter-1"><a href="chapter.xhtml#one">Chapter 1</a></li>
                </ol>
              </li>
              <li>
                <span>Second Author</span>
                <ol>
                  <li id="chapter-2"><a href="chapter.xhtml#two">Chapter 2</a></li>
                </ol>
              </li>
            </ol>
          </nav>
        </body>
      </html>`,
      'application/xhtml+xml',
    )

    const nav = new Navigation(xml)
    const [first, second] = nav.toc

    assert.ok(first.id)
    assert.ok(second.id)
    assert.notEqual(first.id, second.id)
    assert.equal(first.subitems[0].parent, first.id)
    assert.equal(second.subitems[0].parent, second.id)
  })
})
