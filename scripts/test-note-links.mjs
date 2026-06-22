import assert from 'node:assert/strict'
import fs from 'node:fs'
import Module from 'node:module'
import path from 'node:path'
import test from 'node:test'
import ts from 'typescript'

const file = path.resolve('src/noteLinks.ts')
const source = fs.readFileSync(file, 'utf8')
const output = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
  },
}).outputText
const mod = new Module(file)
mod.filename = file
mod.paths = Module._nodeModulePaths(path.dirname(file))
mod._compile(output, file)

const {
  findSectionByLinkedHref,
  normalizeHrefPath,
  resolveLinkedHrefPath,
  sameHref,
} = mod.exports

test('resolves a sibling split note target against the clicked section', () => {
  assert.equal(
    resolveLinkedHrefPath(
      'text/part0003_split_001.html',
      'part0003_split_002.html',
    ),
    'text/part0003_split_002.html',
  )
})

test('resolves parent-directory note targets without dropping the real path', () => {
  assert.equal(
    resolveLinkedHrefPath('OPS/Text/chapter.xhtml', '../Notes/endnotes.xhtml'),
    'OPS/Notes/endnotes.xhtml',
  )
})

test('finds the exact target section before considering suffix fallbacks', () => {
  const sections = [
    { href: 'text/part0003_split_001.html' },
    { href: 'text/part0003_split_002.html' },
  ]

  assert.equal(
    findSectionByLinkedHref(
      sections,
      'text/part0003_split_001.html',
      'part0003_split_002.html',
    ),
    sections[1],
  )
})

test('matches decoded hrefs and canonical paths', () => {
  const sections = [
    { href: 'Text/%E7%AC%AC%E4%B8%80%E7%AB%A0.xhtml' },
    { href: 'Text/chapter2.xhtml', canonical: '/OPS/Text/chapter2.xhtml' },
  ]

  assert.equal(
    normalizeHrefPath('Text/%E7%AC%AC%E4%B8%80%E7%AB%A0.xhtml'),
    'Text/第一章.xhtml',
  )
  assert.equal(sameHref('OPS/Text/chapter2.xhtml', 'Text/chapter2.xhtml'), true)
  assert.equal(
    findSectionByLinkedHref(
      sections,
      'OPS/Text/current.xhtml',
      'chapter2.xhtml',
    ),
    sections[1],
  )
})
