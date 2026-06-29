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

const styles = loadTsModule('src/styles.ts', {
  react: {},
  '@flow/epubjs': {},
  './bodyText': {
    bodyTextCandidateSelector: 'p',
    bodyTextSelector: '[data-flow-body-text]',
    ensureBodyTextMarkers: () => undefined,
    getBodyTypographyBaseline: () => ({}),
    notePopoverClass: 'flow-note-popover',
  },
  './state': {},
  './utils': {
    keys: Object.keys,
  },
})

const annotation = loadTsModule('src/annotation.ts')

function testTextAlignIsNonPaginationStyle() {
  assert.strictEqual(
    typeof styles.createTypographyStyleSignature,
    'function',
    'Expected a style signature separate from pagination layout signature',
  )

  const layoutBase = {
    fontFamily: 'Serif',
    fontSize: '18px',
    fontWeight: 400,
    lineHeight: 1.6,
    textIndent: 2,
    hideEndnotes: false,
    zoom: 1,
    spread: 'auto',
  }

  assert.strictEqual(
    styles.createTypographyLayoutSignature({
      ...layoutBase,
      textAlign: 'default',
    }),
    styles.createTypographyLayoutSignature({
      ...layoutBase,
      textAlign: 'justify',
    }),
    'textAlign must not invalidate pagination layout cache',
  )

  assert.notStrictEqual(
    styles.createTypographyStyleSignature({ textAlign: 'default' }),
    styles.createTypographyStyleSignature({ textAlign: 'justify' }),
    'textAlign must still update current iframe styles immediately',
  )

  assert.notStrictEqual(
    styles.createTypographyLayoutSignature({
      ...layoutBase,
      spread: 'auto',
    }),
    styles.createTypographyLayoutSignature({
      ...layoutBase,
      spread: 'none',
    }),
    'spread changes must invalidate rendered reflowable views',
  )
}

function testZoomBodyStylesSkipNonNumericValues() {
  assert.strictEqual(
    typeof styles.createZoomBodyStyles,
    'function',
    'Expected zoom body styles to be built by a testable helper',
  )

  const result = styles.createZoomBodyStyles(
    {
      width: '',
      height: 'auto',
      columnWidth: '640px',
      columnGap: '32px',
      paddingTop: 'not-a-number',
      paddingBottom: '20px',
      paddingLeft: undefined,
      paddingRight: '0px',
    },
    2,
  )

  assert.deepStrictEqual(result, {
    transformOrigin: 'top left',
    transform: 'scale(2)',
    columnWidth: '320px',
    columnGap: '16px',
    paddingBottom: '10px',
    paddingRight: '0px',
  })
  assert.ok(
    !Object.values(result).some((value) => String(value).includes('NaN')),
    'zoom styles must never emit NaNpx',
  )
}

function testZoomBodyStylesCanUseCurrentLayout() {
  assert.strictEqual(
    typeof styles.createZoomLayoutBodyStyleSource,
    'function',
    'Expected zoom body styles to be buildable from the current layout',
  )

  const source = styles.createZoomLayoutBodyStyleSource(
    {
      name: 'reflowable',
      width: 1000,
      height: 800,
      columnWidth: 460,
      gap: 40,
    },
    'horizontal',
  )
  const result = styles.createZoomBodyStyles(source, 2)

  assert.deepStrictEqual(result, {
    transformOrigin: 'top left',
    transform: 'scale(2)',
    width: '500px',
    height: '400px',
    columnWidth: '230px',
    columnGap: '20px',
    paddingTop: '5px',
    paddingBottom: '5px',
    paddingLeft: '10px',
    paddingRight: '10px',
  })
}

function testDefinitionsAreNormalizedConsistently() {
  assert.strictEqual(
    typeof annotation.normalizeDefinition,
    'function',
    'Expected shared definition normalization',
  )
  assert.strictEqual(
    typeof annotation.compareDefinition,
    'function',
    'Expected shared definition comparison',
  )

  assert.strictEqual(
    annotation.normalizeDefinition('  Café\n\tAU   Lait  '),
    'Café AU Lait',
  )
  assert.strictEqual(
    annotation.compareDefinition(' café au lait ', 'CAFÉ\nAU\tLAIT'),
    true,
  )
}

function testAnnotationSpineDoesNotRequireNavItem() {
  assert.strictEqual(
    typeof annotation.createAnnotationSpine,
    'function',
    'Expected annotation spine creation to be independent of navitem',
  )

  assert.deepStrictEqual(
    annotation.createAnnotationSpine({
      index: 3,
      href: 'Text/chapter-3.xhtml',
      navitem: { label: 'Chapter 3' },
    }),
    {
      index: 3,
      href: 'Text/chapter-3.xhtml',
      title: 'Chapter 3',
    },
  )

  assert.deepStrictEqual(
    annotation.createAnnotationSpine({
      index: 4,
      href: 'Text/chapter-4.xhtml',
    }),
    {
      index: 4,
      href: 'Text/chapter-4.xhtml',
    },
  )
}

testTextAlignIsNonPaginationStyle()
testZoomBodyStylesSkipNonNumericValues()
testZoomBodyStylesCanUseCurrentLayout()
testDefinitionsAreNormalizedConsistently()
testAnnotationSpineDoesNotRequireNavItem()
console.log('reader optimization tests passed')
