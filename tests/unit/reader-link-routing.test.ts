import assert from 'node:assert/strict'

import { test } from 'vitest'

import { getBookLinkDisplayTarget, getInternalBookHref } from '../../src/components/reader/noteContent.ts'
import { isSupportedExternalUrl } from '../../src/externalLink.ts'
import type { BookTab } from '../../src/models/reader'

function link(href: string | null) {
  return {
    getAttribute: () => href,
    ownerDocument: {
      querySelector: () => ({ getAttribute: () => 'Text/chapter.xhtml' }),
    },
  } as unknown as HTMLAnchorElement
}

test('reader links separate internal references from supported and unsupported external schemes', () => {
  for (const [href, external, internal] of [
    [null, false, undefined],
    ['', false, undefined],
    ['   ', false, undefined],
    ['#note', false, '#note'],
    [' chapter.xhtml#note ', false, 'chapter.xhtml#note'],
    ['https://example.test/#note', true, undefined],
    ['http://example.test/', true, undefined],
    ['mailto:reader@example.test', true, undefined],
    ['HTTPS://example.test/', true, undefined],
    ['//example.test/path', false, undefined],
    ['ftp://example.test/book', false, undefined],
    ['file:///book.xhtml', false, undefined],
    ['data:text/html,content', false, undefined],
    ['javascript:void(0)', false, undefined],
    ['tel:1234', false, undefined],
    ['custom:note', false, undefined],
  ] as const) {
    assert.equal(isSupportedExternalUrl(href ?? ''), external, String(href))
    assert.equal(getInternalBookHref(link(href)), internal, String(href))
  }
})

test('internal display targets retain fragments and use the referring document to resolve sections', () => {
  const tab = {
    section: { href: 'Other/current.xhtml' },
    sections: [{ href: 'Text/chapter.xhtml' }, { href: 'Notes/notes.xhtml' }],
  } as unknown as BookTab
  for (const [href, expected] of [
    ['#note', 'Text/chapter.xhtml#note'],
    ['chapter.xhtml', 'Text/chapter.xhtml'],
    ['chapter.xhtml#', 'Text/chapter.xhtml'],
    ['../Notes/notes.xhtml#note', 'Notes/notes.xhtml#note'],
    ['chapter.xhtml##ref', 'Text/chapter.xhtml##ref'],
    ['#%23ref', 'Text/chapter.xhtml##ref'],
    ['#a%3Ab', 'Text/chapter.xhtml#a:b'],
    ['#bad%ZZ', 'Text/chapter.xhtml#bad%ZZ'],
    ['missing.xhtml#note', undefined],
    ['#', undefined],
    ['', undefined],
  ] as const) {
    assert.equal(getBookLinkDisplayTarget(tab, link(href)), expected, href)
  }
  assert.equal(getBookLinkDisplayTarget(tab, link('#note'), 'Notes/notes.xhtml'), 'Notes/notes.xhtml#note')
})
