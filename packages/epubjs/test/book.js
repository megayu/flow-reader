import assert from 'assert'

import Book from '../src/book'

describe('Book', function () {
  describe('Unarchived', function () {
    var book = new Book('/fixtures/alice/OPS/package.opf')
    it('should open a epub', async function () {
      await book.opened
      assert.equal(book.isOpen, true, 'book is opened')
      assert.equal(
        book.url.toString(),
        'http://localhost:9876/fixtures/alice/OPS/package.opf',
        'book url is passed to new Book',
      )
    })
    it('should have a local coverUrl', async function () {
      assert.equal(
        await book.coverUrl(),
        'http://localhost:9876/fixtures/alice/OPS/images/cover_th.jpg',
        'cover url is available',
      )
    })
    it('should filter non-readable navigation entries', async function () {
      await book.opened
      await book.loaded.navigation

      assert.equal(
        book.navigation.get('cover.xhtml'),
        undefined,
        'linear=no cover is not exposed in navigation',
      )
      assert.equal(
        book.navigation.get('toc.xhtml'),
        undefined,
        'linear=no toc is not exposed in navigation',
      )
    })
    it('should skip non-readable spine entries', async function () {
      await book.opened

      const first = book.spine.get()
      const cover = book.spine.spineItems[0]
      const toc = book.spine.spineItems[1]

      assert.equal(first.href, 'titlepage.xhtml')
      assert.equal(book.spine.get('cover.xhtml'), null)
      assert.equal(book.spine.get('toc.xhtml'), null)
      assert.equal(cover.next().href, 'titlepage.xhtml')
      assert.equal(toc.next().href, 'titlepage.xhtml')
      assert.equal(first.prev(), undefined)
    })
  })

  describe('Archived epub', function () {
    var book = new Book('/fixtures/alice.epub')

    it('should open a archived epub', async function () {
      await book.opened
      assert.equal(book.isOpen, true, 'book is opened')
      assert(book.archive, 'book is unarchived')
    })
    it('should have a blob coverUrl', async function () {
      let coverUrl = await book.coverUrl()
      assert(
        /^blob:http:\/\/localhost:9876\/[^\/]+$/.test(coverUrl),
        'cover url is available and a blob: url',
      )
    })
  })

  describe('Archived epub in array buffer without options', function () {
    let book

    before(async function () {
      const response = await fetch('/fixtures/alice.epub')
      const buffer = await response.arrayBuffer()
      book = new Book(buffer)
    })

    it('should open a archived epub', async function () {
      await book.opened
      assert.equal(book.isOpen, true, 'book is opened')
      assert(book.archive, 'book is unarchived')
    })

    it('should have a blob coverUrl', async function () {
      let coverUrl = await book.coverUrl()
      assert(
        /^blob:http:\/\/localhost:9876\/[^\/]+$/.test(coverUrl),
        'cover url is available and a blob: url',
      )
    })
  })

  describe('Archived epub without cover', function () {
    var book = new Book('/fixtures/alice_without_cover.epub')

    it('should open a archived epub', async function () {
      await book.opened
      assert.equal(book.isOpen, true, 'book is opened')
      assert(book.archive, 'book is unarchived')
    })
    it('should have a empty coverUrl', async function () {
      let coverUrl = await book.coverUrl()
      assert.equal(coverUrl, null, 'cover url should be null')
    })
  })
})
