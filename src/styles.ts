import type { CSSProperties } from 'react'

import type { Contents } from '@flow/epubjs'

import {
  type BodyTextDetectionCache,
  bodyTextCandidateSelector,
  bodyTextFontSelector,
  bodyTextInlineFollowFontAttribute,
  bodyTextInlineFollowWeightAttribute,
  bodyTextInlineFontSizeRatioAttribute,
  bodyTextSelector,
  createHiddenNoteContentSelector,
  ensureBodyTextMarkers,
  notePopoverClass,
  noteTextSelector,
} from './bodyText'
import type { Settings } from './state'
import { keys } from './utils'

export type { BodyTextDetectionCache, BodyTypographyBaseline } from './bodyText'
export { getBodyTypographyBaseline, notePopoverClass } from './bodyText'

export const activeClass = 'bg-(--flow-accent)'

const readerLinkSelector = ['body > a:any-link', `body > :not(.${notePopoverClass}) a:any-link`].join(',\n')

const notePopoverListSelector = [`.${notePopoverClass} ol`, `.${notePopoverClass} ul`, `.${notePopoverClass} li`].join(
  ',\n',
)

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

const camelToSnake = (str: string) => str.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)

function mapToCss(o: CSSProperties) {
  return keys(o)
    .filter((k) => o[k] !== undefined)
    .map((k) => `${camelToSnake(k)}: ${o[k]} !important;`)
    .join('\n')
}

export function createBodyTextInlineTypographyCss(document: Document, typography: CSSProperties) {
  let css = ''
  const fontSize =
    typeof typography.fontSize === 'string' ? Number.parseFloat(typography.fontSize) : typography.fontSize

  if (typeof fontSize === 'number' && Number.isFinite(fontSize)) {
    const ratios = new Map<string, number>()
    document.querySelectorAll<HTMLElement>(`[${bodyTextInlineFontSizeRatioAttribute}]`).forEach((el) => {
      const value = el.getAttribute(bodyTextInlineFontSizeRatioAttribute)
      const ratio = value === null ? Number.NaN : Number.parseFloat(value)
      if (value !== null && Number.isFinite(ratio) && ratio > 0) ratios.set(value, ratio)
    })

    ratios.forEach((ratio, value) => {
      css += `${bodyTextSelector} [${bodyTextInlineFontSizeRatioAttribute}="${value}"] {
        font-size: ${formatCssPixel(fontSize * ratio)} !important;
      }`
    })
  }

  if (typography.fontWeight !== undefined) {
    css += `${bodyTextSelector} [${bodyTextInlineFollowWeightAttribute}="true"] {
      ${mapToCss({ fontWeight: typography.fontWeight })}
    }`
  }

  if (typography.fontFamily) {
    css += `${bodyTextFontSelector} [${bodyTextInlineFollowFontAttribute}="true"] {
      ${mapToCss({ fontFamily: typography.fontFamily })}
    }`
  }

  return css
}

function formatCssPixel(value: number) {
  return `${Math.round(value * 10000) / 10000}px`
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

const zoomBodyProperties = [
  'width',
  'height',
  'columnWidth',
  'columnHeight',
  'columnGap',
  'rowGap',
  'paddingTop',
  'paddingBottom',
  'paddingLeft',
  'paddingRight',
] as const

type ZoomBodyProperty = (typeof zoomBodyProperties)[number]
type ZoomBodyStyleSource = Partial<Record<ZoomBodyProperty, unknown>>
type ZoomDecorativeBackgroundStyleSource = Partial<
  Record<
    | 'backgroundImage'
    | 'backgroundPosition'
    | 'backgroundPositionX'
    | 'backgroundPositionY'
    | 'backgroundRepeat'
    | 'backgroundSize',
    unknown
  >
>
type ZoomLayoutStyleSource = {
  width?: unknown
  height?: unknown
  columnWidth?: unknown
  gap?: unknown
  name?: unknown
}

type LayoutViewStyleSource = {
  axis?: string
  layout?: ZoomLayoutStyleSource
  writingMode?: string
}

const zoomConstrainedMediaSelector = ['html body img', 'html body svg', 'html body video', 'html body canvas'].join(
  ',\n',
)

const zoomIntrinsicMediaSelector = ['html body img:not(:is(sup, sub) img)', 'html body video', 'html body canvas'].join(
  ',\n',
)

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

export function createZoomBodyStyles(source: ZoomBodyStyleSource, zoom: number, writingMode?: string) {
  const styles: CSSProperties & { columnHeight?: string } = {
    transformOrigin: writingMode === 'vertical-rl' ? 'top right' : 'top left',
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

export function createZoomMediaMaxInlineSize(source: ZoomBodyStyleSource, zoom: number, writingMode?: string) {
  if (!Number.isFinite(zoom) || zoom <= 0) return

  const columnWidth = readCssPixelValue(source.columnWidth)
  if (columnWidth === undefined) return

  const vertical = writingMode === 'vertical-rl'
  const startPadding = readCssPixelValue(vertical ? source.paddingTop : source.paddingLeft)
  const endPadding = readCssPixelValue(vertical ? source.paddingBottom : source.paddingRight)
  const contentWidth = columnWidth - (startPadding ?? 0) - (endPadding ?? 0)
  if (!Number.isFinite(contentWidth) || contentWidth <= 0) return

  return contentWidth / zoom
}

export function createZoomMediaCss(source: ZoomBodyStyleSource, zoom: number, writingMode?: string) {
  const maxInlineSize = createZoomMediaMaxInlineSize(source, zoom, writingMode)
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

function readCssTextValue(value: unknown) {
  return typeof value === 'string' ? value.trim() : undefined
}

function isNoRepeatBackground(source: ZoomDecorativeBackgroundStyleSource) {
  const repeat = readCssTextValue(source.backgroundRepeat)?.toLowerCase()
  if (repeat === 'no-repeat' || repeat === 'no-repeat no-repeat') return true
  return false
}

function isBackgroundPositionToken(token: string) {
  if (['top', 'right', 'bottom', 'left', 'center'].includes(token)) return true
  return /^-?\d+(?:\.\d+)?(px|%|em|rem|vw|vh|vmin|vmax)$/.test(token)
}

function isExplicitDecorativeBackgroundPosition(source: ZoomDecorativeBackgroundStyleSource) {
  const position = readCssTextValue(source.backgroundPosition)?.toLowerCase()
  if (position) {
    if (position.includes(',')) return false

    const tokens = position.split(/\s+/)
    return tokens.length >= 1 && tokens.length <= 4 && tokens.every(isBackgroundPositionToken)
  }

  const positionX = readCssTextValue(source.backgroundPositionX)?.toLowerCase()
  const positionY = readCssTextValue(source.backgroundPositionY)?.toLowerCase()

  return !!positionX && !!positionY && isBackgroundPositionToken(positionX) && isBackgroundPositionToken(positionY)
}

function isSimpleDecorativeBackgroundSize(value: string) {
  if (value.includes(',')) return

  const tokens = value.trim().split(/\s+/)
  if (tokens.length < 1 || tokens.length > 2) return

  let hasNumericSize = false
  const valid = tokens.every((token) => {
    const normalized = token.toLowerCase()
    if (normalized === 'auto') return true

    hasNumericSize = /^(\d+(?:\.\d+)?)(px|%|em|rem|vw|vh|vmin|vmax)$/.test(normalized)
    return hasNumericSize
  })

  return valid && hasNumericSize
}

export function createZoomDecorativeBackgroundStyles(source: ZoomDecorativeBackgroundStyleSource, zoom: number) {
  if (!Number.isFinite(zoom) || zoom <= 0 || zoom === 1) return {}

  const backgroundImage = readCssTextValue(source.backgroundImage)
  const backgroundSize = readCssTextValue(source.backgroundSize)
  if (
    !backgroundImage ||
    backgroundImage === 'none' ||
    !backgroundSize ||
    !isSimpleDecorativeBackgroundSize(backgroundSize)
  ) {
    return {}
  }

  // Body zoom changes the layout box that positioned backgrounds use as their
  // anchor. Pin no-repeat decorations with resolved explicit positioning to
  // the iframe viewport without touching repeated page textures.
  if (!isNoRepeatBackground(source) || !isExplicitDecorativeBackgroundPosition(source)) {
    return {}
  }

  return {
    backgroundAttachment: 'fixed',
  } satisfies CSSProperties
}

function cssPixelValue(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? `${value}px` : undefined
}

export function createZoomLayoutBodyStyleSource(
  layout: ZoomLayoutStyleSource | undefined,
  axis?: string,
  writingMode?: string,
): ZoomBodyStyleSource {
  if (layout?.name !== 'reflowable') return {}

  const gap = typeof layout.gap === 'number' && Number.isFinite(layout.gap) ? layout.gap : undefined
  const horizontal = axis !== 'vertical'
  const verticalRtl = writingMode === 'vertical-rl'

  if (verticalRtl) {
    const width = typeof layout.width === 'number' && Number.isFinite(layout.width) ? layout.width : undefined
    const height = typeof layout.height === 'number' && Number.isFinite(layout.height) ? layout.height : undefined
    const columnWidth =
      typeof layout.columnWidth === 'number' && Number.isFinite(layout.columnWidth) ? layout.columnWidth : undefined
    const rowHeight =
      width !== undefined && columnWidth !== undefined && gap !== undefined && width <= columnWidth + gap
        ? Math.max(columnWidth - gap, 1)
        : columnWidth

    return {
      width: cssPixelValue(layout.width),
      height: cssPixelValue(layout.height),
      columnWidth: cssPixelValue(height === undefined ? undefined : Math.max(height - 20, 1)),
      columnHeight: cssPixelValue(rowHeight),
      columnGap: '0px',
      rowGap: cssPixelValue(gap),
      paddingTop: '10px',
      paddingBottom: '10px',
      paddingLeft: cssPixelValue((gap ?? 0) / 2),
      paddingRight: cssPixelValue((gap ?? 0) / 2),
    }
  }

  return {
    width: cssPixelValue(layout.width),
    height: cssPixelValue(layout.height),
    columnWidth: cssPixelValue(layout.columnWidth),
    columnGap: cssPixelValue(gap),
    paddingTop: cssPixelValue(horizontal ? 10 : gap === undefined ? 10 : gap / 2),
    paddingBottom: cssPixelValue(horizontal ? 10 : gap === undefined ? 10 : gap / 2),
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
    columnHeight: layoutStyles.columnHeight ?? bodyStyle.getPropertyValue('column-height'),
    columnGap: layoutStyles.columnGap ?? bodyStyle.columnGap,
    rowGap: layoutStyles.rowGap ?? bodyStyle.rowGap,
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
  layoutView?: LayoutViewStyleSource,
  layoutName?: string,
) {
  if (!contents || !settings) return

  const { zoom } = settings
  const bodyTypography = pickBodyTypography(settings)
  const hasBodyTypography = keys(bodyTypography).length > 0
  const needsTextMarkers = hasBodyTypography || settings.hideEndnotes
  let css = ' '
  const writingMode = resolveWritingMode(contents, layoutView, layoutName)

  css += createVerticalWritingCss(writingMode, settings.textIndent)

  if (needsTextMarkers) {
    ensureBodyTextMarkers(contents, bodyTextCache)
  }

  if (hasBodyTypography) {
    const { fontFamily, ...bodyTypographyWithoutFontFamily } = bodyTypography
    if (keys(bodyTypographyWithoutFontFamily).length) {
      css += `${bodyTextSelector} {
        ${mapToCss(bodyTypographyWithoutFontFamily)}
      }`
    }

    if (fontFamily) {
      css += `${bodyTextFontSelector} {
        ${mapToCss({ fontFamily })}
      }`
    }

    css += createBodyTextInlineTypographyCss(contents.document, bodyTypography)

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
    const layoutStyles = createZoomLayoutBodyStyleSource(layoutView?.layout, layoutView?.axis, writingMode)
    css += createZoomMediaCss(layoutStyles, zoom, writingMode)
    const computedBodyStyle = contents.window.getComputedStyle(body)
    const backgroundStyleSource: ZoomDecorativeBackgroundStyleSource = {
      backgroundImage: computedBodyStyle.backgroundImage,
      backgroundPosition: computedBodyStyle.backgroundPosition,
      backgroundPositionX: computedBodyStyle.backgroundPositionX,
      backgroundPositionY: computedBodyStyle.backgroundPositionY,
      backgroundRepeat: computedBodyStyle.backgroundRepeat,
      backgroundSize: computedBodyStyle.backgroundSize,
    }
    css += `body {
      ${mapToCss({
        ...createZoomBodyStyles(createZoomBodyStyleSource(body.style, layoutStyles), zoom, writingMode),
        ...createZoomDecorativeBackgroundStyles(backgroundStyleSource, zoom),
      })}
    }`
  }

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

export function resolveWritingMode(
  contents: Pick<Contents, 'writingMode'>,
  layoutView?: LayoutViewStyleSource,
  layoutName?: string,
) {
  const viewLayoutName = layoutView?.layout?.name
  const resolvedLayoutName = typeof viewLayoutName === 'string' ? viewLayoutName : layoutName

  return layoutView?.writingMode ?? contents.writingMode(undefined, resolvedLayoutName)
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
