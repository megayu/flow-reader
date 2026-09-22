import assert from 'node:assert/strict'

import { test } from 'vitest'

import * as noteSemanticsModule from '../../src/noteSemantics.ts'

const noteSemantics = noteSemanticsModule as Record<string, any>

function testNoteMarkersSupportCjkBrackets() {
  assert.strictEqual(typeof noteSemantics.isNoteMarkerText, 'function', 'Expected note marker recognition to be shared')

  assert.strictEqual(noteSemantics.isNoteMarkerText('[67]'), true)
  assert.strictEqual(noteSemantics.isNoteMarkerText('〚95〛'), true)
  assert.strictEqual(noteSemantics.isNoteMarkerText('〖95〗'), true)
  assert.strictEqual(noteSemantics.isNoteMarkerText('【零】'), true)
  assert.strictEqual(noteSemantics.isNoteMarkerText('【九】'), true)
  assert.strictEqual(noteSemantics.isNoteMarkerText('【壹拾貳】'), true)
  assert.strictEqual(noteSemantics.isNoteMarkerText('〚note〛'), false)
}

test(testNoteMarkersSupportCjkBrackets.name, testNoteMarkersSupportCjkBrackets)

test('declared backlinks are recognized only from backlink tokens', () => {
  const anchor = (attributes: Record<string, string | undefined>) => ({
    getAttribute: (name: string) => attributes[name] ?? null,
  })

  for (const attributes of [
    { role: 'doc-backlink' },
    { role: 'link BACKLINK' },
    { 'epub:type': 'backlink' },
    { type: 'doc-backlink' },
  ]) {
    assert.equal(noteSemantics.isNoteBacklink(anchor(attributes)), true)
  }
  for (const attributes of [{}, { role: 'link' }, { 'epub:type': 'footnote' }, { type: 'footnote' }]) {
    assert.equal(noteSemantics.isNoteBacklink(anchor(attributes)), false)
  }
})

test('declared note semantics distinguish references, note items, collections and ordinary links', () => {
  const element = (attributes: Record<string, string | undefined>, tagName = 'DIV') => ({
    tagName,
    className: attributes.class ?? '',
    getAttribute: (name: string) => attributes[name] ?? null,
  })
  assert.equal(noteSemantics.isExplicitNoteLink(element({ 'data-type': ' FOOTNOTE ' })), true)
  for (const attributes of [{}, { role: 'doc-backlink' }, { 'epub:type': 'footnote' }]) {
    assert.equal(noteSemantics.isExplicitNoteLink(element(attributes)), false)
  }
  for (const [attribute, items, collections] of [
    ['data-type', ['footnote', 'endnote'], ['footnotes', 'endnotes']],
    ['role', ['doc-footnote', 'doc-endnote', 'doc-note', 'note'], ['doc-footnotes', 'doc-endnotes']],
    ['epub:type', ['footnote', 'endnote', 'rearnote', 'note'], ['footnotes', 'endnotes']],
    ['type', ['footnote', 'endnote', 'rearnote', 'note'], ['footnotes', 'endnotes']],
  ] as const) {
    for (const token of [...items, ...collections]) {
      const attributes = { [attribute]: ` ${token.toUpperCase()} ` }
      const node = element(attributes)
      assert.equal(noteSemantics.hasDeclaredNoteSemantics(node), true, `${attribute}=${token}`)
      assert.equal(noteSemantics.hasNoteContainerSemantics(node), true)
      assert.equal(noteSemantics.hasNoteCollectionSemantics(node), (collections as readonly string[]).includes(token))
      assert.equal(noteSemantics.hasNoteContainerSemantics(element({ ...attributes, href: '#note' }, 'A')), false)
    }
  }
  for (const className of [
    'footnote',
    'endnote',
    'footnotes',
    'endnotes',
    'duokan-footnote-content',
    'prefix-endnote',
    'footnote-marker',
  ]) {
    assert.equal(noteSemantics.hasNoteContainerSemantics(element({ class: className })), true, className)
  }
  for (const className of ['', 'fnote', 'calibre18', 'notfootnote', 'footnoteworthy']) {
    assert.equal(noteSemantics.hasNoteContainerSemantics(element({ class: className })), false, className)
  }
})
