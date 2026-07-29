import assert from 'node:assert/strict'

import { test } from 'vitest'

import { findSectionByLinkedHref, resolveLinkedHrefPath } from '../../src/noteLinks.ts'

test('resolves linked note paths relative to the clicked section', () => {
  const cases = [
    {
      baseHref: 'text/part0003_split_001.html',
      linkedPath: 'part0003_split_002.html',
      expected: 'text/part0003_split_002.html',
    },
    {
      baseHref: 'OPS/Text/chapter.xhtml',
      linkedPath: '../Notes/endnotes.xhtml',
      expected: 'OPS/Notes/endnotes.xhtml',
    },
  ]

  for (const { baseHref, linkedPath, expected } of cases) {
    assert.equal(resolveLinkedHrefPath(baseHref, linkedPath), expected)
  }
})

test('finds the exact target section before considering suffix fallbacks', () => {
  const sections = [{ href: 'text/part0003_split_001.html' }, { href: 'text/part0003_split_002.html' }]

  assert.equal(
    findSectionByLinkedHref(sections, 'text/part0003_split_001.html', 'part0003_split_002.html'),
    sections[1],
  )
})
