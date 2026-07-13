import { assert } from 'vitest'

import Locations from '../src/locations'
import * as core from '../src/utils/core'
import locationsChapter from './fixtures/locations.xhtml?raw'

describe('Locations', function () {
  describe('#parse', function () {
    var chapter = locationsChapter

    it('parses locations with the browser XML parser', function () {
      var doc = core.parse(chapter, 'application/xhtml+xml')
      var contents = doc.documentElement
      var locations = new Locations()
      var result = locations.parse(contents, '/6/4[chap01ref]', 100)
      assert.equal(result.length, 15)
    })

    it('parses locations with the fallback XML parser', function () {
      var doc = core.parse(chapter, 'application/xhtml+xml', true)
      var contents = doc.documentElement

      var locations = new Locations()
      var result = locations.parse(contents, '/6/4[chap01ref]', 100)
      assert.equal(result.length, 15)
    })
  })
})
