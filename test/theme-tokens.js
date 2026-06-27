const assert = require('assert')
const fs = require('fs')
const Module = require('module')
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

const compiledModule = new Module(sourcePath, module)
compiledModule.filename = sourcePath
compiledModule.paths = Module._nodeModulePaths(path.dirname(sourcePath))
compiledModule._compile(outputText, sourcePath)

const {
  backgroundPresets,
  createFlowThemeCss,
  createFlowThemeTokens,
  createBackgroundPalette,
  isDarkPaletteColor,
  normalizeThemeConfiguration,
  normalizePaletteColor,
} = compiledModule.exports

const flowTokenNames = [
  '--flow-bg-app',
  '--flow-bg-activity',
  '--flow-bg-sidebar',
  '--flow-bg-content',
  '--flow-bg-tabbar',
  '--flow-bg-tab-active',
  '--flow-bg-panel',
  '--flow-bg-control',
  '--flow-bg-control-hover',
  '--flow-bg-control-active',
  '--flow-sidebar-item-bg',
  '--flow-sidebar-item-bg-hover',
  '--flow-sidebar-item-bg-active',
  '--flow-sidebar-item-border',
  '--flow-text',
  '--flow-text-muted',
  '--flow-border',
  '--flow-border-strong',
  '--flow-tab-border',
  '--flow-tab-border-strong',
  '--flow-accent',
  '--flow-accent-text',
  '--flow-accent-bg',
  '--flow-accent-bg-hover',
  '--flow-accent-border',
  '--flow-focus-ring',
  '--flow-danger',
  '--flow-danger-bg',
  '--flow-danger-bg-hover',
  '--flow-danger-text',
]

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

function hexToRgb(color) {
  const hex = color.replace('#', '')
  assert.match(hex, /^[0-9A-Fa-f]{6}$/)
  return [
    parseInt(hex.slice(0, 2), 16),
    parseInt(hex.slice(2, 4), 16),
    parseInt(hex.slice(4, 6), 16),
  ]
}

function relativeLuminance(color) {
  return hexToRgb(color)
    .map((channel) => {
      const normalized = channel / 255
      return normalized <= 0.03928
        ? normalized / 12.92
        : ((normalized + 0.055) / 1.055) ** 2.4
    })
    .reduce(
      (sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index],
      0,
    )
}

function contrastRatio(a, b) {
  const lighter = Math.max(relativeLuminance(a), relativeLuminance(b))
  const darker = Math.min(relativeLuminance(a), relativeLuminance(b))
  return (lighter + 0.05) / (darker + 0.05)
}

function testFlowThemeTokensCoverPresetsAndContrast() {
  assert.strictEqual(backgroundPresets.length, 10)
  assert.deepStrictEqual(
    backgroundPresets.map((preset) => preset.id),
    [
      'clean',
      'neutral',
      'paper',
      'sepia',
      'rose',
      'sage',
      'mist',
      'dusk',
      'charcoal',
      'black',
    ],
  )

  for (const preset of backgroundPresets) {
    const tokens = createFlowThemeTokens({
      backgroundPreset: preset.id,
      accent: preset.defaultAccent,
      scheme: preset.mode,
      contrast: 'standard',
    })

    for (const token of flowTokenNames) {
      assert.ok(tokens[token], `Expected ${preset.id} to define ${token}`)
    }

    assert.ok(
      contrastRatio(tokens['--flow-text'], tokens['--flow-bg-content']) >= 4.5,
      `Expected readable content text for ${preset.id}`,
    )
    assert.ok(
      contrastRatio(tokens['--flow-text-muted'], tokens['--flow-bg-content']) >=
        3,
      `Expected readable muted text for ${preset.id}`,
    )
    assert.ok(
      contrastRatio(tokens['--flow-accent-text'], tokens['--flow-accent']) >=
        4.5,
      `Expected readable accent text for ${preset.id}`,
    )
    assert.ok(
      contrastRatio(tokens['--flow-danger-text'], tokens['--flow-danger-bg']) >=
        4.5,
      `Expected readable danger text for ${preset.id}`,
    )
  }
}

function testTabTokensKeepVisibleLayeringForDarkAndCustomThemes() {
  const cases = [
    {
      name: 'black preset',
      config: {
        backgroundPreset: 'black',
        accent: '#60A5FA',
        scheme: 'dark',
        contrast: 'standard',
      },
    },
    {
      name: 'charcoal preset',
      config: {
        backgroundPreset: 'charcoal',
        accent: '#38BDF8',
        scheme: 'dark',
        contrast: 'standard',
      },
    },
    {
      name: 'low contrast custom dark',
      config: {
        backgroundPreset: 'custom',
        customBackground: '#101010',
        accent: '#60A5FA',
        scheme: 'dark',
        contrast: 'standard',
      },
    },
    {
      name: 'neutral preset',
      config: {
        backgroundPreset: 'neutral',
        accent: '#2F6F8F',
        scheme: 'light',
        contrast: 'standard',
      },
    },
  ]

  for (const { name, config } of cases) {
    const tokens = createFlowThemeTokens(config)

    assert.ok(
      contrastRatio(tokens['--flow-tab-border'], tokens['--flow-bg-tabbar']) >=
        1.35,
      `Expected visible tab border on tabbar for ${name}`,
    )
    assert.ok(
      contrastRatio(
        tokens['--flow-tab-border'],
        tokens['--flow-bg-tab-active'],
      ) >= 1.25,
      `Expected visible tab border on active tab for ${name}`,
    )
    assert.ok(
      contrastRatio(
        tokens['--flow-bg-tabbar'],
        tokens['--flow-bg-tab-active'],
      ) >= 1.08,
      `Expected active tab to separate from tabbar for ${name}`,
    )
    assert.notStrictEqual(
      tokens['--flow-bg-tabbar'],
      tokens['--flow-bg-content'],
      `Expected tabbar to differ from content for ${name}`,
    )
  }
}

function testSidebarItemTokensStayVisibleOnSidebarSurface() {
  const cases = [
    {
      name: 'neutral preset',
      config: {
        backgroundPreset: 'neutral',
        accent: '#2F6F8F',
        scheme: 'light',
        contrast: 'standard',
      },
    },
    {
      name: 'mist preset',
      config: {
        backgroundPreset: 'mist',
        accent: '#2563EB',
        scheme: 'light',
        contrast: 'standard',
      },
    },
    {
      name: 'dusk preset',
      config: {
        backgroundPreset: 'dusk',
        accent: '#7DD3FC',
        scheme: 'dark',
        contrast: 'standard',
      },
    },
    {
      name: 'black preset',
      config: {
        backgroundPreset: 'black',
        accent: '#60A5FA',
        scheme: 'dark',
        contrast: 'standard',
      },
    },
    {
      name: 'low contrast custom light',
      config: {
        backgroundPreset: 'custom',
        customBackground: '#D8D8D5',
        accent: '#2F6F8F',
        scheme: 'light',
        contrast: 'standard',
      },
    },
  ]

  for (const { name, config } of cases) {
    const tokens = createFlowThemeTokens(config)
    const sidebar = tokens['--flow-bg-sidebar']
    const item = tokens['--flow-sidebar-item-bg']
    const hover = tokens['--flow-sidebar-item-bg-hover']
    const active = tokens['--flow-sidebar-item-bg-active']
    const border = tokens['--flow-sidebar-item-border']
    const itemContrast = contrastRatio(item, sidebar)
    const hoverContrast = contrastRatio(hover, sidebar)
    const activeContrast = contrastRatio(active, sidebar)

    assert.ok(
      itemContrast >= 1.12,
      `Expected visible sidebar item background for ${name}`,
    )
    assert.ok(
      hoverContrast >= Math.max(1.2, itemContrast + 0.03),
      `Expected sidebar hover to separate from item background for ${name}`,
    )
    assert.ok(
      activeContrast >= Math.max(1.3, hoverContrast + 0.03),
      `Expected sidebar active to separate from hover background for ${name}`,
    )
    assert.ok(
      contrastRatio(border, sidebar) >= 1.14,
      `Expected sidebar item border to separate from sidebar for ${name}`,
    )
    assert.ok(
      contrastRatio(border, item) >= 1.14,
      `Expected sidebar item border to separate from item for ${name}`,
    )
  }
}

function testCustomThemeTokensKeepAccentAndDangerSeparate() {
  const blueTokens = createFlowThemeTokens({
    backgroundPreset: 'custom',
    customBackground: '#EAF1E7',
    accent: '#2563EB',
    scheme: 'light',
    contrast: 'standard',
  })
  const greenTokens = createFlowThemeTokens({
    backgroundPreset: 'custom',
    customBackground: '#EAF1E7',
    accent: '#16A34A',
    scheme: 'light',
    contrast: 'standard',
  })
  const darkTokens = createFlowThemeTokens({
    backgroundPreset: 'custom',
    customBackground: '#20242A',
    accent: '#38BDF8',
    scheme: 'dark',
    contrast: 'standard',
  })

  assert.notStrictEqual(
    blueTokens['--flow-accent'],
    greenTokens['--flow-accent'],
  )
  assert.strictEqual(blueTokens['--flow-danger'], greenTokens['--flow-danger'])
  assert.strictEqual(
    blueTokens['--flow-danger-bg'],
    greenTokens['--flow-danger-bg'],
  )
  assert.ok(
    contrastRatio(blueTokens['--flow-text'], blueTokens['--flow-bg-content']) >=
      4.5,
  )
  assert.ok(
    contrastRatio(darkTokens['--flow-text'], darkTokens['--flow-bg-content']) >=
      4.5,
  )
  assert.ok(
    contrastRatio(
      darkTokens['--flow-accent-text'],
      darkTokens['--flow-accent'],
    ) >= 4.5,
  )
}

function testFlowThemeCssOutputsFlowTokensAndCompatibilityBridge() {
  const css = createFlowThemeCss({
    backgroundPreset: 'sage',
    accent: '#2F7D68',
    scheme: 'light',
    contrast: 'standard',
  })
  const light = extractBlock(css, ':root, .light')
  const dark = extractBlock(css, ':root.dark')

  for (const token of flowTokenNames) {
    assert.ok(
      declarationValue(light, token).startsWith('#'),
      `Expected light CSS to expose ${token}`,
    )
    assert.ok(
      declarationValue(dark, token).startsWith('#'),
      `Expected dark CSS to expose ${token}`,
    )
  }

  assert.strictEqual(declarationValue(light, '--primary'), 'var(--flow-accent)')
  assert.strictEqual(
    declarationValue(light, '--primary-foreground'),
    'var(--flow-accent-text)',
  )
  assert.strictEqual(
    declarationValue(light, '--secondary'),
    'var(--flow-bg-control)',
  )
  assert.strictEqual(
    declarationValue(light, '--muted'),
    'var(--flow-bg-control-hover)',
  )
  assert.strictEqual(
    declarationValue(light, '--ring'),
    'var(--flow-focus-ring)',
  )
  assert.strictEqual(
    declarationValue(light, '--destructive'),
    'var(--flow-danger)',
  )
  assert.strictEqual(
    declarationValue(light, '--flow-bg-tabbar').startsWith('#'),
    true,
  )
  assert.strictEqual(
    declarationValue(light, '--flow-tab-border').startsWith('#'),
    true,
  )
}

function testThemeConfigurationMigratesLegacySettings() {
  assert.deepStrictEqual(
    normalizeThemeConfiguration({
      source: '#16a34a',
      background: -3,
      scheme: 'system',
    }),
    {
      accent: '#16A34A',
      backgroundPreset: 'sage',
      scheme: 'system',
      contrast: 'standard',
    },
  )

  assert.deepStrictEqual(
    normalizeThemeConfiguration({
      source: 'not-a-color',
      background: 0,
      customBackground: '#abc',
      scheme: 'dark',
      contrast: 'high',
    }),
    {
      accent: '#0EA5E9',
      backgroundPreset: 'custom',
      customBackground: '#AABBCC',
      scheme: 'dark',
      contrast: 'high',
    },
  )
}

function testKnownColorPatchesAreNotUsedForCoreChrome() {
  const files = [
    'src/components/Layout.tsx',
    'src/components/Row.tsx',
    'src/components/Tab.tsx',
    'src/components/Reader.tsx',
    'src/components/TextImportDialog.tsx',
    'src/components/viewlets/TocView.tsx',
    'src/components/ui/button.tsx',
    'src/pages/index.tsx',
  ]
  const disallowedPatterns = [
    /bg-primary\/1[05]/,
    /hover:bg-primary\/1[05]/,
    /bg-muted\/50/,
    /color-mix\(in_oklch,var\(--primary\)/,
  ]

  for (const file of files) {
    const fullPath = path.join(__dirname, '..', file)
    const text = fs.readFileSync(fullPath, 'utf8')

    for (const pattern of disallowedPatterns) {
      assert.ok(
        !pattern.test(text),
        `Expected ${file} not to use patch color ${pattern}`,
      )
    }
  }
}

function testReaderTabsUseDedicatedTabTokens() {
  const tabPath = path.join(__dirname, '..', 'src/components/Tab.tsx')
  const text = fs.readFileSync(tabPath, 'utf8')

  assert.ok(
    text.includes('--flow-bg-tabbar'),
    'Expected tab list to use the dedicated tabbar token',
  )
  assert.ok(
    text.includes('--flow-bg-tab-active'),
    'Expected selected tab to use the dedicated active tab token',
  )
  assert.ok(
    text.includes('--flow-tab-border'),
    'Expected tabs to use the dedicated tab border token',
  )
  assert.ok(
    text.includes('shadow-[5px_5px_0_5px_var(--flow-bg-tab-active)]'),
    'Expected selected tabs to keep reverse-rounded cutouts with the active tab token',
  )
  assert.ok(
    !text.includes('shadow-[5px_5px_0_5px_var(--flow-bg-content)]'),
    'Expected selected tabs not to rely on content-background shadow cutouts',
  )
  assert.ok(
    !text.includes(
      'border-b border-[var(--flow-tab-border)] bg-[var(--flow-bg-tabbar)]',
    ),
    'Expected the tabbar not to use a full-width dividing line',
  )
}

function testTreeRowsUseDepthForIndentation() {
  const rowPath = path.join(__dirname, '..', 'src/components/Row.tsx')
  const text = fs.readFileSync(rowPath, 'utf8')

  assert.ok(
    text.includes('const indent = Math.max(0, depth - 1) * 20'),
    'Expected tree rows to derive indentation from depth',
  )
  assert.ok(
    text.includes('paddingLeft: indent'),
    'Expected tree rows to apply depth indentation',
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

testFlowThemeTokensCoverPresetsAndContrast()
testTabTokensKeepVisibleLayeringForDarkAndCustomThemes()
testSidebarItemTokensStayVisibleOnSidebarSurface()
testCustomThemeTokensKeepAccentAndDangerSeparate()
testFlowThemeCssOutputsFlowTokensAndCompatibilityBridge()
testThemeConfigurationMigratesLegacySettings()
testKnownColorPatchesAreNotUsedForCoreChrome()
testReaderTabsUseDedicatedTabTokens()
testTreeRowsUseDepthForIndentation()
testBackgroundPaletteNormalizesPresetAndCustomColors()
console.log('theme-token tests passed')
