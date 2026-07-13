import { assert } from 'vitest'

import ePub from '../src/epub'

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
