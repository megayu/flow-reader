import { assert } from 'vitest'

import ePub from '../src/epub'
import EpubCFI from '../src/epubcfi'
import Section from '../src/section'
import searchContract from '../../../tests/support/search-contract.json'

const fixtureUrl = '/fixtures/search/OPS/package.opf'

async function loadFixtureSection() {
  const book = ePub(fixtureUrl)
  await book.ready

  const section = book.section('chapter.xhtml')!
  await section.load()

  return { book, section }
}

describe('Section search', function () {
  it('resolves ordered cross-node matches with literal whitespace', async function () {
    const { book, section } = await loadFixtureSection()
    try {
      for (const entry of searchContract) {
        section.document = new DOMParser().parseFromString(
          `<html xmlns="http://www.w3.org/1999/xhtml"><body>${entry.body}</body></html>`,
          'application/xhtml+xml',
        )
        const nodes: Node[] = []
        const walker = section.document.createTreeWalker(section.document.body, 4)
        let node
        while ((node = walker.nextNode())) nodes.push(node)
        const coordinates = (cfi: string) => {
          const range = new EpubCFI(cfi).toRange(section.document!)!
          return [
            [nodes.indexOf(range.startContainer), range.startOffset],
            [nodes.indexOf(range.endContainer), range.endOffset],
          ]
        }
        for (const matches of [section.find(entry.query), section.search(entry.query), await section.findAsync(entry.query)]) {
          assert.deepEqual(matches.map(({ cfi }) => coordinates(cfi)), entry.matches, entry.name)
        }
        assert.deepEqual(
          entry.matches.map((_, index) => coordinates(section.findOccurrence(entry.query, index)!)),
          entry.matches,
          entry.name,
        )
        assert.isUndefined(section.findOccurrence(entry.query, entry.matches.length), entry.name)
      }
    } finally {
      book.destroy()
    }
  })

  it('returns non-overlapping ranges in original text coordinates', async function () {
    const { book, section } = await loadFixtureSection()
    try {
      for (const { text, query, offsets } of [
        {
          text: 'zzzzz',
          query: 'zz',
          offsets: [[0, 2], [2, 4]],
        },
        { text: 'İ😀Echo', query: 'ECHO', offsets: [[3, 7]] },
        { text: 'İ', query: 'i', offsets: [[0, 1]] },
        { text: 'ΟΣ', query: 'ος', offsets: [[0, 2]] },
      ]) {
        section.document!.body.textContent = text
        const expected = offsets.map(([start, end]) => ({ start, end }))
        const coordinates = (cfi: string) => {
          const range = new EpubCFI(cfi).toRange(section.document!)!
          assert.equal(range.startContainer, section.document!.body.firstChild)
          assert.equal(range.endContainer, range.startContainer)
          return { start: range.startOffset, end: range.endOffset }
        }
        for (const matches of [
          section.find(query),
          await section.findAsync(query),
        ]) {
          assert.deepEqual(
            matches.map(({ cfi }) => coordinates(cfi)),
            expected,
            text,
          )
        }
        assert.deepEqual(
          offsets.map((_, index) =>
            coordinates(section.findOccurrence(query, index)!),
          ),
          expected,
          text,
        )
        if (offsets.length === 1) {
          assert.deepEqual(
            section.search(query).map(({ cfi }) => coordinates(cfi)),
            expected,
            text,
          )
        }
      }
    } finally {
      book.destroy()
    }
  })

  it('locates the requested occurrence with the same CFI as complete search', async function () {
    const { book, section } = await loadFixtureSection()
    try {
      const matches = section.find('repeat marker')
      for (const index of [0, 1]) {
        assert.equal(
          section.findOccurrence('repeat marker', index),
          matches[index]!.cfi,
        )
      }
      assert.isUndefined(section.findOccurrence('repeat marker', 9))
      assert.isUndefined(section.findOccurrence('absent marker', 0))
    } finally {
      book.destroy()
    }
  })

  it('returns complete async matches or discards a cancelled query', async function () {
    const { book, section } = await loadFixtureSection()
    try {
      const expected = section.find('repeat marker')
      assert.deepEqual(await section.findAsync('repeat marker'), expected)
      const controller = new AbortController()
      const cancelled = await section.findAsync('repeat marker', {
        signal: controller.signal,
        mapMatch: (match) => {
          controller.abort()
          return match
        },
      })
      assert.deepEqual(cancelled, [])
      assert.deepEqual(await section.findAsync('repeat marker'), expected)
    } finally {
      book.destroy()
    }
  })

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
        assert.match(results[0]!.cfi, /^epubcfi\(/)
        assert.include(results[0]!.excerpt, 'single searchable phrase')
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
      assert.lengthOf(section.find('Cross node phrase'), 1)

      const results = section.search('Cross node phrase')
      assert.lengthOf(results, 1)
      assert.match(results[0]!.cfi, /^epubcfi\(/)
      assert.include(results[0]!.excerpt, 'Cross node phrase')
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
