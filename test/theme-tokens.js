const assert = require('assert')
const fs = require('fs')
const path = require('path')

const ts = require('typescript')

const sourcePath = path.join(__dirname, '..', 'src', 'styles', 'theme.ts')
const source = fs.readFileSync(sourcePath, 'utf8')
const { outputText } = ts.transpileModule(source, {
  compilerOptions: {
    esModuleInterop: true,
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2019,
  },
  fileName: sourcePath,
})

const moduleShim = { exports: {} }

new Function(
  'exports',
  'require',
  'module',
  '__filename',
  '__dirname',
  outputText,
)(moduleShim.exports, require, moduleShim, sourcePath, path.dirname(sourcePath))

const {
  createBackgroundPalette,
  createThemeCss,
  isDarkPaletteColor,
  normalizePaletteColor,
} = moduleShim.exports

function cssColorFromArgb(argb) {
  const r = (argb >> 16) & 255
  const g = (argb >> 8) & 255
  const b = argb & 255
  return `rgb(${r} ${g} ${b})`
}

function argb(r, g, b) {
  return ((255 << 24) | (r << 16) | (g << 8) | b) >>> 0
}

function createPalette(seed) {
  return {
    tone(tone) {
      return argb(seed + tone, seed + tone + 1, seed + tone + 2)
    },
  }
}

function createScheme(values) {
  return {
    toJSON() {
      return values
    },
  }
}

function createFixtureTheme() {
  const lightScheme = {
    background: argb(255, 251, 255),
    error: argb(179, 38, 30),
    errorContainer: argb(249, 222, 220),
    inverseOnSurface: argb(244, 239, 244),
    inversePrimary: argb(208, 188, 255),
    inverseSurface: argb(49, 48, 51),
    onBackground: argb(29, 27, 32),
    onError: argb(255, 255, 255),
    onErrorContainer: argb(65, 14, 11),
    onPrimary: argb(255, 255, 255),
    onPrimaryContainer: argb(33, 0, 93),
    onSecondary: argb(255, 255, 255),
    onSecondaryContainer: argb(29, 25, 43),
    onSurface: argb(29, 27, 32),
    onSurfaceVariant: argb(73, 69, 79),
    onTertiary: argb(255, 255, 255),
    onTertiaryContainer: argb(49, 17, 29),
    outline: argb(121, 116, 126),
    outlineVariant: argb(202, 196, 208),
    primary: argb(103, 80, 164),
    primaryContainer: argb(234, 221, 255),
    secondary: argb(98, 91, 113),
    secondaryContainer: argb(232, 222, 248),
    shadow: argb(0, 0, 0),
    surface: argb(255, 251, 255),
    surfaceVariant: argb(231, 224, 236),
    tertiary: argb(125, 82, 96),
    tertiaryContainer: argb(255, 216, 228),
  }
  const darkScheme = {
    background: argb(28, 27, 31),
    error: argb(242, 184, 181),
    errorContainer: argb(140, 29, 24),
    inverseOnSurface: argb(49, 48, 51),
    inversePrimary: argb(103, 80, 164),
    inverseSurface: argb(230, 225, 229),
    onBackground: argb(230, 225, 229),
    onError: argb(96, 20, 16),
    onErrorContainer: argb(249, 222, 220),
    onPrimary: argb(55, 30, 115),
    onPrimaryContainer: argb(234, 221, 255),
    onSecondary: argb(51, 45, 65),
    onSecondaryContainer: argb(232, 222, 248),
    onSurface: argb(230, 225, 229),
    onSurfaceVariant: argb(202, 196, 208),
    onTertiary: argb(73, 37, 50),
    onTertiaryContainer: argb(255, 216, 228),
    outline: argb(147, 143, 153),
    outlineVariant: argb(73, 69, 79),
    primary: argb(208, 188, 255),
    primaryContainer: argb(79, 55, 139),
    secondary: argb(204, 194, 220),
    secondaryContainer: argb(74, 68, 88),
    shadow: argb(0, 0, 0),
    surface: argb(28, 27, 31),
    surfaceVariant: argb(73, 69, 79),
    tertiary: argb(239, 184, 200),
    tertiaryContainer: argb(99, 59, 72),
  }

  return {
    palettes: {
      primary: createPalette(1),
      neutralVariant: createPalette(10),
    },
    schemes: {
      light: createScheme(lightScheme),
      dark: createScheme(darkScheme),
    },
  }
}

function extractBlock(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = css.match(new RegExp(`${escaped} \\{([^}]*)\\}`))
  assert.ok(match, `Expected CSS block for ${selector}`)
  return match[1]
}

function declarationValue(block, property) {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = block.match(new RegExp(`${escaped}:([^;]+);`))
  assert.ok(match, `Expected declaration for ${property}`)
  return match[1]
}

function testThemeCssExposesOnlyShadcnTokens() {
  const theme = createFixtureTheme()
  const css = createThemeCss(theme)
  const light = extractBlock(css, ':root, .light')
  const dark = extractBlock(css, ':root.dark')
  const lightScheme = theme.schemes.light.toJSON()
  const darkScheme = theme.schemes.dark.toJSON()

  assert.ok(!css.includes('--md-ref-palette-'))
  assert.ok(!css.includes('--md-sys-color-'))

  assert.strictEqual(declarationValue(light, 'color-scheme'), 'light')
  assert.strictEqual(
    declarationValue(light, '--background'),
    cssColorFromArgb(lightScheme.background),
  )
  assert.strictEqual(
    declarationValue(light, '--foreground'),
    cssColorFromArgb(lightScheme.onBackground),
  )
  assert.strictEqual(
    declarationValue(light, '--primary'),
    cssColorFromArgb(lightScheme.primary),
  )
  assert.strictEqual(
    declarationValue(light, '--primary-foreground'),
    cssColorFromArgb(lightScheme.onPrimary),
  )
  assert.strictEqual(
    declarationValue(light, '--border'),
    cssColorFromArgb(lightScheme.outlineVariant),
  )
  assert.strictEqual(
    declarationValue(light, '--ring'),
    cssColorFromArgb(lightScheme.primary),
  )

  assert.strictEqual(declarationValue(dark, 'color-scheme'), 'dark')
  assert.strictEqual(
    declarationValue(dark, '--background'),
    cssColorFromArgb(darkScheme.background),
  )
  assert.strictEqual(
    declarationValue(dark, '--foreground'),
    cssColorFromArgb(darkScheme.onBackground),
  )
  assert.strictEqual(
    declarationValue(dark, '--primary'),
    cssColorFromArgb(darkScheme.primary),
  )
  assert.strictEqual(
    declarationValue(dark, '--primary-foreground'),
    cssColorFromArgb(darkScheme.onPrimary),
  )
}

function testBackgroundPaletteNormalizesPresetAndCustomColors() {
  assert.strictEqual(normalizePaletteColor('abc'), '#AABBCC')
  assert.strictEqual(normalizePaletteColor('#e1eed8'), '#E1EED8')
  assert.strictEqual(normalizePaletteColor('not-a-color'), undefined)

  assert.deepStrictEqual(createBackgroundPalette('#E1EED8'), {
    content: '#E1EED8',
    sidebar: '#D4E0CB',
    activity: '#C6D1BE',
    active: '#B9C3B1',
  })
  assert.strictEqual(isDarkPaletteColor('#24292E'), true)
  assert.strictEqual(isDarkPaletteColor('#FFFFFF'), false)
}

testThemeCssExposesOnlyShadcnTokens()
testBackgroundPaletteNormalizesPresetAndCustomColors()
console.log('theme-token tests passed')
