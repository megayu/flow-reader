import { assert } from 'vitest'

import Rendition from '../src/rendition'

describe('Rendition layout compatibility', function () {
  it('treats package roll layout as pre-paginated', function () {
    const properties = Rendition.prototype.determineLayoutProperties.call(
      { settings: {} },
      { layout: 'roll' },
    )

    assert.equal(properties.layout, 'pre-paginated')
  })
})
