import { assert, expect } from 'vitest'
import Queue from '../src/utils/queue'

describe('Reader operation queue', () => {
  it('rejects failed work and continues with the next operation', async () => {
    for (const asynchronous of [false, true]) {
      const queue = new Queue()
      const error = new Error('Operation failed')
      const failed = queue.enqueue(() => {
        if (asynchronous) return Promise.reject(error)
        throw error
      })
      const recovered = queue.enqueue(() => 42)
      await expect(failed).rejects.toBe(error)
      assert.equal(await recovered, 42)
      queue.stop()
    }
  })
})
