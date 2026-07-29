import { assert } from 'vitest'

import Store from '../src/store'

describe('Store', function () {
  it('creates a local storage instance when localForage is available', function () {
    const store = new Store('flow-reader-store-test')

    try {
      assert.ok(store.storage)
    } finally {
      store.destroy()
    }
  })
})
