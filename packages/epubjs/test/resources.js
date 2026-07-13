import { assert } from 'vitest'
import JSZip from 'jszip'

import Book from '../src/book'
import Resources from '../src/resources'

describe('Resources', function () {
  it('substitutes decoded resource links for encoded manifest hrefs', function () {
    const sectionHref =
      'Text/%2A%2A%2A%2A%2A%3A%3A%2A%2A%3A%2A%3A%2A%2A%2A%3A%3A%3A%3A%2A%2A%2A%3A%2A%2A%3A%2A%3A%2A%2A%3A%3A%2A%3A%3A%2A%2A%2A%3A%2A%3A%3A%2A%2A%2A%3A%2A%2A%2A%2A%2A%2A%3A%2A%3A%3A%2A%2A%3A%3A%3A%2A%3A.xhtml'
    const styleHref =
      'Styles/%2A%2A%2A%3A%2A%2A%3A%3A%2A%2A%2A%3A%3A%2A%2A%3A%3A%3A%2A%2A%2A%3A%3A%2A%2A%3A%2A%2A%3A%2A%2A%3A%2A%2A%3A%2A%3A%2A%2A%3A%2A%3A%3A%2A%3A%2A%2A%2A%3A%2A%2A%2A%2A%3A%2A%2A%2A%3A%2A%3A%2A%2A%3A%3A.css'
    const decodedStyleHref = decodeURIComponent(styleHref)
    const resources = new Resources(
      {
        style: {
          href: styleHref,
          type: 'text/css',
        },
      },
      {
        resolver: (href) => `/OEBPS/${href}`,
        replacements: 'blobUrl',
      },
    )

    resources.replacementUrls = ['blob:style-one']

    const output = resources.substitute(
      `<link href="../${decodedStyleHref}" rel="stylesheet"/>`,
      `/OEBPS/${sectionHref}`,
    )

    assert.equal(output, '<link href="blob:style-one" rel="stylesheet"/>')
  })

  it('replaces decoded stylesheet links while rendering archived sections', async function () {
    const zip = new JSZip()
    const sectionHref = 'Text/%2A%3Achapter%3Aone.xhtml'
    const styleHref = 'Styles/%2A%3Astyle%3Aone.css'
    const decodedSectionHref = decodeURIComponent(sectionHref)
    const decodedStyleHref = decodeURIComponent(styleHref)

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
          <dc:title>Encoded Resources</dc:title>
          <dc:identifier id="id">encoded-resources</dc:identifier>
          <dc:language>en</dc:language>
        </metadata>
        <manifest>
          <item id="chapter" href="${sectionHref}" media-type="application/xhtml+xml"/>
          <item id="style" href="${styleHref}" media-type="text/css"/>
        </manifest>
        <spine><itemref idref="chapter"/></spine>
      </package>`,
    )
    zip.file(
      `OEBPS/${decodedSectionHref}`,
      `<?xml version="1.0" encoding="utf-8"?>
      <html xmlns="http://www.w3.org/1999/xhtml">
        <head>
          <link href="../${decodedStyleHref}" rel="stylesheet" type="text/css"/>
        </head>
        <body><p>Body</p></body>
      </html>`,
    )
    zip.file(`OEBPS/${decodedStyleHref}`, 'body { color: rgb(1, 2, 3); }')

    const buffer = await zip.generateAsync({ type: 'arraybuffer' })
    const url = URL.createObjectURL(
      new Blob([buffer], { type: 'application/epub+zip' }),
    )
    const book = new Book(url, { openAs: 'epub' })

    try {
      await book.opened

      const output = await book
        .section(sectionHref)
        .render(book.load.bind(book))

      assert.equal(
        output.includes(`../${decodedStyleHref}`),
        false,
        'decoded stylesheet href must not remain in rendered output',
      )
      assert.include(output, `href="blob:${location.origin}/`)
    } finally {
      book.destroy()
      URL.revokeObjectURL(url)
    }
  })
})
