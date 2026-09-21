import { assert } from 'vitest'

import Path from '../src/utils/path'
import Url from '../src/utils/url'

describe('Path and URL utilities', function () {
  describe('Url', function () {
    it('parses supported URL forms', function () {
      const cases = [
        [
          'http://example.com/fred/chasen/derf.html',
          'http://example.com',
          'http:',
          '/fred/chasen/',
          'html',
          'derf.html',
        ],
        [
          'file:///library/sample/OPS/Text/chapter.xhtml',
          'file://',
          'file:',
          '/library/sample/OPS/Text/',
          'xhtml',
          'chapter.xhtml',
        ],
      ] as const

      for (const [input, origin, protocol, directory, extension, filename] of cases) {
        const url = new Url(input)
        assert.equal(url.href, input)
        assert.equal(url.origin, origin)
        assert.equal(url.protocol, protocol)
        assert.equal(url.directory, directory)
        assert.equal(url.extension, extension)
        assert.equal(url.filename, filename)
        assert.equal(url.search, '')
      }
    })

    describe('#resolve()', function () {
      it('resolves supported URL forms', function () {
        const cases = [
          ['http://example.com/fred/chasen/', 'ops/derf.html', 'http://example.com/fred/chasen/ops/derf.html'],
          ['http://example.com/fred/chasen/index.html', '../derf.html', 'http://example.com/fred/derf.html'],
          ['http://example.com/fred/chasen/index.html', '/derf.html', 'http://example.com/derf.html'],
          ['http://example.com/fred/chasen/index.html?debug=true', '/derf.html', 'http://example.com/derf.html'],
          ['file:///books/sample/OPS/Text/', '../Images/cover.jpg', 'file:///books/sample/OPS/Images/cover.jpg'],
          [
            'asset://localhost/%2Fbooks%2Fsample.epub%2FOPS%2FText%2Fchapter.xhtml',
            '../Images/cover.jpg',
            'asset://localhost/%2Fbooks%2Fsample.epub%2FOPS%2FImages%2Fcover.jpg',
          ],
          [
            'http://asset.localhost/C%3A%5Cbooks%5Csample.epub%5COPS%5CText%5Cchapter.xhtml',
            '../Images/cover.jpg',
            'http://asset.localhost/C%3A%2Fbooks%2Fsample.epub%2FOPS%2FImages%2Fcover.jpg',
          ],
        ] as const

        for (const [base, target, expected] of cases) {
          assert.equal(new Url(base).resolve(target), expected)
        }
      })
    })
  })

  describe('Path', function () {
    it('Path()', function () {
      var path = new Path('/fred/chasen/derf.html')

      assert.equal(path.path, '/fred/chasen/derf.html')
      assert.equal(path.directory, '/fred/chasen/')
      assert.equal(path.extension, 'html')
      assert.equal(path.filename, 'derf.html')
    })

    it('Strip out url', function () {
      var path = new Path('http://example.com/fred/chasen/derf.html')

      assert.equal(path.path, '/fred/chasen/derf.html')
      assert.equal(path.directory, '/fred/chasen/')
      assert.equal(path.extension, 'html')
      assert.equal(path.filename, 'derf.html')
    })

    it('ignores query strings and hashes when parsing file types', function () {
      const cases = [
        ['fred/chasen/derf.xhtml?flowContentVersion=1#page', 'fred/chasen/derf.xhtml'],
        ['http://example.com/fred/chasen/derf.xhtml?flowContentVersion=1', '/fred/chasen/derf.xhtml'],
      ] as const

      for (const [input, expectedPath] of cases) {
        const path = new Path(input)
        assert.equal(path.path, expectedPath)
        assert.equal(path.extension, 'xhtml')
        assert.equal(path.filename, 'derf.xhtml')
      }
    })

    describe('#parse()', function () {
      it('parses absolute and relative paths', function () {
        for (const [input, directory] of [
          ['/fred/chasen/derf.html', '/fred/chasen'],
          ['fred/chasen/derf.html', 'fred/chasen'],
        ] as const) {
          const path = Path.prototype.parse(input)
          assert.equal(path.dir, directory)
          assert.equal(path.base, 'derf.html')
          assert.equal(path.ext, '.html')
        }
      })
    })

    describe('#isDirectory()', function () {
      it('should recognize a directory', function () {
        var directory = Path.prototype.isDirectory('/fred/chasen/')
        var notDirectory = Path.prototype.isDirectory('/fred/chasen/derf.html')

        assert(directory, '/fred/chasen/ is a directory')
        assert(!notDirectory, '/fred/chasen/derf.html is not directory')
      })
    })

    describe('#resolve()', function () {
      it('resolves absolute and relative paths', function () {
        const cases = [
          ['/fred/chasen/index.html', 'derf.html', '/fred/chasen/derf.html'],
          ['fred/chasen/index.html', 'derf.html', '/fred/chasen/derf.html'],
          ['/fred/chasen/index.html', '../derf.html', '/fred/derf.html'],
        ] as const

        for (const [base, target, expected] of cases) {
          assert.equal(new Path(base).resolve(target), expected)
        }
      })
    })

    describe('#relative()', function () {
      it('finds relative paths across directory levels', function () {
        const cases = [
          ['/fred/chasen/derf.html', 'derf.html'],
          ['/fred/chasen/ops/derf.html', 'ops/derf.html'],
          ['/fred/derf.html', '../derf.html'],
        ] as const

        for (const [target, expected] of cases) {
          assert.equal(new Path('/fred/chasen/index.html').relative(target), expected)
        }
      })
    })
  })
})
