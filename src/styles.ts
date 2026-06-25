import { CSSProperties } from 'react'

import { Contents } from '@flow/epubjs'

import {
  type BodyTextDetectionCache,
  bodyTextCandidateSelector,
  bodyTextSelector,
  ensureBodyTextMarkers,
  notePopoverClass,
} from './bodyText'
import { Settings } from './state'
import { keys } from './utils'

export { getBodyTypographyBaseline, notePopoverClass } from './bodyText'
export type { BodyTextDetectionCache, BodyTypographyBaseline } from './bodyText'

export const activeClass = 'bg-[var(--flow-accent)]'

const readerLinkSelector = [
  'body > a:any-link',
  `body > :not(.${notePopoverClass}) a:any-link`,
].join(',\n')

const notePopoverListSelector = [
  `.${notePopoverClass} ol`,
  `.${notePopoverClass} ul`,
  `.${notePopoverClass} li`,
].join(',\n')

const endnoteContentBlockTags = [
  'aside',
  'section',
  'div',
  'ol',
  'ul',
  'li',
  'p',
]

const endnoteContentAttributes = [
  '[role="doc-footnote"]',
  '[role="doc-footnotes"]',
  '[role="doc-endnote"]',
  '[role="doc-endnotes"]',
  '[epub\\:type*="footnote"]',
  '[epub\\:type*="footnotes"]',
  '[epub\\:type*="endnote"]',
  '[epub\\:type*="endnotes"]',
  '[epub\\:type*="rearnote"]',
  '[epub\\:type*="rearnotes"]',
  '[type*="footnote"]',
  '[type*="footnotes"]',
  '[type*="endnote"]',
  '[type*="endnotes"]',
  '[type*="rearnote"]',
  '[type*="rearnotes"]',
  '[class*="footnote" i]',
  '[class*="endnote" i]',
  '[class*="rearnote" i]',
  '[id*="footnote" i]',
  '[id*="endnote" i]',
  '[id*="rearnote" i]',
]

const endnoteContentBlockSelectors = endnoteContentBlockTags.flatMap((tag) =>
  endnoteContentAttributes.map((attribute) => `${tag}${attribute}`),
)

const hiddenEndnoteSelector = [
  ...endnoteContentBlockSelectors.map((selector) => `body > ${selector}`),
  ...endnoteContentBlockSelectors.map(
    (selector) => `body > :not(.${notePopoverClass}) ${selector}`,
  ),
].join(',\n')

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
  [notePopoverListSelector]: {
    'list-style-type': 'none !important',
  },
  [`.${notePopoverClass} li::marker`]: {
    content: '"" !important',
  },
}

const camelToSnake = (str: string) =>
  str.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)

function mapToCss(o: CSSProperties) {
  return keys(o)
    .filter((k) => o[k] !== undefined)
    .map((k) => `${camelToSnake(k)}: ${o[k]} !important;`)
    .join('\n')
}

enum Style {
  Custom = 'custom',
}

export function createTypographyLayoutSignature(settings: Settings) {
  return [
    settings.fontFamily,
    settings.fontSize,
    settings.fontWeight,
    settings.lineHeight,
    settings.textIndent,
    settings.hideEndnotes,
    settings.zoom,
  ]
    .map((value) => value ?? '')
    .join('|')
}

export function updateCustomStyle(
  contents: Contents | undefined,
  settings: Settings | undefined,
  bodyTextCache?: BodyTextDetectionCache,
) {
  if (!contents || !settings) return

  const { zoom } = settings
  const bodyTypography = pickBodyTypography(settings)
  const hasBodyTypography = keys(bodyTypography).length > 0
  let css = ' '

  if (hasBodyTypography) {
    ensureBodyTextMarkers(contents, bodyTextCache)
    css += `${bodyTextSelector} {
      ${mapToCss(bodyTypography)}
    }`
  }

  if (settings.hideEndnotes) {
    css += `${hiddenEndnoteSelector} {
      display: none !important;
    }`
  }

  if (zoom) {
    const body = contents.content as HTMLBodyElement
    const scale = (p: keyof CSSStyleDeclaration) => ({
      [p]: `${parseInt(body.style[p] as string) / zoom}px`,
    })
    css += `body {
      ${mapToCss({
        transformOrigin: 'top left',
        transform: `scale(${zoom})`,
        ...scale('width'),
        ...scale('height'),
        ...scale('columnWidth'),
        ...scale('columnGap'),
        ...scale('paddingTop'),
        ...scale('paddingBottom'),
        ...scale('paddingLeft'),
        ...scale('paddingRight'),
      })}
    }`
  }

  const applied = contents.addStylesheetCss(css, Style.Custom)
  logStyleDiagnostics(contents, settings, {
    applied,
    bodyTypography,
    candidateCount: contents.document.querySelectorAll(
      bodyTextCandidateSelector,
    ).length,
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
    textIndent:
      settings.textIndent === undefined
        ? undefined
        : `${settings.textIndent}em`,
    textAlign:
      settings.textAlign === 'default' ? undefined : settings.textAlign,
  })
}

function removeDefaultCssValues<T extends CSSProperties>(styles: T) {
  return Object.fromEntries(
    Object.entries(styles).filter(([, value]) => {
      return value !== undefined && value !== null && value !== ''
    }),
  ) as T
}

export function lock(l: number, r: number, unit = 'px') {
  const minw = 400
  const maxw = 2560

  return `calc(${l}${unit} + ${r - l} * (100vw - ${minw}px) / ${maxw - minw})`
}
