import { assert } from 'vitest'

import ePub from '../src/epub'
import Section from '../src/section'

const fixtureUrl = '/fixtures/search/OPS/package.opf'

async function loadFixtureSection() {
  const book = ePub(fixtureUrl)
  await book.ready

  const section = book.section('chapter.xhtml')
  await section.load()

  return { book, section }
}

describe('Section search', function () {
  it('excludes document metadata from text results', async function () {
    const { book, section } = await loadFixtureSection()

    try {
      assert.lengthOf(section.find('Metadata-only marker'), 0)
      assert.lengthOf(section.search('Metadata-only marker'), 0)
    } finally {
      book.destroy()
    }
  })

  it('finds one occurrence and returns a usable CFI and excerpt', async function () {
    const { book, section } = await loadFixtureSection()

    try {
      for (const results of [
        section.find('single searchable phrase'),
        section.search('single searchable phrase'),
      ]) {
        assert.lengthOf(results, 1)
        assert.match(results[0].cfi, /^epubcfi\(/)
        assert.include(results[0].excerpt, 'single searchable phrase')
      }
    } finally {
      book.destroy()
    }
  })

  it('finds every occurrence in a section', async function () {
    const { book, section } = await loadFixtureSection()

    try {
      assert.lengthOf(section.find('repeat marker'), 2)
      assert.lengthOf(section.search('repeat marker'), 2)
    } finally {
      book.destroy()
    }
  })

  it('searches across document nodes', async function () {
    const { book, section } = await loadFixtureSection()

    try {
      assert.lengthOf(section.find('Cross node phrase'), 0)

      const results = section.search('Cross node phrase')
      assert.lengthOf(results, 1)
      assert.match(results[0].cfi, /^epubcfi\(/)
      assert.include(results[0].excerpt, 'Cross node phrase')
    } finally {
      book.destroy()
    }
  })
})

describe('Section rendering', function () {
  it('wraps a bitmap spine resource in a renderable XHTML document', async function () {
    const section = new Section({
      idref: 'page',
      linear: 'yes',
      properties: ['page-spread-right'],
      index: 0,
      href: 'Image/page.jpg',
      type: 'image/jpeg',
      url: '/EPUB/Image/page.jpg',
      canonical: '/EPUB/Image/page.jpg',
    })

    const output = await section.render(() =>
      Promise.resolve('binary image response'),
    )
    const document = new DOMParser().parseFromString(
      output,
      'application/xhtml+xml',
    )
    const image = document.querySelector('img')

    assert.equal(image?.getAttribute('src'), '/EPUB/Image/page.jpg')
    assert.equal(image?.getAttribute('alt'), '')
  })

  it('keeps XML stylesheets usable in SVG spine output', async function () {
    const document = new DOMParser().parseFromString(
      `<?xml version="1.0"?>
      <?xml-stylesheet href="../Style/page.css" type="text/css"?>
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
        <text>Page</text>
      </svg>`,
      'image/svg+xml',
    )
    const section = new Section({
      idref: 'page',
      linear: 'yes',
      properties: [],
      index: 0,
      href: 'Content/page.svg',
      type: 'image/svg+xml',
      url: '/EPUB/Content/page.svg',
      canonical: '/EPUB/Content/page.svg',
    })

    const output = await section.render(() => Promise.resolve(document))

    assert.include(output, '@import url("../Style/page.css")')
  })
})
