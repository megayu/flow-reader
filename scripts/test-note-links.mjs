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

const { findSectionByLinkedHref, resolveLinkedHrefPath } = mod.exports

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
