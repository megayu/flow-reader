import { assert } from 'vitest'
import JSZip from 'jszip'

import Book from '../src/book'
import ePub from '../src/epub'

describe('Book', function () {
  describe('Unpacked EPUB', function () {
    var book = ePub('/fixtures/alice/OPS/package.opf')
    it('opens through the ePub factory', async function () {
      await book.opened
      assert.instanceOf(book, Book, 'the ePub factory returns a Book')
      assert.equal(book.isOpen, true, 'book is opened')
      assert.equal(
        book.url.toString(),
        new URL('/fixtures/alice/OPS/package.opf', location.origin).toString(),
        'book url is passed to new Book',
      )
    })
    it('resolves the local cover URL', async function () {
      assert.equal(
        await book.coverUrl(),
        new URL(
          '/fixtures/alice/OPS/images/cover_th.jpg',
          location.origin,
        ).toString(),
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

    it('decodes package and NCX hrefs before resolving sections', async function () {
      const zip = new JSZip()
      const sectionHref = 'Text%2Fchapter%20one.xhtml'
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
              <content src="${sectionHref}"/>
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
        assert.equal(book.navigation.toc[0].href, decodedSectionHref)
        assert.equal(book.spine.spineItems[0].href, decodedSectionHref)

        const output = await book.spine.spineItems[0].render(
          book.load.bind(book),
        )
        assert.ok(output.includes('Body'))
      } finally {
        book.destroy()
        URL.revokeObjectURL(url)
      }
    })
  })

  describe('Spine document media types', function () {
    it('uses direct supported fallbacks for spine documents and images', async function () {
      const zip = new JSZip()

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
        <package xmlns="http://www.idpf.org/2007/opf" version="3.0">
          <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
            <dc:title>Direct Fallbacks</dc:title>
            <dc:identifier id="id">direct-fallbacks</dc:identifier>
            <dc:language>en</dc:language>
          </metadata>
          <manifest>
            <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
            <item id="data" href="chapter.json" media-type="application/json" fallback="chapter"/>
            <item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/>
            <item id="art" href="art.psd" media-type="image/psd" fallback="art-png"/>
            <item id="art-png" href="art.png" media-type="image/png"/>
          </manifest>
          <spine><itemref idref="data"/></spine>
        </package>`,
      )
      zip.file(
        'OEBPS/nav.xhtml',
        `<?xml version="1.0" encoding="utf-8"?>
        <html xmlns="http://www.w3.org/1999/xhtml">
          <head><title>Navigation</title></head>
          <body>
            <nav epub:type="toc" xmlns:epub="http://www.idpf.org/2007/ops">
              <ol><li><a href="chapter.json">Chapter</a></li></ol>
            </nav>
          </body>
        </html>`,
      )
      zip.file('OEBPS/chapter.json', '{}')
      zip.file(
        'OEBPS/chapter.xhtml',
        `<?xml version="1.0" encoding="utf-8"?>
        <html xmlns="http://www.w3.org/1999/xhtml">
          <head><title>Chapter</title></head>
          <body><img src="art.psd" alt="fallback image"/></body>
        </html>`,
      )
      zip.file('OEBPS/art.psd', 'unsupported')
      zip.file(
        'OEBPS/art.png',
        new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
      )

      const buffer = await zip.generateAsync({ type: 'arraybuffer' })
      const url = URL.createObjectURL(
        new Blob([buffer], { type: 'application/epub+zip' }),
      )
      const book = new Book(url, { openAs: 'epub' })

      try {
        await book.opened
        await book.loaded.navigation

        const section = book.spine.get('chapter.json')
        assert.equal(section.href, 'chapter.xhtml')
        assert.equal(book.navigation.toc[0].href, 'chapter.json')

        const output = await section.render(book.load.bind(book))
        assert.notInclude(output, 'art.psd')
        assert.include(output, `src="blob:${location.origin}/`)
      } finally {
        book.destroy()
        URL.revokeObjectURL(url)
      }
    })

    it('parses .html spine documents declared as XHTML with XHTML semantics', async function () {
      const zip = new JSZip()

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
        <package xmlns="http://www.idpf.org/2007/opf" version="3.0">
          <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
            <dc:title>XHTML HTML Extension</dc:title>
            <dc:identifier id="id">xhtml-html-extension</dc:identifier>
            <dc:language>en</dc:language>
          </metadata>
          <manifest>
            <item id="chapter" href="chapter.html" media-type="application/xhtml+xml"/>
          </manifest>
          <spine><itemref idref="chapter"/></spine>
        </package>`,
      )
      zip.file(
        'OEBPS/chapter.html',
        `<?xml version="1.0" encoding="utf-8"?>
        <html xmlns="http://www.w3.org/1999/xhtml">
          <head><title>Chapter</title></head>
          <body>
            <p>Lead<a data-type="indexterm"/> database text</p>
          </body>
        </html>`,
      )

      const buffer = await zip.generateAsync({ type: 'arraybuffer' })
      const url = URL.createObjectURL(
        new Blob([buffer], { type: 'application/epub+zip' }),
      )
      const book = new Book(url, { openAs: 'epub' })

      try {
        await book.opened
        const section = book.spine.spineItems[0]
        await section.load(book.load.bind(book))

        const paragraph = section.document.querySelector('p')
        const indexMarker = section.document.querySelector(
          'a[data-type="indexterm"]',
        )

        assert.equal(section.document.contentType, 'application/xhtml+xml')
        assert.equal(indexMarker.textContent, '')
        assert.equal(paragraph.textContent.trim(), 'Lead database text')
      } finally {
        book.destroy()
        URL.revokeObjectURL(url)
      }
    })
  })

  describe('Fixed layout metadata', function () {
    it('uses original-resolution as a fallback viewport for fixed layout books', async function () {
      const zip = new JSZip()

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
        <package xmlns="http://www.idpf.org/2007/opf" version="3.0" prefix="rendition: http://www.idpf.org/vocab/rendition/#">
          <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
            <dc:title>Fixed Layout</dc:title>
            <dc:identifier id="id">fixed-layout</dc:identifier>
            <dc:language>en</dc:language>
            <meta name="original-resolution" content="1200x1920"/>
            <meta property="rendition:layout">pre-paginated</meta>
          </metadata>
          <manifest>
            <item id="page" href="Text/page.xhtml" media-type="application/xhtml+xml"/>
          </manifest>
          <spine><itemref idref="page"/></spine>
        </package>`,
      )
      zip.file(
        'OEBPS/Text/page.xhtml',
        `<?xml version="1.0" encoding="utf-8"?>
        <html xmlns="http://www.w3.org/1999/xhtml">
          <head><title>Page</title></head>
          <body><img src="../Images/page.jpeg" width="1200" height="1920"/></body>
        </html>`,
      )

      const buffer = await zip.generateAsync({ type: 'arraybuffer' })
      const url = URL.createObjectURL(
        new Blob([buffer], { type: 'application/epub+zip' }),
      )
      const book = new Book(url, { openAs: 'epub' })

      try {
        await book.opened
        assert.equal(book.package.metadata.layout, 'pre-paginated')
        assert.equal(book.package.metadata.viewport, 'width=1200,height=1920')
      } finally {
        book.destroy()
        URL.revokeObjectURL(url)
      }
    })
  })

  describe('Archived EPUB', function () {
    var book = new Book('/fixtures/alice.epub')

    it('opens the archive', async function () {
      await book.opened
      assert.equal(book.isOpen, true, 'book is opened')
      assert(book.archive, 'book is unarchived')
    })
    it('creates a blob cover URL', async function () {
      let coverUrl = await book.coverUrl()
      assert(
        coverUrl.startsWith(`blob:${location.origin}/`),
        'cover url is available and a blob: url',
      )
    })
  })

  describe('Archived EPUB supplied as an ArrayBuffer', function () {
    let book

    beforeAll(async function () {
      const response = await fetch('/fixtures/alice.epub')
      const buffer = await response.arrayBuffer()
      book = new Book(buffer)
    })

    it('detects and opens the archive without explicit options', async function () {
      await book.opened
      assert.equal(book.isOpen, true, 'book is opened')
      assert(book.archive, 'book is unarchived')
    })

    it('creates a blob cover URL', async function () {
      let coverUrl = await book.coverUrl()
      assert(
        coverUrl.startsWith(`blob:${location.origin}/`),
        'cover url is available and a blob: url',
      )
    })
  })

  describe('Archived EPUB without a cover', function () {
    var book = new Book('/fixtures/alice_without_cover.epub')

    it('opens the archive', async function () {
      await book.opened
      assert.equal(book.isOpen, true, 'book is opened')
      assert(book.archive, 'book is unarchived')
    })
    it('returns no cover URL', async function () {
      let coverUrl = await book.coverUrl()
      assert.equal(coverUrl, null, 'cover url should be null')
    })
  })
})
