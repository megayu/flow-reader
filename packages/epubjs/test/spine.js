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
