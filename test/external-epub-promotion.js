const assert = require('assert')
const fs = require('fs')
const Module = require('module')
const path = require('path')

const ts = require('typescript')

function loadTsModule(relativePath, mocks = {}) {
  const sourcePath = path.join(__dirname, '..', relativePath)
  const source = fs.readFileSync(sourcePath, 'utf8')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2019,
    },
    fileName: sourcePath,
  })
  const localRequire = (id) => {
    if (Object.prototype.hasOwnProperty.call(mocks, id)) return mocks[id]
    return require(id)
  }

  const compiledModule = new Module(sourcePath, module)
  compiledModule.filename = sourcePath
  compiledModule.paths = Module._nodeModulePaths(path.dirname(sourcePath))
  compiledModule.require = localRequire
  compiledModule._compile(outputText, sourcePath)

  return compiledModule.exports
}

async function testHandleFilePathsFiltersPromotedBooks() {
  const importResult = {
    books: [
      {
        id: 'library-book',
        scope: 'library',
        contentHash: 'hash',
        metadata: { title: 'Promoted' },
      },
    ],
    failures: [],
  }
  let importCalled = false
  let promotionObservedBeforeReturn = false

  const { handleFilePaths } = loadTsModule('src/file.ts', {
    './db': {
      db: {
        books: {
          remember: () => undefined,
        },
        notify: () => undefined,
      },
      importBookPaths: async () => {
        importCalled = true
        return importResult
      },
      openExternalBookPaths: async () => ({ books: [], failures: [] }),
    },
  })

  const books = await handleFilePaths([path.join('tmp', 'book.epub')], {
    onImportResult: async () => {
      await Promise.resolve()
      promotionObservedBeforeReturn = true
      return new Set(['library-book'])
    },
  })

  assert.strictEqual(importCalled, true)
  assert.strictEqual(promotionObservedBeforeReturn, true)
  assert.deepStrictEqual(books, [])
}

testHandleFilePathsFiltersPromotedBooks().catch((error) => {
  console.error(error)
  process.exit(1)
})
