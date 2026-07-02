import assert from 'assert'
import JSZip from 'jszip'

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

  describe('Navigation paths', function () {
    var book = new Book('/fixtures/nav-relative/OPS/package.opf')

    it('keeps nav links relative to the nav document directory', async function () {
      await book.opened
      await book.loaded.navigation

      assert.equal(book.navigation.toc.length, 1)
      assert.equal(book.navigation.toc[0].label, 'Relative Chapter')
      assert.equal(book.navigation.toc[0].href, 'Text/chapter.xhtml')
    })

    it('keeps NCX links decoded differently from encoded spine hrefs', async function () {
      const zip = new JSZip()
      const sectionHref = 'Text/%2A%3Achapter%3Aone.xhtml'
      const decodedSectionHref = decodeURIComponent(sectionHref)

      zip.file('mimetype', 'application/epub+zip')
      zip.file(
        'META-INF/container.xml',
        `<?xml version="1.0"?>
        <container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
          <rootfiles>
            <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
          </rootfiles>
        </container>`,
      )
      zip.file(
        'OEBPS/content.opf',
        `<?xml version="1.0" encoding="UTF-8"?>
        <package xmlns="http://www.idpf.org/2007/opf" version="2.0">
          <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
            <dc:title>Encoded NCX</dc:title>
            <dc:identifier id="id">encoded-ncx</dc:identifier>
            <dc:language>en</dc:language>
          </metadata>
          <manifest>
            <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
            <item id="chapter" href="${sectionHref}" media-type="application/xhtml+xml"/>
          </manifest>
          <spine toc="ncx"><itemref idref="chapter"/></spine>
        </package>`,
      )
      zip.file(
        'OEBPS/toc.ncx',
        `<?xml version="1.0" encoding="UTF-8"?>
        <ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
          <head><meta name="dtb:uid" content="encoded-ncx"/></head>
          <docTitle><text>Encoded NCX</text></docTitle>
          <navMap>
            <navPoint id="chapter" playOrder="1">
              <navLabel><text>Decoded Chapter</text></navLabel>
              <content src="${decodedSectionHref}"/>
            </navPoint>
          </navMap>
        </ncx>`,
      )
      zip.file(
        `OEBPS/${decodedSectionHref}`,
        `<?xml version="1.0" encoding="utf-8"?>
        <html xmlns="http://www.w3.org/1999/xhtml">
          <head><title>Decoded Chapter</title></head>
          <body><p>Body</p></body>
        </html>`,
      )

      const buffer = await zip.generateAsync({ type: 'arraybuffer' })
      const url = URL.createObjectURL(
        new Blob([buffer], { type: 'application/epub+zip' }),
      )
      const book = new Book(url, { openAs: 'epub' })

      try {
        await book.opened
        await book.loaded.navigation

        assert.equal(book.navigation.toc.length, 1)
        assert.equal(book.navigation.toc[0].label, 'Decoded Chapter')
      } finally {
        book.destroy()
        URL.revokeObjectURL(url)
      }
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
