import { assert, vi } from 'vitest'

import Stage from '../src/managers/helpers/stage'

describe('Stage', function () {
  it('cancels a pending resize callback when destroyed', function () {
    vi.useFakeTimers()

    const stage = new Stage()
    const onResize = vi.fn()
    stage.attachTo(document.body)
    stage.onResize(onResize)

    try {
      window.dispatchEvent(new Event('resize'))
      window.dispatchEvent(new Event('resize'))
      assert.equal(onResize.mock.calls.length, 1)

      stage.destroy()
      vi.advanceTimersByTime(50)

      assert.equal(onResize.mock.calls.length, 1)
    } finally {
      stage.destroy()
      vi.useRealTimers()
    }
  })
})
