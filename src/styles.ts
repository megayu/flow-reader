import type { CSSProperties } from 'react'

import type { Contents } from '@flow/epub-engine'
import type { ReaderView } from '@flow/epub-engine/rendition'

import {
  type BodyTextDetectionCache,
  bodyTextCandidateSelector,
  bodyTextFontFallbackAttribute,
  bodyTextFontSelector,
  bodyTextFontSizeRatioAttribute,
  bodyTextFontWeightOffsetAttribute,
  bodyTextInlineFollowFontAttribute,
  bodyTextInlineSecondaryFontAttribute,
  bodyTextPreserveFontAttribute,
  bodyTextSelector,
  createHiddenNoteContentSelector,
  ensureBodyTextMarkers,
  notePopoverClass,
} from './bodyText'
import type { Settings } from './state'
import { keys } from './utils'

export type { BodyTextDetectionCache, BodyTypographyBaseline } from './bodyText'
export { getBodyTypographyBaseline, notePopoverClass } from './bodyText'

export const activeClass = 'bg-(--flow-accent)'

const readerLinkSelector = `body a:any-link, .${notePopoverClass} a`

const hiddenEndnoteSelector = createHiddenNoteContentSelector(notePopoverClass)

export const defaultStyle = {
  html: {
    padding: '0 !important',
  },
  body: {
    background: 'transparent',
  },
  [readerLinkSelector]: {
    color: '#3b82f6 !important',
    'text-decoration': 'none !important',
  },
  '::selection': {
    'background-color': 'rgba(3, 102, 214, 0.2)',
  },
}

const camelToSnake = (str: string) => str.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)

function mapToCss(o: CSSProperties) {
  return keys(o)
    .filter((k) => o[k] !== undefined)
    .map((k) => `${camelToSnake(k)}: ${o[k]} !important;`)
    .join('\n')
}

export function createBodyTextTypographyCss(
  document: Document,
  typography: CSSProperties,
  secondaryFontFamily?: string,
) {
  let css = ''
  const fontSize =
    typeof typography.fontSize === 'string' ? Number.parseFloat(typography.fontSize) : typography.fontSize

  if (typeof fontSize === 'number' && Number.isFinite(fontSize)) {
    const ratios = new Map<string, number>()
    document.querySelectorAll<HTMLElement>(`[${bodyTextFontSizeRatioAttribute}]`).forEach((el) => {
      const value = el.getAttribute(bodyTextFontSizeRatioAttribute)
      const ratio = value === null ? Number.NaN : Number.parseFloat(value)
      if (value !== null && Number.isFinite(ratio) && ratio >= 0) ratios.set(value, ratio)
    })

    ratios.forEach((ratio, value) => {
      css += `[${bodyTextFontSizeRatioAttribute}="${value}"] {
        font-size: ${formatCssPixel(fontSize * ratio)} !important;
      }`
    })
  }

  const fontWeight = Number(typography.fontWeight)
  if (Number.isFinite(fontWeight)) {
    const offsets = new Map<string, number>()
    document.querySelectorAll<HTMLElement>(`[${bodyTextFontWeightOffsetAttribute}]`).forEach((el) => {
      const value = el.getAttribute(bodyTextFontWeightOffsetAttribute)
      const offset = value === null ? Number.NaN : Number(value)
      if (value !== null && Number.isFinite(offset)) offsets.set(value, offset)
    })
    offsets.forEach((offset, value) => {
      css += `[${bodyTextFontWeightOffsetAttribute}="${value}"] {
        ${mapToCss({ fontWeight: Math.min(1000, Math.max(1, fontWeight + offset)) })}
      }`
    })
  }

  if (typography.fontFamily) {
    css += `${bodyTextFontSelector}, [${bodyTextInlineFollowFontAttribute}="true"] {
      ${mapToCss({ fontFamily: `${typography.fontFamily}, sans-serif` })}
    }`
    css += createFontFallbackOverrides(
      [bodyTextFontSelector, `[${bodyTextInlineFollowFontAttribute}="true"]`],
      typography.fontFamily,
    )
  }

  if (secondaryFontFamily) {
    css += `${bodyTextSelector}[${bodyTextPreserveFontAttribute}="true"], [${bodyTextInlineSecondaryFontAttribute}="true"] {
      ${mapToCss({ fontFamily: `${secondaryFontFamily}, sans-serif` })}
    }`
    css += createFontFallbackOverrides(
      [
        `${bodyTextSelector}[${bodyTextPreserveFontAttribute}="true"]`,
        `[${bodyTextInlineSecondaryFontAttribute}="true"]`,
      ],
      secondaryFontFamily,
    )
  }

  return css
}

function createFontFallbackOverrides(selectors: string[], fontFamily: string) {
  return (['serif', 'monospace'] as const)
    .map((fallback) => {
      const selector = selectors.map((value) => `${value}[${bodyTextFontFallbackAttribute}="${fallback}"]`).join(', ')
      return `${selector} {
        ${mapToCss({ fontFamily: `${fontFamily}, ${fallback}` })}
      }`
    })
    .join('')
}

function formatCssPixel(value: number) {
  return `${Math.round(value * 10000) / 10000}px`
}

export function createTypographyLayoutSignature(settings: Settings) {
  return [
    settings.fontFamily,
    settings.secondaryFontFamily,
    settings.fontSize,
    settings.fontWeight,
    settings.lineHeight,
    settings.textIndent,
    settings.hideEndnotes,
    settings.zoom,
    settings.spread,
  ]
    .map((value) => value ?? '')
    .join('|')
}

export function createTypographyStyleSignature(settings: Settings) {
  return [settings.textAlign].map((value) => value ?? '').join('|')
}

export function createVerticalWritingCss(writingMode: string | undefined, textIndent?: number) {
  if (writingMode !== 'vertical-rl') return ''

  const indentVariable = textIndent === undefined ? '' : `:root { --flow-text-indent: ${textIndent}em; }`

  return `${indentVariable}
  html, body {
    writing-mode: vertical-rl !important;
    text-orientation: mixed !important;
  }
  html:root body * {
    text-orientation: mixed !important;
  }
  ${bodyTextSelector} {
    text-indent: var(--flow-text-indent) !important;
  }`
}

export function updateCustomStyle(
  contents: Contents | undefined,
  settings: Settings | undefined,
  bodyTextCache?: BodyTextDetectionCache,
  view?: ReaderView,
) {
  if (!contents || !settings) return

  const bodyTypography = pickBodyTypography(settings)
  const hasBodyTypography = keys(bodyTypography).length > 0 || !!settings.secondaryFontFamily
  const needsTextMarkers = hasBodyTypography || settings.hideEndnotes
  let css = ' '
  const writingMode = view?.writingMode ?? contents.writingMode()

  css += createVerticalWritingCss(writingMode, settings.textIndent)

  if (needsTextMarkers) {
    ensureBodyTextMarkers(contents, bodyTextCache)
  }

  if (hasBodyTypography) {
    const {
      fontFamily: _fontFamily,
      fontSize: _fontSize,
      fontWeight: _fontWeight,
      ...bodyParagraphTypography
    } = bodyTypography
    if (keys(bodyParagraphTypography).length) {
      css += `${bodyTextSelector} {
        ${mapToCss(bodyParagraphTypography)}
      }`
    }

    css += createBodyTextTypographyCss(contents.document, bodyTypography, settings.secondaryFontFamily)
  }

  if (settings.hideEndnotes) {
    css += `${hiddenEndnoteSelector} {
      display: none !important;
    }`
  }

  css += view?.createZoomCss(settings.zoom) ?? ''

  const applied = contents.addStylesheetCss(css, 'custom')
  logStyleDiagnostics(contents, settings, {
    applied,
    bodyTypography,
    candidateCount: contents.document.querySelectorAll(bodyTextCandidateSelector).length,
    markedCount: contents.document.querySelectorAll(bodyTextSelector).length,
    cssLength: css.length,
  })

  return applied
}

function logStyleDiagnostics(
  contents: Contents,
  settings: Settings,
  diagnostics: {
    applied: unknown
    bodyTypography: CSSProperties
    candidateCount: number
    markedCount: number
    cssLength: number
  },
) {
  if (!shouldLogStyleDiagnostics(contents)) return

  console.info('[flow-style]', {
    sectionIndex: (contents as any).sectionIndex,
    settings: {
      fontFamily: settings.fontFamily,
      secondaryFontFamily: settings.secondaryFontFamily,
      fontSize: settings.fontSize,
      fontWeight: settings.fontWeight,
      lineHeight: settings.lineHeight,
      textIndent: settings.textIndent,
      textAlign: settings.textAlign,
      hideEndnotes: settings.hideEndnotes,
      zoom: settings.zoom,
    },
    ...diagnostics,
  })
}

function shouldLogStyleDiagnostics(contents: Contents) {
  try {
    return (
      globalThis.localStorage?.getItem('flow.debug.style') === '1' ||
      contents.window.parent?.localStorage?.getItem('flow.debug.style') === '1'
    )
  } catch {
    return false
  }
}

function pickBodyTypography(settings: Settings) {
  return removeDefaultCssValues({
    fontFamily: settings.fontFamily,
    fontSize: settings.fontSize,
    fontWeight: settings.fontWeight,
    lineHeight: settings.lineHeight,
    textIndent: settings.textIndent === undefined ? undefined : `${settings.textIndent}em`,
    textAlign: settings.textAlign === 'default' ? undefined : settings.textAlign,
  })
}

function removeDefaultCssValues<T extends CSSProperties>(styles: T) {
  return Object.fromEntries(
    Object.entries(styles).filter(([, value]) => {
      return value !== undefined && value !== null && value !== ''
    }),
  ) as T
}
