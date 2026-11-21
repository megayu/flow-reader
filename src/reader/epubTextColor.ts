import type { Contents } from '@flow/epub-engine'

const LIGHT_READER_TEXT = '#3f484a'
const DARK_READER_TEXT = '#bfc8ca'
const DEFAULT_TEXT_PROPERTY = '--flow-epub-default-text'
const EPUB_BLACK_TEXT_PROPERTY = '--flow-epub-black-text'

const blackTextColor = `var(${EPUB_BLACK_TEXT_PROPERTY}, #000)`
const blackFontClass = 'flow-epub-black-text'
const opaqueBlack = /^(?:black|#(?:000|000f|000000|000000ff)|rgba?\(0,\s*0,\s*0(?:,\s*1)?\))$/i
const legacyBlack = /^(?:black|#000|#?000000)$/i

function adaptColorDeclaration(style: CSSStyleDeclaration) {
  if (opaqueBlack.test(style.getPropertyValue('color').trim())) {
    style.setProperty('color', blackTextColor, style.getPropertyPriority('color'))
  }
}

function adaptStylesheet(sheet: CSSStyleSheet, visited: Set<CSSStyleSheet>) {
  if (visited.has(sheet)) return
  visited.add(sheet)
  let rules: CSSRuleList
  try {
    rules = sheet.cssRules
  } catch {
    // Browsers restrict access to stylesheets from other origins.
    return
  }
  adaptRules(rules, visited)
}

function adaptRules(rules: CSSRuleList, visited: Set<CSSStyleSheet>) {
  for (const rule of rules) {
    if ('style' in rule) adaptColorDeclaration((rule as CSSStyleRule).style)
    if ('cssRules' in rule) adaptRules((rule as CSSGroupingRule).cssRules, visited)
    if ('styleSheet' in rule) {
      const imported = (rule as CSSImportRule).styleSheet
      if (imported) adaptStylesheet(imported, visited)
    }
  }
}

function adaptEpubBlackText(document: Document) {
  const visited = new Set<CSSStyleSheet>()
  for (const sheet of document.styleSheets) adaptStylesheet(sheet, visited)
  for (const element of document.querySelectorAll<HTMLElement>('[style]')) {
    adaptColorDeclaration(element.style)
  }

  for (const font of document.querySelectorAll('font[color]')) {
    const color = font.getAttribute('color')?.trim() ?? ''
    if (legacyBlack.test(color)) {
      font.classList.add(blackFontClass)
    }
  }
}

export function prepareEpubTextColors({ document }: Contents, reflowable: boolean) {
  if (!document.head) return
  if (reflowable) adaptEpubBlackText(document)

  // The first layer lets publisher declarations on html or body win.
  const style = document.createElementNS('http://www.w3.org/1999/xhtml', 'style')
  style.textContent = `@layer {
    :root { color: var(${DEFAULT_TEXT_PROPERTY}, ${LIGHT_READER_TEXT}); }
    ${reflowable ? `:where(font.${blackFontClass}) { color: ${blackTextColor}; }` : ''}
  }`
  document.head.prepend(style)
}

export function applyEpubTextPalette({ document }: Contents, dark: boolean) {
  const style = document.documentElement.style
  style.setProperty(DEFAULT_TEXT_PROPERTY, dark ? DARK_READER_TEXT : LIGHT_READER_TEXT)
  style.setProperty(EPUB_BLACK_TEXT_PROPERTY, dark ? DARK_READER_TEXT : '#000')
}
