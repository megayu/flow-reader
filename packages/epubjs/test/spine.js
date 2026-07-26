import { assert } from 'vitest'

import Spine from '../src/spine'

function createSpine() {
  const spine = new Spine()
  const resolved = []

  spine.unpack(
    {
      spine: [
        { idref: 'missing', linear: 'yes', properties: [] },
        { idref: 'empty', linear: 'yes', properties: [] },
        { idref: 'toc', linear: 'no', properties: [] },
        { idref: 'chapter', linear: 'yes', properties: [] },
      ],
      manifest: {
        empty: { href: '', properties: [] },
        toc: { href: 'toc.xhtml', properties: [] },
        chapter: { href: 'chapter.xhtml', properties: [] },
      },
      spineNodeIndex: 0,
    },
    (href) => {
      resolved.push(href)
      return 'resolved/' + href
    },
    (href) => 'canonical/' + href,
  )

  return { resolved, spine }
}

describe('Spine', function () {
  it('resolves duplicate spine hrefs to their first occurrence', function () {
    const spine = new Spine()

    spine.unpack(
      {
        spine: [
          { idref: 'chapter', linear: 'yes', properties: [] },
          { idref: 'chapter', linear: 'yes', properties: [] },
          { idref: 'chapter', linear: 'yes', properties: [] },
        ],
        manifest: {
          chapter: {
            href: 'chapter.xhtml',
            type: 'application/xhtml+xml',
            properties: [],
          },
        },
        spineNodeIndex: 0,
      },
      (href) => 'resolved/' + href,
      (href) => 'canonical/' + href,
    )

    assert.equal(spine.get('chapter.xhtml'), spine.spineItems[0])
    assert.equal(spine.get(1), spine.spineItems[1])
    assert.equal(spine.get(2), spine.spineItems[2])
  })

  it('omits unsupported media while preserving readable order and CFIs', function () {
    const spine = new Spine()

    spine.unpack(
      {
        spine: [
          { idref: 'first', linear: 'yes', properties: [] },
          { idref: 'pdf', linear: 'yes', properties: [] },
          { idref: 'image', linear: 'yes', properties: [] },
          { idref: 'last', linear: 'yes', properties: [] },
        ],
        manifest: {
          first: {
            href: 'first.xhtml',
            type: 'application/xhtml+xml',
            properties: [],
          },
          pdf: {
            href: 'document.pdf',
            type: 'application/pdf',
            properties: [],
          },
          image: {
            href: 'page.jpg',
            type: 'image/jpeg',
            properties: [],
          },
          last: {
            href: 'last.xhtml',
            type: 'application/xhtml+xml',
            properties: [],
          },
        },
        spineNodeIndex: 0,
      },
      (href) => 'resolved/' + href,
      (href) => 'canonical/' + href,
    )

    const [first, image, last] = spine.spineItems
    const lastCfi = `epubcfi(${last.cfiBase}!/4/2:0)`

    assert.deepEqual(
      spine.spineItems.map((section) => section.href),
      ['first.xhtml', 'page.jpg', 'last.xhtml'],
    )
    assert.equal(spine.get('document.pdf'), null)
    assert.equal(spine.get('#pdf'), null)
    assert.equal(first.next(), image)
    assert.equal(image.next(), last)
    assert.equal(last.prev(), image)
    assert.equal(spine.get(lastCfi), last)
  })

  it('marks itemrefs without manifest resources as non-readable', function () {
    const { resolved, spine } = createSpine()
    const missing = spine.spineItems[0]
    const empty = spine.spineItems[1]
    const toc = spine.spineItems[2]
    const chapter = spine.spineItems[3]

    assert.equal(missing.resourceAvailable, false)
    assert.equal(empty.resourceAvailable, false)
    assert.deepEqual(resolved, ['toc.xhtml', 'chapter.xhtml'])

    assert.equal(spine.get(), chapter)
    assert.equal(spine.get(0), null)
    assert.equal(spine.get(1), null)
    assert.equal(spine.get(2), null)
    assert.equal(spine.get(3), chapter)

    assert.equal(missing.next(), chapter)
    assert.equal(empty.next(), chapter)
    assert.equal(toc.next(), chapter)
    assert.equal(chapter.prev(), undefined)
    assert.equal(spine.spineByHref.undefined, undefined)
  })
})
