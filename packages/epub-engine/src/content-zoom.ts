import type Layout from './layout'
import type Contents from './contents'

type StyleSource = Record<string, string | number | undefined>
type ZoomLayout = Pick<
  Layout,
  'name' | 'gap' | 'width' | 'height' | 'columnWidth'
>

/** Physical pagination and media sizing for a zoomed iframe body. */
function mapToCss(styles: StyleSource) {
  return Object.keys(styles)
    .filter((key) => styles[key] !== undefined)
    .map(
      (key) =>
        `${key.replace(/[A-Z]/g, (letter) => '-' + letter.toLowerCase())}: ${styles[key]} !important;`,
    )
    .join('\n')
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
]

const zoomConstrainedMediaSelector = [
  'html body img',
  'html body svg',
  'html body video',
  'html body canvas',
].join(',\n')

const zoomIntrinsicMediaSelector = [
  'html body img:not(:is(sup, sub) img)',
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
  source: StyleSource,
  zoom: number,
  writingMode?: string,
) {
  const styles: StyleSource = {
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

export function createZoomMediaMaxInlineSize(
  source: StyleSource,
  zoom: number,
  writingMode?: string,
) {
  if (!Number.isFinite(zoom) || zoom <= 0) return

  const columnWidth = readCssPixelValue(source.columnWidth)
  if (columnWidth === undefined) return

  const vertical = writingMode === 'vertical-rl'
  const startPadding = readCssPixelValue(
    vertical ? source.paddingTop : source.paddingLeft,
  )
  const endPadding = readCssPixelValue(
    vertical ? source.paddingBottom : source.paddingRight,
  )
  const contentWidth = columnWidth - (startPadding ?? 0) - (endPadding ?? 0)
  if (!Number.isFinite(contentWidth) || contentWidth <= 0) return

  return contentWidth / zoom
}

export function createZoomMediaCss(
  source: StyleSource,
  zoom: number,
  writingMode?: string,
) {
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

function isNoRepeatBackground(source: StyleSource) {
  const repeat = readCssTextValue(source.backgroundRepeat)?.toLowerCase()
  if (repeat === 'no-repeat' || repeat === 'no-repeat no-repeat') return true
  return false
}

function isBackgroundPositionToken(token: string) {
  if (['top', 'right', 'bottom', 'left', 'center'].includes(token)) return true
  return /^-?\d+(?:\.\d+)?(px|%|em|rem|vw|vh|vmin|vmax)$/.test(token)
}

function isExplicitDecorativeBackgroundPosition(source: StyleSource) {
  const position = readCssTextValue(source.backgroundPosition)?.toLowerCase()
  if (position) {
    if (position.includes(',')) return false

    const tokens = position.split(/\s+/)
    return (
      tokens.length >= 1 &&
      tokens.length <= 4 &&
      tokens.every(isBackgroundPositionToken)
    )
  }

  const positionX = readCssTextValue(source.backgroundPositionX)?.toLowerCase()
  const positionY = readCssTextValue(source.backgroundPositionY)?.toLowerCase()

  return (
    !!positionX &&
    !!positionY &&
    isBackgroundPositionToken(positionX) &&
    isBackgroundPositionToken(positionY)
  )
}

function isSimpleDecorativeBackgroundSize(value: string) {
  if (value.includes(',')) return

  const tokens = value.trim().split(/\s+/)
  if (tokens.length < 1 || tokens.length > 2) return

  let hasNumericSize = false
  const valid = tokens.every((token) => {
    const normalized = token.toLowerCase()
    if (normalized === 'auto') return true

    hasNumericSize = /^(\d+(?:\.\d+)?)(px|%|em|rem|vw|vh|vmin|vmax)$/.test(
      normalized,
    )
    return hasNumericSize
  })

  return valid && hasNumericSize
}

export function createZoomDecorativeBackgroundStyles(
  source: StyleSource,
  zoom: number,
) {
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
  if (
    !isNoRepeatBackground(source) ||
    !isExplicitDecorativeBackgroundPosition(source)
  ) {
    return {}
  }

  return {
    backgroundAttachment: 'fixed',
  }
}

function cssPixelValue(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value)
    ? `${value}px`
    : undefined
}

export function createZoomLayoutBodyStyleSource(
  layout: ZoomLayout | undefined,
  axis: string,
  writingMode?: string,
): StyleSource {
  if (layout?.name !== 'reflowable') return {}

  const gap =
    typeof layout.gap === 'number' && Number.isFinite(layout.gap)
      ? layout.gap
      : undefined
  const horizontal = axis !== 'vertical'
  const verticalRtl = writingMode === 'vertical-rl'

  if (verticalRtl) {
    const width =
      typeof layout.width === 'number' && Number.isFinite(layout.width)
        ? layout.width
        : undefined
    const height =
      typeof layout.height === 'number' && Number.isFinite(layout.height)
        ? layout.height
        : undefined
    const columnWidth =
      typeof layout.columnWidth === 'number' &&
      Number.isFinite(layout.columnWidth)
        ? layout.columnWidth
        : undefined
    const rowHeight =
      width !== undefined &&
      columnWidth !== undefined &&
      gap !== undefined &&
      width <= columnWidth + gap
        ? Math.max(columnWidth - gap, 1)
        : columnWidth

    return {
      width: cssPixelValue(layout.width),
      height: cssPixelValue(layout.height),
      columnWidth: cssPixelValue(
        height === undefined ? undefined : Math.max(height - 20, 1),
      ),
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
  layoutStyles: StyleSource,
) {
  return {
    width: layoutStyles.width ?? bodyStyle.width,
    height: layoutStyles.height ?? bodyStyle.height,
    columnWidth: layoutStyles.columnWidth ?? bodyStyle.columnWidth,
    columnHeight:
      layoutStyles.columnHeight ?? bodyStyle.getPropertyValue('column-height'),
    columnGap: layoutStyles.columnGap ?? bodyStyle.columnGap,
    rowGap: layoutStyles.rowGap ?? bodyStyle.rowGap,
    paddingTop: layoutStyles.paddingTop ?? bodyStyle.paddingTop,
    paddingBottom: layoutStyles.paddingBottom ?? bodyStyle.paddingBottom,
    paddingLeft: layoutStyles.paddingLeft ?? bodyStyle.paddingLeft,
    paddingRight: layoutStyles.paddingRight ?? bodyStyle.paddingRight,
  }
}

export function createContentZoomCss(
  contents: Contents,
  layout: ZoomLayout,
  axis: string,
  zoom: number | undefined,
  writingMode: string,
) {
  if (!zoom) return ''
  let css = ''

  const body = contents.content
  const layoutStyles = createZoomLayoutBodyStyleSource(
    layout,
    axis,
    writingMode,
  )
  const frameCss = contents.window.CSS
  const supportsBlockDirectionColumns =
    writingMode !== 'vertical-rl' ||
    (frameCss.supports('column-height', '1px') &&
      frameCss.supports('column-wrap', 'wrap'))
  const zoomBodyStyles = createZoomBodyStyles(
    createZoomBodyStyleSource(body.style, layoutStyles),
    zoom,
    writingMode,
  )
  const legacyWebKitColumnStyles: StyleSource = {}
  if (!supportsBlockDirectionColumns) {
    const physicalPageContentWidth = readCssPixelValue(
      layoutStyles.columnHeight,
    )
    const physicalColumnGap = readCssPixelValue(layoutStyles.rowGap)
    if (
      physicalPageContentWidth !== undefined &&
      physicalColumnGap !== undefined
    ) {
      legacyWebKitColumnStyles.width = `${(physicalPageContentWidth + physicalColumnGap) / zoom}px`
    }
    if (physicalColumnGap !== undefined)
      legacyWebKitColumnStyles.WebkitColumnGap = `${physicalColumnGap / zoom}px`
  }
  css += createZoomMediaCss(layoutStyles, zoom, writingMode)
  const computedBodyStyle = contents.window.getComputedStyle(body)
  const backgroundStyleSource = {
    backgroundImage: computedBodyStyle.backgroundImage,
    backgroundPosition: computedBodyStyle.backgroundPosition,
    backgroundPositionX: computedBodyStyle.backgroundPositionX,
    backgroundPositionY: computedBodyStyle.backgroundPositionY,
    backgroundRepeat: computedBodyStyle.backgroundRepeat,
    backgroundSize: computedBodyStyle.backgroundSize,
  }
  css += `body {
      ${mapToCss({
        ...zoomBodyStyles,
        ...legacyWebKitColumnStyles,
        ...createZoomDecorativeBackgroundStyles(backgroundStyleSource, zoom),
      })}
    }`

  return css
}
