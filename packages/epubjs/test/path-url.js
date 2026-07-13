import { assert } from 'vitest'

import Path from '../src/utils/path'
import Url from '../src/utils/url'

describe('Path and URL utilities', function () {
  describe('Url', function () {
    it('Url()', function () {
      var url = new Url('http://example.com/fred/chasen/derf.html')

      assert.equal(url.href, 'http://example.com/fred/chasen/derf.html')
      assert.equal(url.directory, '/fred/chasen/')
      assert.equal(url.extension, 'html')
      assert.equal(url.filename, 'derf.html')
      assert.equal(url.origin, 'http://example.com')
      assert.equal(url.protocol, 'http:')
      assert.equal(url.search, '')
    })

    describe('#resolve()', function () {
      it('should join subfolders', function () {
        var a = 'http://example.com/fred/chasen/'
        var b = 'ops/derf.html'

        var resolved = new Url(a).resolve(b)
        assert.equal(resolved, 'http://example.com/fred/chasen/ops/derf.html')
      })

      it('should resolve up a level', function () {
        var a = 'http://example.com/fred/chasen/index.html'
        var b = '../derf.html'

        var resolved = new Url(a).resolve(b)
        assert.equal(resolved, 'http://example.com/fred/derf.html')
      })

      it('should resolve absolute', function () {
        var a = 'http://example.com/fred/chasen/index.html'
        var b = '/derf.html'

        var resolved = new Url(a).resolve(b)
        assert.equal(resolved, 'http://example.com/derf.html')
      })

      it('should resolve with search strings', function () {
        var a = 'http://example.com/fred/chasen/index.html?debug=true'
        var b = '/derf.html'

        var resolved = new Url(a).resolve(b)
        assert.equal(resolved, 'http://example.com/derf.html')
      })

      it('should handle file urls', function () {
        var url = new Url('file:///library/sample/OPS/Text/chapter.xhtml')

        assert.equal(url.href, 'file:///library/sample/OPS/Text/chapter.xhtml')
        assert.equal(url.directory, '/library/sample/OPS/Text/')
        assert.equal(url.extension, 'xhtml')
        assert.equal(url.filename, 'chapter.xhtml')
        assert.equal(url.origin, 'file://')
        assert.equal(url.protocol, 'file:')
        assert.equal(url.search, '')
      })

      it('should resolve with file urls', function () {
        var a = 'file:///books/sample/OPS/Text/'
        var b = '../Images/cover.jpg'

        var resolved = new Url(a).resolve(b)
        assert.equal(resolved, 'file:///books/sample/OPS/Images/cover.jpg')
      })

      it('resolves encoded resources from the cross-platform Tauri asset protocol', function () {
        const chapter = new Url(
          'asset://localhost/%2Fbooks%2Fsample.epub%2FOPS%2FText%2Fchapter.xhtml',
        )

        assert.equal(chapter.directory, '/books/sample.epub/OPS/Text/')
        assert.equal(
          chapter.resolve('../Images/cover.jpg'),
          'asset://localhost/%2Fbooks%2Fsample.epub%2FOPS%2FImages%2Fcover.jpg',
        )
      })

      it('resolves encoded Windows resources from the Tauri HTTP asset host', function () {
        const chapter = new Url(
          'http://asset.localhost/C%3A%5Cbooks%5Csample.epub%5COPS%5CText%5Cchapter.xhtml',
        )

        assert.equal(chapter.directory, '/C:/books/sample.epub/OPS/Text/')
        assert.equal(
          chapter.resolve('../Images/cover.jpg'),
          'http://asset.localhost/C%3A%2Fbooks%2Fsample.epub%2FOPS%2FImages%2Fcover.jpg',
        )
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

    it('ignores query strings and hashes when parsing file type', function () {
      var path = new Path('fred/chasen/derf.xhtml?flowContentVersion=1#page')

      assert.equal(path.path, 'fred/chasen/derf.xhtml')
      assert.equal(path.directory, 'fred/chasen/')
      assert.equal(path.extension, 'xhtml')
      assert.equal(path.filename, 'derf.xhtml')
    })

    it('ignores URL query strings when parsing file type', function () {
      var path = new Path(
        'http://example.com/fred/chasen/derf.xhtml?flowContentVersion=1',
      )

      assert.equal(path.path, '/fred/chasen/derf.xhtml')
      assert.equal(path.directory, '/fred/chasen/')
      assert.equal(path.extension, 'xhtml')
      assert.equal(path.filename, 'derf.xhtml')
    })

    describe('#parse()', function () {
      it('should parse a path', function () {
        var path = Path.prototype.parse('/fred/chasen/derf.html')

        assert.equal(path.dir, '/fred/chasen')
        assert.equal(path.base, 'derf.html')
        assert.equal(path.ext, '.html')
      })

      it('should parse a relative path', function () {
        var path = Path.prototype.parse('fred/chasen/derf.html')

        assert.equal(path.dir, 'fred/chasen')
        assert.equal(path.base, 'derf.html')
        assert.equal(path.ext, '.html')
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
      it('should resolve a path', function () {
        var a = '/fred/chasen/index.html'
        var b = 'derf.html'

        var resolved = new Path(a).resolve(b)
        assert.equal(resolved, '/fred/chasen/derf.html')
      })

      it('should resolve a relative path', function () {
        var a = 'fred/chasen/index.html'
        var b = 'derf.html'

        var resolved = new Path(a).resolve(b)
        assert.equal(resolved, '/fred/chasen/derf.html')
      })

      it('should resolve a level up', function () {
        var a = '/fred/chasen/index.html'
        var b = '../derf.html'

        var resolved = new Path(a).resolve(b)
        assert.equal(resolved, '/fred/derf.html')
      })
    })

    describe('#relative()', function () {
      it('should find a relative path at the same level', function () {
        var a = '/fred/chasen/index.html'
        var b = '/fred/chasen/derf.html'

        var relative = new Path(a).relative(b)
        assert.equal(relative, 'derf.html')
      })

      it('should find a relative path down a level', function () {
        var a = '/fred/chasen/index.html'
        var b = '/fred/chasen/ops/derf.html'

        var relative = new Path(a).relative(b)
        assert.equal(relative, 'ops/derf.html')
      })

      it('should resolve a level up', function () {
        var a = '/fred/chasen/index.html'
        var b = '/fred/derf.html'

        var relative = new Path(a).relative(b)
        assert.equal(relative, '../derf.html')
      })
    })
  })
})
