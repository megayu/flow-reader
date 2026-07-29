import { assert } from 'vitest'

import Archive from '../src/archive'

describe('Archive', function () {
  it('rejects archive reads when an entry cannot be decoded', async function () {
    const failure = new Error('synthetic archive read failure')
    const archive = new Archive()
    archive.zip = {
      file() {
        return {
          async() {
            return Promise.reject(failure)
          },
        }
      },
    }

    for (const read of [
      () => archive.request('/chapter.xhtml', 'text'),
      () => archive.createUrl('/chapter.xhtml'),
    ]) {
      const outcome = await Promise.race([
        read().then(
          () => 'resolved',
          (error) => error,
        ),
        new Promise((resolve) => window.setTimeout(() => resolve('pending'), 50)),
      ])

      assert.strictEqual(outcome, failure)
    }
  })
})
