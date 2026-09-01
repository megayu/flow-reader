import { assert } from 'vitest'

import { normalizeAnnotationRects } from '../src/managers/helpers/annotation-pane'

function rect(left, top, width, height) {
  return { left, top, right: left + width, bottom: top + height, width, height }
}

describe('annotation pane geometry', function () {
  it('uses a uniform line band for mixed-height fragments', function () {
    const normalized = normalizeAnnotationRects([
      { mark: 'selection', rect: rect(0, 0, 40, 25) },
      { mark: 'selection', rect: rect(20, 2, 10, 5) },
    ]).get('selection')

    assert.deepEqual(normalized, [rect(0, 0, 40, 25)])
  })

  it('separates adjacent lines and columns without flattening overlapping marks', function () {
    const horizontal = normalizeAnnotationRects(
      [
        { mark: 'first', rect: rect(10, 10, 80, 24) },
        { mark: 'second', rect: rect(10, 30, 80, 24) },
        { mark: 'overlap', rect: rect(20, 10, 40, 24) },
      ],
      'horizontal-tb',
    )

    assert.equal(horizontal.get('first')[0].bottom, 32)
    assert.equal(horizontal.get('second')[0].top, 32)
    assert.deepInclude(horizontal.get('overlap')[0], {
      left: 20,
      top: 10,
      right: 60,
      bottom: 32,
    })

    const localOverlap = normalizeAnnotationRects([
      { mark: 'overlap-current', rect: rect(0, 0, 10, 30) },
      { mark: 'overlap-next', rect: rect(0, 25, 10, 15) },
      { mark: 'clear-current', rect: rect(100, 0, 10, 20) },
      { mark: 'clear-next', rect: rect(100, 31, 10, 8) },
    ])

    assert.equal(localOverlap.get('overlap-current')[0].bottom, 27.5)
    assert.equal(localOverlap.get('overlap-next')[0].top, 27.5)
    assert.equal(localOverlap.get('clear-current')[0].bottom, 20)
    assert.equal(localOverlap.get('clear-next')[0].top, 31)

    const vertical = normalizeAnnotationRects(
      [
        { mark: 'right', rect: rect(30, 10, 24, 80) },
        { mark: 'left', rect: rect(10, 10, 24, 80) },
      ],
      'vertical-rl',
    )

    assert.equal(vertical.get('left')[0].right, 32)
    assert.equal(vertical.get('right')[0].left, 32)
  })
})
