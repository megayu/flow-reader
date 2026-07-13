import { assert } from 'vitest'

import Stage from '../src/managers/helpers/stage'

describe('Stage overflow', function () {
  it('hides native scrollbars for horizontal paginated scrolling', function () {
    const stage = new Stage({
      axis: 'horizontal',
      overflow: 'scroll',
    })

    try {
      assert.equal(stage.container.style.overflowX, 'scroll')
      assert.equal(stage.container.style.overflowY, 'hidden')
      assert.equal(
        stage.container.classList.contains(
          'epub-container-horizontal-scrollbar-hidden',
        ),
        true,
      )
      assert.equal(stage.container.style.scrollbarWidth, 'none')
      assert.equal(stage.container.style.msOverflowStyle, 'none')
      assert.ok(
        document.getElementById('epub-container-horizontal-scrollbar-style'),
      )

      stage.overflow('visible')

      assert.equal(
        stage.container.classList.contains(
          'epub-container-horizontal-scrollbar-hidden',
        ),
        false,
      )
      assert.equal(stage.container.style.scrollbarWidth, '')
      assert.equal(stage.container.style.msOverflowStyle, '')
    } finally {
      stage.destroy()
      stage.container.remove()
    }
  })
})
