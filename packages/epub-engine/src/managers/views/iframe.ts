import type Section from '../../section'
import type { SectionRequest } from '../../section'
import type Layout from '../../layout'
import type { Deferred, LegacyWindow } from '../../utils/core'
import type {
  AnnotationData,
  AnnotationCallback,
  AnnotationStyles,
} from '../../annotations'
import type { NumericSvg } from '../helpers/annotation-pane'

export interface ViewSettings {
  writingMode?: string
  ignoreClass?: string
  axis?: string
  direction?: string
  width?: number
  height?: number
  layout?: Layout
  globalLayoutProperties?: object
  method?: string
  flow?: string
  forceRight?: boolean
  forceLeft?: boolean
  allowScriptedContent?: boolean
  allowPopups?: boolean
  spreadSlot?: 'left' | 'right'
  layoutStyleSignature?: string
  beforeLayout?: (contents?: Contents, view?: IframeView) => void
}
export type ViewResize = {
  width: number
  height: number
  widthDelta: number
  heightDelta: number
}
type ViewEvents = {
  axis: [string]
  writingMode: [string]
  loaderror: [unknown]
  rendered: [Section]
  resized: [ViewResize]
  displayed: [IframeView]
  shown: [IframeView]
  hidden: [IframeView]
  wheel: [WheelEvent]
  markClicked: [string, AnnotationData]
}
type StoredMark = {
  mark: Highlight
  element: NumericSvg | null
  listeners: (AnnotationCallback | undefined)[]
}
type Rect = { left: number; right: number; top: number; bottom: number }
type ContentRangeSummary = {
  bounds: Rect
  crossesPageBoundary: boolean
  compactInFirstPage: boolean
  compactNearPageBoundary: boolean
  startsInsideSecondPage: boolean
}

import EventEmitter from '../../utils/event-emitter'
import { createContentZoomCss } from '../../content-zoom'
import { WavyUnderline, VerticalUnderline } from '../helpers/annotation-marks'
import { Pane, Highlight, Underline } from '../helpers/annotation-pane'

import Contents from '../../contents'
import EpubCFI from '../../epubcfi'
import { EVENTS } from '../../utils/constants'
import {
  extend,
  borders,
  uuid,
  isNumber,
  bounds,
  defer,
  createBlobUrl,
  revokeBlobUrl,
} from '../../utils/core'

const LEADING_TITLE_IMAGE_MAX_SCAN = 10
const LEADING_TITLE_IMAGE_HEADING_SCAN = 8
const LEADING_TITLE_IMAGE_MAX_BLOCK_WIDTH = 180
const LEADING_TITLE_IMAGE_ATTRIBUTE = 'data-flow-epub-leading-title-image-clamped'
const LEADING_BLOCK_BACKGROUND_MAX_SCAN = 10

function textLength(value: string | null | undefined) {
  return value ? value.replace(/\s+/g, '').length : 0
}

function elementName(element: Element) {
  return element.localName.toUpperCase()
}

function numericCssValue(value: unknown) {
  if (!value) return undefined

  let match = String(value).match(/-?\d+(?:\.\d+)?/)
  if (!match) return undefined

  let numeric = Number(match[0])
  return Number.isFinite(numeric) ? numeric : undefined
}

function isHeadingElement(element: Element) {
  return /^H[1-6]$/.test(elementName(element))
}

function isTitleLikeElement(element: Element) {
  if (isHeadingElement(element)) return true

  let className = typeof element.className === 'string' ? element.className : ''
  return /(^|[\s_-])(chapter|heading|title)([\s_-]|$)/i.test(className)
}

function isTransparentBackgroundColor(value: string | undefined) {
  if (!value) return true

  let color = String(value).trim().toLowerCase()
  if (!color || color === 'transparent') return true

  let rgba = color.match(
    /^rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+(?:\s*,\s*([\d.]+))?\s*\)$/,
  )
  if (rgba) {
    return rgba[1] !== undefined && Number(rgba[1]) <= 0
  }

  return false
}

function hasVisibleBackground(style: CSSStyleDeclaration | null | undefined) {
  if (!style) return false

  if (style.backgroundImage && style.backgroundImage !== 'none') {
    return true
  }

  return !isTransparentBackgroundColor(style.backgroundColor)
}

function nextHeadingTextLength(element: Element) {
  let sibling = element.nextElementSibling
  let scanned = 0

  while (sibling && scanned < LEADING_TITLE_IMAGE_HEADING_SCAN) {
    if (isHeadingElement(sibling)) {
      return textLength(sibling.textContent)
    }

    let heading = sibling.querySelector('h1,h2,h3,h4,h5,h6')
    if (heading) {
      return textLength(heading.textContent)
    }

    if (textLength(sibling.textContent)) {
      scanned += 1
    }
    sibling = sibling.nextElementSibling
  }

  return 0
}

class IframeView extends EventEmitter<ViewEvents> {
  declare settings: ViewSettings
  declare id: string
  declare section: Section
  declare index: number
  declare element: HTMLDivElement
  declare added: boolean
  declare displayed: boolean
  declare rendered: boolean
  declare _loading: Deferred<Contents> | undefined
  declare fixedWidth: number
  declare fixedHeight: number
  declare epubcfi: EpubCFI
  declare layout: Layout
  declare _layoutPageWidth: number | undefined
  declare _oversizedSinglePageWrapperChecked: boolean
  declare _oversizedSinglePageWrapper: HTMLElement | undefined
  declare _oversizedSinglePageWrapperNormalized: boolean
  declare pane: Pane | undefined
  declare highlights: Record<string, StoredMark>
  declare underlines: Record<string, StoredMark>
  declare markCursorProxyDocument: Document | undefined
  declare markCursorProxyMove: ((event: MouseEvent) => void) | undefined
  declare markCursorProxyLeave: (() => void) | undefined
  declare activeMarkCursor: string | undefined
  declare annotationBatchDepth: number
  declare iframe: HTMLIFrameElement | undefined
  declare resizing: boolean | undefined
  declare _width: number
  declare _height: number
  declare elementBounds: { width: number; height: number } | undefined
  declare supportsSrcdoc: boolean | undefined
  declare sectionRender: Promise<string> | undefined
  declare _textWidth: number | undefined
  declare _contentWidth: number | undefined
  declare _contentPageCount: number | undefined
  declare _measureWidth: number | undefined
  declare _textHeight: number | undefined
  declare _contentHeight: number | undefined
  declare _needsReframe: boolean | undefined
  declare lockedWidth: number | undefined
  declare lockedHeight: number | undefined
  declare _singlePageFirstPageOffset: number | undefined
  declare _expanding: boolean | undefined
  declare prevBounds: ViewResize | undefined
  declare blobUrl: string | undefined
  declare document: Document | null | undefined
  declare window: LegacyWindow | null | undefined
  declare contents: Contents | undefined
  declare _onWheel: ((event: WheelEvent) => void) | undefined
  declare rendering: boolean | undefined
  declare axis: string
  declare writingMode: string
  declare stopExpanding: boolean | undefined
  declare destroyed: boolean | undefined

  constructor(section: Section, options?: ViewSettings) {
    super()

    this.settings = extend(
      {
        ignoreClass: '',
        axis: undefined, //options.layout && options.layout.props.flow === "scrolled" ? "vertical" : "horizontal",
        direction: undefined,
        width: 0,
        height: 0,
        layout: undefined,
        globalLayoutProperties: {},
        method: undefined,
        forceRight: false,
        allowScriptedContent: false,
        allowPopups: false,
      },
      options || {},
    )

    this.id = 'flow-epub-view-' + uuid()
    this.section = section
    this.index = section.index

    this.element = this.container(this.settings.axis)

    this.added = false
    this.displayed = false
    this.rendered = false
    this._loading = undefined

    // this.width  = this.settings.width;
    // this.height = this.settings.height;

    this.fixedWidth = 0
    this.fixedHeight = 0

    // Blank Cfi for Parsing
    this.epubcfi = new EpubCFI()

    this.layout = this.settings.layout!
    this._layoutPageWidth = this.layout && this.layout.pageWidth
    this._oversizedSinglePageWrapperChecked = false
    this._oversizedSinglePageWrapper = undefined
    this._oversizedSinglePageWrapperNormalized = false
    // Dom events to listen for
    // this.listenedEvents = ["keydown", "keyup", "keypressed", "mouseup", "mousedown", "click", "touchend", "touchstart"];

    this.pane = undefined
    this.highlights = {}
    this.underlines = {}
    this.markCursorProxyDocument = undefined
    this.markCursorProxyMove = undefined
    this.markCursorProxyLeave = undefined
    this.activeMarkCursor = undefined
    this.annotationBatchDepth = 0
  }

  container(axis?: string) {
    var element = document.createElement('div')

    element.classList.add('epub-view')

    // this.element.style.minHeight = "100px";
    element.style.height = '0px'
    element.style.width = '0px'
    element.style.overflow = 'hidden'
    element.style.position = 'relative'
    element.style.display = 'block'

    if (axis && axis == 'horizontal') {
      element.style.flex = 'none'
    } else {
      element.style.flex = 'initial'
    }

    return element
  }

  create() {
    if (this.iframe) {
      return this.iframe
    }

    if (!this.element) {
      this.element = this.container(this.settings.axis)
    }

    this.iframe = document.createElement('iframe')
    this.iframe.id = this.id
    this.iframe.scrolling = 'no' // Might need to be removed: breaks ios width calculations
    this.iframe!.style.overflow = 'hidden'
    ;(this.iframe as HTMLIFrameElement & { seamless: string }).seamless =
      'seamless'
    // Back up if seamless isn't supported
    this.iframe!.style.border = 'none'

    // WebKit blocks parent-installed event listeners in a same-origin sandbox
    // without allow-scripts (WebKit 218086). CSP still blocks book scripts by
    // default; allowScriptedContent explicitly opts out in load().
    ;(this.iframe as unknown as { sandbox: string }).sandbox =
      'allow-same-origin allow-scripts'
    if (this.settings.allowPopups) {
      ;(this.iframe as unknown as { sandbox: string }).sandbox +=
        ' allow-popups'
    }

    this.iframe.setAttribute('enable-annotation', 'true')

    this.resizing = true

    // this.iframe!.style.display = "none";
    this.element.style.visibility = 'hidden'
    this.iframe!.style.visibility = 'hidden'

    this.iframe!.style.width = '0'
    this.iframe!.style.height = '0'
    this._width = 0
    this._height = 0

    this.element.setAttribute('ref', this.index as unknown as string)

    this.added = true

    this.elementBounds = bounds(this.element)

    // if(width || height){
    //   this.resize(width, height);
    // } else if(this.width && this.height){
    //   this.resize(this.width, this.height);
    // } else {
    //   this.iframeBounds = bounds(this.iframe);
    // }

    if ('srcdoc' in this.iframe) {
      this.supportsSrcdoc = true
    } else {
      this.supportsSrcdoc = false
    }

    if (!this.settings.method) {
      this.settings.method = this.supportsSrcdoc ? 'srcdoc' : 'write'
    }

    return this.iframe
  }

  render(request?: SectionRequest, show?: boolean) {
    // view.onLayout = this.layout.format.bind(this.layout);
    this.create()

    // Fit to size of the container, apply padding
    this.size()

    if (!this.sectionRender) {
      this.sectionRender = this.section.render(request, {
        blockScripts: !this.settings.allowScriptedContent,
      })
    }

    // Render Chain
    return this.sectionRender
      .then(
        function (this: IframeView, contents: string) {
          return this.load(contents)
        }.bind(this),
      )
      .then(
        function (this: IframeView) {
          // find and report the writingMode axis
          let writingMode = this.contents!.writingMode(
            undefined,
            this.layout && this.layout.name,
          )

          // A paginated page frame always advances horizontally. Vertical
          // writing only changes flow inside that unchanged physical frame.
          let axis =
            this.settings.flow === 'scrolled'
              ? writingMode.indexOf('vertical') === 0
                ? 'horizontal'
                : 'vertical'
              : 'horizontal'

          this.setAxis(axis)
          this.emit(EVENTS.VIEWS.AXIS, axis)

          this.setWritingMode(writingMode)
          this.emit(EVENTS.VIEWS.WRITING_MODE, writingMode)

          if (typeof this.settings.beforeLayout === 'function') {
            this.settings.beforeLayout(this.contents, this)
          }

          // apply the layout function to the contents
          this.layout.format(
            this.contents!,
            this.section,
            this.axis,
            this.settings.spreadSlot,
          )
          this.fitLeadingBlockBackgroundsBeforeMeasure()
          this.fitLeadingTitleImagesBeforeMeasure()
          this.fitMediaBeforeMeasure()

          return new Promise<void>((resolve, reject) => {
            // Expand the iframe to the full size of the content
            this.expand()

            if (this.settings.forceRight) {
              this.element.style.marginLeft = this.width() + 'px'
            } else if (this.settings.forceLeft) {
              this.element.style.marginRight = this.width() + 'px'
            }
            resolve()
          })
        }.bind(this),
        function (this: IframeView, e: unknown) {
          this.emit(EVENTS.VIEWS.LOAD_ERROR, e)
          return new Promise((resolve, reject) => {
            reject(e)
          })
        }.bind(this),
      )
      .then(
        function (this: IframeView) {
          this.emit(EVENTS.VIEWS.RENDERED, this.section)
        }.bind(this),
      )
  }

  reset() {
    if (this.iframe) {
      this.iframe!.style.width = '0'
      this.iframe!.style.height = '0'
      this._width = 0
      this._height = 0
      this._textWidth = undefined
      this._contentWidth = undefined
      this._contentPageCount = undefined
      this._measureWidth = undefined
      this._textHeight = undefined
      this._contentHeight = undefined
    }
    this._needsReframe = true
  }

  // Determine locks base on settings
  size(_width?: number, _height?: number) {
    var width = _width || this.settings.width
    var height = _height || this.settings.height

    if (this.layout.name === 'pre-paginated') {
      this.lock('both', width, height)
    } else if (this.settings.axis === 'horizontal') {
      this.lock('height', width, height)
    } else {
      this.lock('width', width, height)
    }

    this.settings.width = width
    this.settings.height = height
  }

  // Lock an axis to element dimensions, taking borders into account
  lock(what: string, width?: number, height?: number) {
    var elBorders = borders(this.element)
    var iframeBorders

    if (this.iframe) {
      iframeBorders = borders(this.iframe)
    } else {
      iframeBorders = { width: 0, height: 0 }
    }

    if (what == 'width' && isNumber(width)) {
      this.lockedWidth = width! - elBorders.width - iframeBorders.width
      // this.resize(this.lockedWidth, width); //  width keeps ratio correct
    }

    if (what == 'height' && isNumber(height)) {
      this.lockedHeight = height! - elBorders.height - iframeBorders.height
      // this.resize(width, this.lockedHeight);
    }

    if (what === 'both' && isNumber(width) && isNumber(height)) {
      this.lockedWidth = width! - elBorders.width - iframeBorders.width
      this.lockedHeight = height! - elBorders.height - iframeBorders.height
      // this.resize(this.lockedWidth, this.lockedHeight);
    }

    if (this.displayed && this.iframe) {
      // this.contents!.layout();
      this.expand()
    }
  }

  eachContentRect(callback: (rect: DOMRect) => unknown) {
    let doc = this.document
    let root = this.contents && this.contents!.content

    if (!doc || !root) {
      return false
    }

    let nodeFilter = (doc.defaultView as LegacyWindow).NodeFilter
    let walker = (
      doc.createTreeWalker as (
        root: Node,
        mask: number,
        filter: NodeFilter,
        expand: boolean,
      ) => TreeWalker
    )(
      root,
      nodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          return (node as Text).data && (node as Text).data.trim().length > 0
            ? nodeFilter.FILTER_ACCEPT
            : nodeFilter.FILTER_REJECT
        },
      },
      false,
    )
    let node
    let range = doc.createRange()

    while ((node = walker.nextNode())) {
      range.selectNodeContents(node)
      let rects = range.getClientRects()

      for (let i = 0; i < rects.length; i++) {
        if (callback(rects[i]!)) {
          range.detach && range.detach()
          return true
        }
      }
    }

    range.detach && range.detach()

    let media = root.querySelectorAll('img, svg, math, video, audio, canvas')
    for (let i = 0; i < media.length; i++) {
      if (callback(media[i]!.getBoundingClientRect())) {
        return true
      }
    }

    return false
  }

  // Resize a single axis based on content dimensions
  hasContentInRange(start: number, end: number) {
    return this.eachContentRect((rect) => {
      if (
        rect.width > 0 &&
        rect.height > 0 &&
        rect.right > start + 1 &&
        rect.left < end - 1
      ) {
        return true
      }
      return false
    })
  }

  contentBounds() {
    let contentBounds: Rect | undefined
    let addRect = (rect: DOMRect) => {
      if (!rect || rect.width <= 0 || rect.height <= 0) {
        return
      }

      if (!contentBounds) {
        contentBounds = {
          left: rect.left,
          right: rect.right,
          top: rect.top,
          bottom: rect.bottom,
        }
        return
      }

      contentBounds.left = Math.min(contentBounds.left, rect.left)
      contentBounds.right = Math.max(contentBounds.right, rect.right)
      contentBounds.top = Math.min(contentBounds.top, rect.top)
      contentBounds.bottom = Math.max(contentBounds.bottom, rect.bottom)
    }

    this.eachContentRect((rect) => {
      addRect(rect)
      return false
    })

    return contentBounds
  }

  pageBoundaryThreshold(pageWidth: number) {
    return Math.min(Math.max(pageWidth * 0.02, 2), 24)
  }

  contentRangeSummary(pageWidth: number, contentWidth = pageWidth * 2) {
    let threshold = this.pageBoundaryThreshold(pageWidth)
    let compactWidthLimit = pageWidth * 0.5
    let summary: ContentRangeSummary | undefined

    let addRect = (rect: DOMRect) => {
      if (!rect || rect.width <= 0 || rect.height <= 0) {
        return
      }

      // DOM ranges use physical left-to-right coordinates. Mirror horizontal
      // RTL content so page-boundary checks follow logical reading order.
      let left =
        this.settings.direction === 'rtl'
          ? contentWidth - rect.right
          : rect.left
      let right =
        this.settings.direction === 'rtl'
          ? contentWidth - rect.left
          : rect.right

      if (!summary) {
        summary = {
          bounds: {
            left,
            right,
            top: rect.top,
            bottom: rect.bottom,
          },
          crossesPageBoundary: false,
          compactInFirstPage: false,
          compactNearPageBoundary: false,
          startsInsideSecondPage: false,
        }
      } else {
        summary.bounds.left = Math.min(summary.bounds.left, left)
        summary.bounds.right = Math.max(summary.bounds.right, right)
        summary.bounds.top = Math.min(summary.bounds.top, rect.top)
        summary.bounds.bottom = Math.max(summary.bounds.bottom, rect.bottom)
      }

      if (left < pageWidth - threshold && right > pageWidth + threshold) {
        summary.crossesPageBoundary = true
      }

      if (
        rect.width <= compactWidthLimit &&
        left < pageWidth - threshold &&
        right <= pageWidth + threshold
      ) {
        summary.compactInFirstPage = true
      }

      if (
        rect.width <= compactWidthLimit &&
        left <= pageWidth + threshold &&
        right > pageWidth + threshold
      ) {
        summary.compactNearPageBoundary = true
      }

      if (left >= pageWidth + threshold && rect.width > threshold) {
        summary.startsInsideSecondPage = true
      }
    }

    this.eachContentRect((rect) => {
      addRect(rect)
      return false
    })

    return summary
  }

  hasPageVisualBackground() {
    if (!this.contents || !this.layout || !this.layout.pageWidth) {
      return false
    }

    if (typeof this.contents.backgrounds?.findPageBackgrounds === 'function') {
      let height = this.lockedHeight || this.layout.height || 0
      let width = this.layout.columnWidth || this.layout.pageWidth
      return (
        this.contents.backgrounds.findPageBackgrounds(width, height).length > 0
      )
    }

    return false
  }

  shouldTreatTwoPageWidthAsSinglePage(width: number) {
    if (
      !this.layout ||
      !this.layout.pageWidth ||
      this.layout.name !== 'reflowable' ||
      this.settings.axis !== 'horizontal'
    ) {
      return false
    }

    let pageWidth = this.layout.pageWidth
    if (Math.max(1, Math.ceil(width / pageWidth)) !== 2) {
      return false
    }

    let summary = this.contentRangeSummary(pageWidth, width)
    if (!summary) {
      return this.hasPageVisualBackground()
    }

    if (summary.startsInsideSecondPage) {
      return false
    }

    let rect = summary.bounds
    let rectWidth = rect.right - rect.left
    if (rectWidth <= 0) {
      return false
    }

    if (rectWidth > pageWidth * 1.5) {
      return summary.compactNearPageBoundary
    }

    if (this.settings.direction === 'rtl' && summary.compactInFirstPage) {
      return true
    }

    return summary.crossesPageBoundary || summary.compactNearPageBoundary
  }

  clearSinglePageFirstPageOffset() {
    let content = this.contents && this.contents!.content

    if (!content || !this._singlePageFirstPageOffset) {
      return
    }

    content.style.removeProperty('translate')
    this._singlePageFirstPageOffset = undefined
  }

  singlePageFirstPageOffset(width: number) {
    if (
      !this.layout ||
      !this.layout.pageWidth ||
      this.layout.name !== 'reflowable' ||
      this.settings.axis !== 'horizontal' ||
      this.settings.direction === 'rtl' ||
      this._contentPageCount !== 1
    ) {
      return 0
    }

    let pageWidth = Math.min(this.layout.pageWidth, width)
    if (!pageWidth || pageWidth <= 0) {
      return 0
    }

    let rect = this.contentBounds()
    if (!rect) {
      return 0
    }

    let rectWidth = rect.right - rect.left
    if (rectWidth <= 0 || rectWidth > pageWidth * 1.5) {
      return 0
    }

    let overlap = Math.min(rect.right, pageWidth) - Math.max(rect.left, 0)
    let visibleRatio = overlap > 0 ? overlap / rectWidth : 0
    let center = (rect.left + rect.right) / 2
    let centerOutside = center < 0 || center > pageWidth
    let startsLate = rect.left > pageWidth * 0.4 && rect.right > pageWidth

    if (!centerOutside && visibleRatio >= 0.75 && !startsLate) {
      return 0
    }

    let pageCenter = pageWidth / 2
    let offset = pageCenter - center

    if (rectWidth >= pageWidth) {
      let rightOverflow = rect.right - pageWidth
      let leftOverflow = -rect.left
      offset = rightOverflow > leftOverflow ? -rightOverflow : leftOverflow
    }

    if (Math.abs(offset) < 2 || Math.abs(offset) > pageWidth) {
      return 0
    }

    return offset
  }

  applySinglePageFirstPageOffset(width: number) {
    let content = this.contents && this.contents!.content
    let offset = this.singlePageFirstPageOffset(width)

    if (!content || !offset) {
      return
    }

    content.style.setProperty('translate', offset + 'px 0')
    this._singlePageFirstPageOffset = offset
  }

  fitLeadingTitleImagesBeforeMeasure() {
    if (
      !this.contents ||
      !this.contents!.content ||
      !this.contents!.window ||
      !this.layout ||
      this.layout.name === 'pre-paginated'
    ) {
      return false
    }

    let root = this.contents!.content
    let children = Array.prototype.slice
      .call(root.children || [], 0, LEADING_TITLE_IMAGE_MAX_SCAN)
      .filter((element) => element && element.querySelector)
    let changed = false

    for (let i = 0; i < children.length; i++) {
      let block = children[i]
      let image =
        elementName(block) === 'IMG'
          ? block
          : block.querySelector(':scope > img, img')

      if (!image || image.getAttribute(LEADING_TITLE_IMAGE_ATTRIBUTE)) {
        continue
      }

      if (textLength(block.textContent)) {
        continue
      }

      if (nextHeadingTextLength(block) <= 0) {
        continue
      }

      let style = this.contents!.window.getComputedStyle(block, null)
      let blockWidth = numericCssValue(style && style.width)
      let marginBottom = numericCssValue(style && style.marginBottom) || 0
      if (
        blockWidth === undefined ||
        blockWidth <= 0 ||
        blockWidth > LEADING_TITLE_IMAGE_MAX_BLOCK_WIDTH ||
        marginBottom >= -1
      ) {
        continue
      }

      image.setAttribute(LEADING_TITLE_IMAGE_ATTRIBUTE, 'true')
      image.style.setProperty('max-width', '100%', 'important')
      image.style.setProperty('max-inline-size', '100%', 'important')
      image.style.setProperty('height', 'auto', 'important')
      image.style.setProperty('box-sizing', 'border-box', 'important')
      changed = true
    }

    return changed
  }

  fitLeadingBlockBackgroundsBeforeMeasure() {
    if (
      !this.contents ||
      !this.contents!.content ||
      !this.contents!.window ||
      !this.layout ||
      this.layout.name === 'pre-paginated' ||
      this.settings.axis !== 'horizontal' ||
      this.settings.direction === 'rtl'
    ) {
      return false
    }

    let root = this.contents!.content
    let rootStyle = this.contents!.window.getComputedStyle(root, null)
    let paddingLeft = Math.max(
      0,
      numericCssValue(rootStyle && rootStyle.paddingLeft) || 0,
    )
    let paddingRight = Math.max(
      0,
      numericCssValue(rootStyle && rootStyle.paddingRight) || 0,
    )
    let children = Array.prototype.slice.call(
      root.children || [],
      0,
      LEADING_BLOCK_BACKGROUND_MAX_SCAN,
    )
    let changed = false

    for (let i = 0; i < children.length; i++) {
      let block = children[i]
      if (!block || !block.style || !isTitleLikeElement(block)) {
        continue
      }

      let style = this.contents!.window.getComputedStyle(block, null)
      if (!hasVisibleBackground(style)) {
        continue
      }

      let marginLeft = numericCssValue(style && style.marginLeft) || 0
      let marginRight = numericCssValue(style && style.marginRight) || 0

      if (marginLeft < -paddingLeft - 1) {
        block.style.setProperty('margin-left', -paddingLeft + 'px', 'important')
        changed = true
      }

      if (marginRight < -paddingRight - 1) {
        block.style.setProperty(
          'margin-right',
          -paddingRight + 'px',
          'important',
        )
        changed = true
      }
    }

    return changed
  }

  fitMediaBeforeMeasure() {
    if (
      !this.contents ||
      !this.layout ||
      this.layout.name === 'pre-paginated'
    ) {
      return
    }

    let computed = this.contents!.window.getComputedStyle(
      this.contents!.content,
      null,
    )
    let height =
      (this.contents!.content.offsetHeight -
        (parseFloat(computed.paddingTop) +
          parseFloat(computed.paddingBottom))) *
      0.95
    let horizontalPadding =
      parseFloat(computed.paddingLeft) + parseFloat(computed.paddingRight)
    let maxWidth = this.layout.columnWidth
      ? `min(100%, ${this.layout.columnWidth - horizontalPadding}px)`
      : '100%'

    this.contents!.addStylesheetRules(
      {
        img: {
          'max-width': maxWidth + '!important',
          'max-height': height + 'px' + '!important',
          'object-fit': 'contain',
          'page-break-inside': 'avoid',
          'break-inside': 'avoid',
          'box-sizing': 'border-box',
        },
        svg: {
          'max-width': maxWidth + '!important',
          'max-height': height + 'px' + '!important',
          'page-break-inside': 'avoid',
          'break-inside': 'avoid',
        },
      },
      'flow-epub-media-fit-before-measure',
    )
  }

  trimTrailingBlankPages(width: number) {
    if (
      !this.layout ||
      !this.layout.pageWidth ||
      this.layout.name !== 'reflowable' ||
      this.settings.axis !== 'horizontal'
    ) {
      return width
    }

    let pageWidth = this.layout.pageWidth
    let pages = Math.max(1, Math.ceil(width / pageWidth))

    for (let i = pages - 1; i >= 0; i--) {
      if (this.hasContentInRange(i * pageWidth, (i + 1) * pageWidth)) {
        if (
          i === 1 &&
          pages === 2 &&
          this.shouldTreatTwoPageWidthAsSinglePage(width)
        ) {
          return pageWidth
        }
        return (i + 1) * pageWidth
      }
    }

    if (pages === 2 && this.hasPageVisualBackground()) {
      return pageWidth
    }

    return width
  }

  normalizeOversizedSinglePageWrapper(width: number, trimmedWidth: number) {
    // Some converted EPUBs use an oversized wrapper as empty vertical canvas.
    // In paginated columns that canvas can move positioned descendants below
    // the only meaningful page even after trailing blank pages are trimmed.
    if (
      this._oversizedSinglePageWrapperNormalized ||
      !this.layout ||
      !this.layout.pageWidth ||
      this.layout.name !== 'reflowable' ||
      this.settings.flow !== 'paginated' ||
      this.settings.axis !== 'horizontal' ||
      this.settings.direction !== 'ltr' ||
      width <= this.layout.pageWidth ||
      trimmedWidth !== this.layout.pageWidth
    ) {
      return false
    }

    if (!this._oversizedSinglePageWrapperChecked) {
      this._oversizedSinglePageWrapperChecked = true

      let body = this.contents && this.contents!.content
      let wrapper =
        body && (body.firstElementChild as HTMLElement | null | undefined)

      if (wrapper && wrapper === body!.lastElementChild && wrapper.style) {
        let authoredHeight = wrapper.style.getPropertyValue('height').trim()
        let percentage = authoredHeight.endsWith('%')
          ? Number(authoredHeight.slice(0, -1))
          : NaN

        if (Number.isFinite(percentage) && percentage > 100) {
          this._oversizedSinglePageWrapper = wrapper
        }
      }
    }

    let wrapper = this._oversizedSinglePageWrapper
    if (!wrapper) {
      return false
    }

    let priority = wrapper.style.getPropertyPriority('height')
    wrapper.style.setProperty('height', '100%', priority)
    this._oversizedSinglePageWrapperNormalized = true

    return true
  }

  displayWidthForContentWidth(contentWidth: number) {
    if (
      !this.layout ||
      !this.layout.pageWidth ||
      this.layout.name !== 'reflowable' ||
      this.settings.axis !== 'horizontal'
    ) {
      return contentWidth
    }

    let pageCount = Math.max(1, Math.ceil(contentWidth / this.layout.pageWidth))

    this._contentWidth = contentWidth
    this._contentPageCount = pageCount

    return contentWidth
  }

  expand(force?: boolean) {
    var width = this.lockedWidth!
    var height = this.lockedHeight!

    let horizontal = this.settings.axis === 'horizontal'
    let displayWidth = width

    if (!this.iframe || this._expanding) return

    this._expanding = true
    this.clearSinglePageFirstPageOffset()

    if (this.layout.name === 'pre-paginated') {
      width = this.layout.columnWidth
      height = this.layout.height
    }
    // Expand Horizontally
    else if (horizontal) {
      // Get the width of the text
      width = this.contents!.textWidth()

      if (width % this.layout.pageWidth > 0) {
        width = Math.ceil(width / this.layout.pageWidth) * this.layout.pageWidth
      }
      displayWidth = width
    } // Expand Vertically
    else if (this.settings.axis === 'vertical') {
      height = this.contents!.textHeight()
      if (
        this.settings.flow === 'paginated' &&
        height % this.layout.height > 0
      ) {
        height = Math.ceil(height / this.layout.height) * this.layout.height
      }
    }

    // Only Resize if dimensions have changed or
    // if Frame is still hidden, so needs reframing
    if (
      this._needsReframe ||
      width != this._measureWidth ||
      height != this._height
    ) {
      this.reframe(width, height)

      let trimmedWidth = this.trimTrailingBlankPages(width)
      if (
        width > this.layout.pageWidth &&
        trimmedWidth === this.layout.pageWidth &&
        this.normalizeOversizedSinglePageWrapper(width, trimmedWidth)
      ) {
        width = this.contents!.textWidth()
        if (width % this.layout.pageWidth > 0) {
          width =
            Math.ceil(width / this.layout.pageWidth) * this.layout.pageWidth
        }
        this.reframe(width, height)
        trimmedWidth = this.trimTrailingBlankPages(width)
      }

      this._measureWidth = width
      displayWidth = this.displayWidthForContentWidth(trimmedWidth)
      if (displayWidth != width) {
        this.reframe(displayWidth, height)
      }
    }

    if (horizontal) {
      if (
        this.contents &&
        typeof this.contents.backgrounds?.fillReadablePageBackgrounds ===
          'function'
      ) {
        this.contents.backgrounds.fillReadablePageBackgrounds(
          this.layout.pageWidth,
          this.lockedHeight || this.layout.height,
          displayWidth,
          this.settings.direction,
        )
      }

      this.applySinglePageFirstPageOffset(displayWidth)
    }

    this._expanding = false
  }

  reframe(width: number, height: number) {
    var size

    if (isNumber(width)) {
      this.element.style.width = width + 'px'
      this.iframe!.style.width = width + 'px'
      this._width = width
    }

    if (isNumber(height)) {
      this.element.style.height = height + 'px'
      this.iframe!.style.height = height + 'px'
      this._height = height
    }

    let widthDelta = this.prevBounds ? width - this.prevBounds.width : width
    let heightDelta = this.prevBounds ? height - this.prevBounds.height : height

    size = {
      width: width,
      height: height,
      widthDelta: widthDelta,
      heightDelta: heightDelta,
    }

    if (this.pane) {
      try {
        this.pane.render()
      } catch (error) {
        // Marks may point to ranges from a view that was just cleared.
      }
    }

    this.onResize(this, size)

    this.emit(EVENTS.VIEWS.RESIZED, size)

    this.prevBounds = size

    this.elementBounds = bounds(this.element)
  }

  load(contents: string) {
    var loading = new defer<Contents>()
    var loaded = loading.promise

    if (!this.iframe) {
      loading.reject(new Error('No Iframe Available'))
      return loaded
    }

    this._loading = loading
    loaded.then(
      () => {
        if (this._loading === loading) this._loading = undefined
      },
      () => {
        if (this._loading === loading) this._loading = undefined
      },
    )

    this.iframe.onload = function (this: IframeView, event: Event) {
      this.onLoad(event, loading)
    }.bind(this)

    if (this.settings.method === 'blobUrl') {
      this.blobUrl = createBlobUrl(contents, 'application/xhtml+xml')
      this.iframe.src = this.blobUrl
      this.element.appendChild(this.iframe)
    } else if (this.settings.method === 'srcdoc') {
      this.iframe.srcdoc = contents
      this.element.appendChild(this.iframe)
    } else {
      this.element.appendChild(this.iframe)

      this.document = this.iframe!.contentDocument

      if (!this.document) {
        loading.reject(new Error('No Document Available'))
        return loaded
      }

      this.iframe!.contentDocument!.open()
      this.iframe!.contentDocument!.write(contents)
      this.iframe!.contentDocument!.close()
    }

    return loaded
  }

  onLoad(event: Event, promise: Deferred<Contents>) {
    this.window = this.iframe!.contentWindow as LegacyWindow
    this.document = this.iframe!.contentDocument

    this.contents = new Contents(
      this.document!,
      this.document!.body,
      this.section.cfiBase,
      this.section.index,
    )
    this._onWheel = (event) => {
      this.emit(EVENTS.VIEWS.WHEEL, event)
    }
    this.document!.addEventListener('wheel', this._onWheel, { passive: false })

    this.rendering = false

    var link = this.document!.querySelector("link[rel='canonical']")
    if (link) {
      link.setAttribute('href', this.section.canonical)
    } else {
      link = this.document!.createElement('link')
      link.setAttribute('rel', 'canonical')
      link.setAttribute('href', this.section.canonical)
      this.document!.querySelector('head')!.appendChild(link)
    }

    this.contents!.on(EVENTS.CONTENTS.EXPAND, () => {
      if (this.displayed && this.iframe) {
        this.expand()
        if (this.contents) {
          this.layout.format(
            this.contents,
            this.section,
            this.axis,
            this.settings.spreadSlot,
          )
        }
      }
    })

    this.contents!.on(EVENTS.CONTENTS.RESIZE, (e) => {
      if (this.displayed && this.iframe) {
        this.expand()
        if (this.contents) {
          this.layout.format(
            this.contents,
            this.section,
            this.axis,
            this.settings.spreadSlot,
          )
        }
      }
    })

    promise.resolve(this.contents)
  }

  setLayout(layout: Layout) {
    let previousPageWidth = this._layoutPageWidth
    let nextPageWidth = layout && layout.pageWidth
    let pageWidthChanged =
      previousPageWidth !== undefined &&
      nextPageWidth !== undefined &&
      previousPageWidth !== nextPageWidth

    this.layout = layout
    this._layoutPageWidth = nextPageWidth

    if (pageWidthChanged) {
      this._contentWidth = undefined
      this._contentPageCount = undefined
      this._needsReframe = true
    }

    if (this.contents) {
      if (typeof this.settings.beforeLayout === 'function') {
        this.settings.beforeLayout(this.contents, this)
      }
      this.layout.format(
        this.contents,
        this.section,
        this.axis,
        this.settings.spreadSlot,
      )
      this.expand()
    }
  }

  setAxis(axis: string) {
    this.axis = axis
    this.settings.axis = axis

    if (axis == 'horizontal') {
      this.element.style.flex = 'none'
    } else {
      this.element.style.flex = 'initial'
    }

    this.size()
  }

  createZoomCss(zoom?: number) {
    return createContentZoomCss(
      this.contents!,
      this.layout,
      this.axis,
      zoom,
      this.writingMode,
    )
  }

  refreshContents() {
    this._contentPageCount = undefined
    this.layout.format(
      this.contents!,
      this.section,
      this.axis,
      this.settings.spreadSlot,
    )
    this.expand()
  }

  setWritingMode(mode: string) {
    // this.element.style.writingMode = writingMode;
    this.writingMode = mode
  }

  display(request?: SectionRequest) {
    var displayed = new defer<IframeView>()

    if (!this.displayed) {
      this.render(request).then(
        function (this: IframeView) {
          this.emit(EVENTS.VIEWS.DISPLAYED, this)
          this.onDisplayed(this)

          this.displayed = true
          displayed.resolve(this)
        }.bind(this),
        function (this: IframeView, err: unknown) {
          ;(displayed.reject as (reason: unknown, ignored: IframeView) => void)(
            err,
            this,
          )
        },
      )
    } else {
      displayed.resolve(this)
    }

    return displayed.promise
  }

  show() {
    this.element.style.visibility = 'visible'

    if (this.iframe) {
      this.iframe!.style.visibility = 'visible'

      // Remind Safari to redraw the iframe
      this.iframe!.style.transform = 'translateZ(0)'
      this.iframe.offsetWidth
      this.iframe!.style.transform = null as unknown as string
    }

    this.emit(EVENTS.VIEWS.SHOWN, this)
  }

  hide() {
    // this.iframe!.style.display = "none";
    this.element.style.visibility = 'hidden'
    this.iframe!.style.visibility = 'hidden'

    this.stopExpanding = true
    this.emit(EVENTS.VIEWS.HIDDEN, this)
  }

  offset() {
    return {
      top: this.element.offsetTop,
      left: this.element.offsetLeft,
    }
  }

  width() {
    return this._width
  }

  pageCount() {
    if (this._contentPageCount) {
      return this._contentPageCount
    }

    if (!this.layout || !this.layout.pageWidth) {
      return 0
    }

    return Math.max(1, Math.ceil(this._width / this.layout.pageWidth))
  }

  height() {
    return this._height
  }

  position() {
    return this.element.getBoundingClientRect()
  }

  locationOf(target: string | EpubCFI, range?: Range | null) {
    var targetPos = this.contents!.locationOf(
      target,
      this.settings.ignoreClass,
      range,
      this.writingMode,
    )

    return {
      left: targetPos.left,
      top: targetPos.top,
    }
  }

  onDisplayed(view: IframeView) {
    // Stub, override with a custom functions
  }

  onResize(view: IframeView, e: ViewResize) {
    // Stub, override with a custom functions
  }

  bounds(force?: boolean) {
    if (force || !this.elementBounds) {
      this.elementBounds = bounds(this.element)
    }

    return this.elementBounds
  }

  highlight(
    cfiRange: string,
    data: AnnotationData = {},
    cb?: AnnotationCallback,
    className = 'flow-epub-hl',
    styles: AnnotationStyles = {},
    resolvedRange?: Range | null,
  ) {
    if (!this.contents) {
      return
    }
    const attributes: AnnotationStyles = Object.assign(
      { fill: 'yellow', 'fill-opacity': '0.3', 'mix-blend-mode': 'multiply' },
      styles,
    )
    let range =
      resolvedRange?.startContainer.ownerDocument === this.contents!.document
        ? resolvedRange
        : this.contents!.range(cfiRange)

    data['epubcfi'] = cfiRange

    this.ensureAnnotationPane()

    let mark = new Highlight(range!, className, data, attributes)
    return this.registerMark(this.highlights, cfiRange, mark, cb)
  }

  underline(
    cfiRange: string,
    data: AnnotationData = {},
    cb?: AnnotationCallback,
    className = 'flow-epub-ul',
    styles: AnnotationStyles = {},
  ) {
    if (!this.contents) {
      return
    }
    const attributes: AnnotationStyles = Object.assign(
      {
        stroke: 'black',
        'stroke-opacity': '0.3',
        'mix-blend-mode': 'multiply',
      },
      styles,
    )
    let range = this.contents!.range(cfiRange)
    data['epubcfi'] = cfiRange

    this.ensureAnnotationPane()

    let Mark = Underline
    if (attributes['data-underline-style'] === 'wavy') {
      Mark = WavyUnderline
    } else if (this.writingMode === 'vertical-rl') {
      Mark = VerticalUnderline
    }
    if (Mark === WavyUnderline || Mark === VerticalUnderline) {
      attributes['data-writing-mode'] = this.writingMode
    }
    let mark = new Mark(range!, className, data, attributes)
    return this.registerMark(this.underlines, cfiRange, mark, cb)
  }

  private registerMark(
    marks: Record<string, StoredMark>,
    cfiRange: string,
    mark: Highlight,
    cb?: AnnotationCallback,
  ) {
    let data = mark.data
    let emitter = () => {
      this.emit(EVENTS.VIEWS.MARK_CLICKED, cfiRange, data)
    }
    let h = this.pane!.addMark(mark)
    let listeners = [emitter, cb]
    marks[cfiRange] = { mark: h, element: h.element, listeners }

    h.element!.setAttribute('ref', h.className!)
    this.applyMarkCursor(h, h.attributes.cursor)
    for (let listener of listeners) {
      if (listener) {
        h.element!.addEventListener('click', listener)
        h.element!.addEventListener('touchstart', listener)
      }
    }
    return h
  }

  applyMarkCursor(mark: Highlight, cursor?: string | number) {
    if (!mark || !cursor) {
      return
    }

    mark.element!.setAttribute('cursor', cursor)
    mark.element!.style.cursor = cursor as string
    this.ensureMarkCursorProxy()
  }

  ensureAnnotationPane() {
    if (this.pane) return this.pane

    this.pane = new Pane(this.iframe!, this.element, this.writingMode)
    for (let i = 0; i < this.annotationBatchDepth; i++) {
      this.pane.beginBatch()
    }
    return this.pane
  }

  beginAnnotationBatch() {
    this.annotationBatchDepth += 1
    if (this.pane) this.pane.beginBatch()
  }

  endAnnotationBatch() {
    if (this.annotationBatchDepth === 0) return
    this.annotationBatchDepth -= 1
    if (this.pane) this.pane.endBatch()
  }

  ensureMarkCursorProxy() {
    if (!this.document || !this.iframe) {
      return
    }

    if (this.markCursorProxyDocument === this.document) {
      return
    }

    if (this.markCursorProxyDocument && this.markCursorProxyMove) {
      this.markCursorProxyDocument.removeEventListener(
        'mousemove',
        this.markCursorProxyMove,
      )
    }
    if (this.markCursorProxyDocument && this.markCursorProxyLeave) {
      this.markCursorProxyDocument.removeEventListener(
        'mouseleave',
        this.markCursorProxyLeave,
      )
    }

    this.markCursorProxyMove = (event) => {
      this.updateMarkCursor(event)
    }
    this.markCursorProxyLeave = () => {
      this.setDocumentCursor(undefined)
    }
    this.markCursorProxyDocument = this.document
    this.document!.addEventListener(
      'mousemove',
      this.markCursorProxyMove,
      false,
    )
    this.document!.addEventListener(
      'mouseleave',
      this.markCursorProxyLeave,
      false,
    )
  }

  updateMarkCursor(event: MouseEvent) {
    let cursor = this.cursorForMarkPoint(event.clientX, event.clientY)
    this.setDocumentCursor(cursor)
  }

  cursorForMarkPoint(x: number, y: number) {
    if (!this.iframe) {
      return
    }

    let marks = [
      ...Object.values(this.highlights),
      ...Object.values(this.underlines),
    ]

    for (let i = marks.length - 1; i >= 0; i--) {
      let mark = marks[i] && marks[i]!.mark
      let cursor = mark && mark.element && mark.element.style.cursor
      if (!cursor || !mark!.containsPoint(x, y)) {
        continue
      }

      return cursor
    }
  }

  setDocumentCursor(cursor: string | undefined) {
    if (cursor === this.activeMarkCursor) {
      return
    }

    let root = this.document && this.document.documentElement
    let body = this.document && this.document.body

    if (root) {
      root.style.cursor = cursor || ''
    }
    if (body) {
      body.style.cursor = cursor || ''
    }
    this.activeMarkCursor = cursor
  }

  unhighlight(cfiRange: string) {
    this.unregisterMark(this.highlights, cfiRange)
  }

  ununderline(cfiRange: string) {
    this.unregisterMark(this.underlines, cfiRange)
  }

  private unregisterMark(marks: Record<string, StoredMark>, cfiRange: string) {
    if (!(cfiRange in marks)) return
    let item = marks[cfiRange]!
    this.pane!.removeMark(item.mark)
    for (let listener of item.listeners) {
      if (listener) {
        item.element!.removeEventListener('click', listener)
        item.element!.removeEventListener('touchstart', listener)
      }
    }
    delete marks[cfiRange]
  }

  destroy() {
    if (this.destroyed) return
    this.destroyed = true
    if (this.pane) this.pane.beginBatch()

    for (let cfiRange in this.highlights) {
      this.unhighlight(cfiRange)
    }

    for (let cfiRange in this.underlines) {
      this.ununderline(cfiRange)
    }

    if (this.pane) {
      this.pane.destroy()
      this.pane = undefined
    }

    if (this.blobUrl) {
      revokeBlobUrl(this.blobUrl)
      this.blobUrl = undefined
    }

    this.displayed = false
    if (this.iframe) {
      this.iframe.onload = null
    }
    if (this._loading) {
      this._loading.reject(
        new Error('Iframe view destroyed before loading completed'),
      )
      this._loading = undefined
    }
    if (this._onWheel && this.document) {
      this.document.removeEventListener('wheel', this._onWheel)
    }
    this._onWheel = undefined
    this.contents?.destroy?.()

    this.stopExpanding = true
    if (this.iframe?.parentNode) {
      this.iframe.parentNode.removeChild(this.iframe)
    }

    this.iframe = undefined
    this.contents = undefined
    this.window = undefined
    this.document = undefined
    this.removeAllListeners()
    this.settings.beforeLayout = undefined

    this._textWidth = null!
    this._textHeight = null!
    this._width = null!
    this._height = null!

    // this.element.style.height = "0px";
    // this.element.style.width = "0px";
  }
}

export default IframeView
