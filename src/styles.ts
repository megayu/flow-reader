import { CSSProperties } from 'react'

import { Contents } from '@flow/epubjs'

import {
  type BodyTextDetectionCache,
  bodyTextCandidateSelector,
  bodyTextSelector,
  bodyTextTypographySelector,
  createHiddenNoteContentSelector,
  ensureBodyTextMarkers,
  notePopoverClass,
  noteTextSelector,
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
    settings.spread,
  ]
    .map((value) => value ?? '')
    .join('|')
}

export function createTypographyStyleSignature(settings: Settings) {
  return [settings.textAlign].map((value) => value ?? '').join('|')
}

const zoomBodyProperties = [
  'width',
  'height',
  'columnWidth',
  'columnGap',
  'paddingTop',
  'paddingBottom',
  'paddingLeft',
  'paddingRight',
] as const

type ZoomBodyProperty = (typeof zoomBodyProperties)[number]
type ZoomBodyStyleSource = Partial<Record<ZoomBodyProperty, unknown>>
type ZoomLayoutStyleSource = {
  width?: unknown
  height?: unknown
  columnWidth?: unknown
  gap?: unknown
  name?: unknown
}

const zoomConstrainedMediaSelector = [
  'html body img',
  'html body svg',
  'html body video',
  'html body canvas',
].join(',\n')

const zoomIntrinsicMediaSelector = [
  'html body img',
  'html body video',
  'html body canvas',
].join(',\n')

function readCssPixelValue(value: unknown) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined
  }

  if (typeof value !== 'string') return

  const match = value.trim().match(/^(-?\d+(?:\.\d+)?)px$/)
  if (!match) return

  const numeric = Number(match[1])
  return Number.isFinite(numeric) ? numeric : undefined
}

export function createZoomBodyStyles(
  source: ZoomBodyStyleSource,
  zoom: number,
) {
  const styles: CSSProperties = {
    transformOrigin: 'top left',
    transform: `scale(${zoom})`,
  }

  if (!Number.isFinite(zoom) || zoom === 0) return styles

  zoomBodyProperties.forEach((property) => {
    const value = readCssPixelValue(source[property])
    if (value === undefined) return

    styles[property] = `${value / zoom}px`
  })

  return styles
}

function formatCssPixelValue(value: number) {
  return `${Math.round(value * 1000) / 1000}px`
}

export function createZoomMediaMaxInlineSize(
  source: ZoomBodyStyleSource,
  zoom: number,
) {
  if (!Number.isFinite(zoom) || zoom <= 0) return

  const columnWidth = readCssPixelValue(source.columnWidth)
  if (columnWidth === undefined) return

  const paddingLeft = readCssPixelValue(source.paddingLeft) ?? 0
  const paddingRight = readCssPixelValue(source.paddingRight) ?? 0
  const contentWidth = columnWidth - paddingLeft - paddingRight
  if (!Number.isFinite(contentWidth) || contentWidth <= 0) return

  return contentWidth / zoom
}

export function createZoomMediaCss(source: ZoomBodyStyleSource, zoom: number) {
  const maxInlineSize = createZoomMediaMaxInlineSize(source, zoom)
  if (maxInlineSize === undefined) return ''

  const maxInlineSizeCss = formatCssPixelValue(maxInlineSize)

  return `${zoomConstrainedMediaSelector} {
    max-width: ${maxInlineSizeCss} !important;
    max-inline-size: ${maxInlineSizeCss} !important;
    box-sizing: border-box !important;
    object-fit: contain !important;
  }
  ${zoomIntrinsicMediaSelector} {
    height: auto !important;
  }`
}

function cssPixelValue(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value)
    ? `${value}px`
    : undefined
}

export function createZoomLayoutBodyStyleSource(
  layout: ZoomLayoutStyleSource | undefined,
  axis?: string,
): ZoomBodyStyleSource {
  if (!layout || layout.name !== 'reflowable') return {}

  const gap =
    typeof layout.gap === 'number' && Number.isFinite(layout.gap)
      ? layout.gap
      : undefined
  const horizontal = axis !== 'vertical'

  return {
    width: cssPixelValue(layout.width),
    height: cssPixelValue(layout.height),
    columnWidth: cssPixelValue(layout.columnWidth),
    columnGap: cssPixelValue(gap),
    paddingTop: cssPixelValue(
      horizontal ? 10 : gap === undefined ? 10 : gap / 2,
    ),
    paddingBottom: cssPixelValue(
      horizontal ? 10 : gap === undefined ? 10 : gap / 2,
    ),
    paddingLeft: cssPixelValue(horizontal ? (gap ?? 0) / 2 : 10),
    paddingRight: cssPixelValue(horizontal ? (gap ?? 0) / 2 : 10),
  }
}

function createZoomBodyStyleSource(
  bodyStyle: CSSStyleDeclaration,
  layoutStyles: ZoomBodyStyleSource,
): ZoomBodyStyleSource {
  return {
    width: layoutStyles.width ?? bodyStyle.width,
    height: layoutStyles.height ?? bodyStyle.height,
    columnWidth: layoutStyles.columnWidth ?? bodyStyle.columnWidth,
    columnGap: layoutStyles.columnGap ?? bodyStyle.columnGap,
    paddingTop: layoutStyles.paddingTop ?? bodyStyle.paddingTop,
    paddingBottom: layoutStyles.paddingBottom ?? bodyStyle.paddingBottom,
    paddingLeft: layoutStyles.paddingLeft ?? bodyStyle.paddingLeft,
    paddingRight: layoutStyles.paddingRight ?? bodyStyle.paddingRight,
  }
}

export function updateCustomStyle(
  contents: Contents | undefined,
  settings: Settings | undefined,
  bodyTextCache?: BodyTextDetectionCache,
  layoutView?: { axis?: string; layout?: ZoomLayoutStyleSource },
) {
  if (!contents || !settings) return

  const { zoom } = settings
  const bodyTypography = pickBodyTypography(settings)
  const hasBodyTypography = keys(bodyTypography).length > 0
  const needsTextMarkers = hasBodyTypography || settings.hideEndnotes
  let css = ' '

  if (needsTextMarkers) {
    ensureBodyTextMarkers(contents, bodyTextCache)
  }

  if (hasBodyTypography) {
    css += `${bodyTextTypographySelector} {
      ${mapToCss(bodyTypography)}
    }`

    if (settings.fontSize) {
      css += `${noteTextSelector}, ${noteTextSelector} * {
        font-size: ${settings.fontSize} !important;
      }`
    }
  }

  if (settings.hideEndnotes) {
    css += `${hiddenEndnoteSelector} {
      display: none !important;
    }`
  }

  if (zoom) {
    const body = contents.content as HTMLBodyElement
    const layoutStyles = createZoomLayoutBodyStyleSource(
      layoutView?.layout,
      layoutView?.axis,
    )
    css += createZoomMediaCss(layoutStyles, zoom)
    css += `body {
      ${mapToCss(
        createZoomBodyStyles(
          createZoomBodyStyleSource(body.style, layoutStyles),
          zoom,
        ),
      )}
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
