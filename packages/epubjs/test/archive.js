import { assert } from 'vitest'

import Archive from '../src/archive'
import Store from '../src/store'

describe('Archive', function () {
  it('revokes cached blob URLs when resource owners are destroyed', function () {
    const revokeObjectUrl = vi
      .spyOn(window.URL, 'revokeObjectURL')
      .mockImplementation(() => {})
    const owners = [new Archive(), new Store('flow-reader-url-cleanup-test')]

    try {
      owners.forEach((owner, index) => {
        const blobUrl = `blob:${location.origin}/resource-${index}`
        owner.urlCache[`/resource-${index}`] = blobUrl
        owner.destroy()

        assert.strictEqual(
          revokeObjectUrl.mock.calls[index]?.[0],
          blobUrl,
        )
      })
    } finally {
      owners.forEach((owner) => owner.removeListeners?.())
      revokeObjectUrl.mockRestore()
    }
  })

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
