import EventEmitter from '../../utils/event-emitter'
import { Pane, Highlight, Underline } from 'marks-pane'

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

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg'
const LEADING_TITLE_IMAGE_MAX_SCAN = 10
const LEADING_TITLE_IMAGE_HEADING_SCAN = 8
const LEADING_TITLE_IMAGE_MAX_BLOCK_WIDTH = 180
const LEADING_TITLE_IMAGE_ATTRIBUTE = 'data-epubjs-leading-title-image-clamped'

class WavyUnderline extends Highlight {
  render() {
    while (this.element.firstChild) {
      this.element.removeChild(this.element.firstChild)
    }

    let docFrag = this.element.ownerDocument.createDocumentFragment()
    let filtered = this.filteredRanges()
    let offset = this.element.getBoundingClientRect()
    let container = this.container.getBoundingClientRect()
    let stroke = this.attributes.stroke || 'black'
    let strokeOpacity = this.attributes['stroke-opacity'] || '0.9'
    let strokeWidth = numberAttribute(this.attributes, 'stroke-width', 1.8)
    let amplitude = numberAttribute(this.attributes, 'data-wave-amplitude', 2)
    let period = numberAttribute(this.attributes, 'data-wave-period', 7)
    let gap = numberAttribute(this.attributes, 'data-wave-gap', 1.5)

    for (let i = 0, len = filtered.length; i < len; i++) {
      let r = filtered[i]
      let x = r.left - offset.left + container.left
      let y = r.top - offset.top + container.top + r.height + gap

      let rect = createSvgElement(this.element.ownerDocument, 'rect')
      rect.setAttribute('x', x)
      rect.setAttribute('y', r.top - offset.top + container.top)
      rect.setAttribute('height', r.height)
      rect.setAttribute('width', r.width)
      rect.setAttribute('fill', 'none')
      rect.setAttribute('stroke', 'none')

      let path = createSvgElement(this.element.ownerDocument, 'path')
      path.setAttribute(
        'd',
        wavyUnderlinePath(x, r.width, y, amplitude, period),
      )
      path.setAttribute('fill', 'none')
      path.setAttribute('stroke', stroke)
      path.setAttribute('stroke-opacity', strokeOpacity)
      path.setAttribute('stroke-width', strokeWidth)
      path.setAttribute('stroke-linecap', 'round')
      path.setAttribute('stroke-linejoin', 'round')

      docFrag.appendChild(rect)
      docFrag.appendChild(path)
    }

    this.element.appendChild(docFrag)
  }
}

function createSvgElement(document, tagName) {
  return document.createElementNS(SVG_NAMESPACE, tagName)
}

function numberAttribute(attributes, name, fallback) {
  let value = Number(attributes[name])
  return Number.isFinite(value) ? value : fallback
}

function rectContainsPoint(rect, offset, x, y) {
  let top = rect.top - offset.top
  let left = rect.left - offset.left
  let bottom = top + rect.height
  let right = left + rect.width

  return top <= y && left <= x && bottom > y && right > x
}

function wavyUnderlinePath(x, width, y, amplitude, period) {
  let halfPeriod = Math.max(period / 2, 1)
  let remaining = Math.max(width, 0)
  let cursor = 0
  let direction = -1
  let path = `M${x} ${y}`

  while (remaining > 0) {
    let segment = Math.min(halfPeriod, remaining)
    let controlX = x + cursor + segment / 2
    let endX = x + cursor + segment

    path += ` Q${controlX} ${y + direction * amplitude} ${endX} ${y}`
    cursor += segment
    remaining -= segment
    direction *= -1
  }

  return path
}

function textLength(value) {
  return value ? value.replace(/\s+/g, '').length : 0
}

function elementName(element) {
  return element.localName.toUpperCase()
}

function numericCssValue(value) {
  if (!value) return undefined

  let match = String(value).match(/-?\d+(?:\.\d+)?/)
  if (!match) return undefined

  let numeric = Number(match[0])
  return Number.isFinite(numeric) ? numeric : undefined
}

function isHeadingElement(element) {
  return /^H[1-6]$/.test(elementName(element))
}

function nextHeadingTextLength(element) {
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

class IframeView {
  constructor(section, options) {
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

    this.id = 'epubjs-view-' + uuid()
    this.section = section
    this.index = section.index

    this.element = this.container(this.settings.axis)

    this.added = false
    this.displayed = false
    this.rendered = false

    // this.width  = this.settings.width;
    // this.height = this.settings.height;

    this.fixedWidth = 0
    this.fixedHeight = 0

    // Blank Cfi for Parsing
    this.epubcfi = new EpubCFI()

    this.layout = this.settings.layout
    // Dom events to listen for
    // this.listenedEvents = ["keydown", "keyup", "keypressed", "mouseup", "mousedown", "click", "touchend", "touchstart"];

    this.pane = undefined
    this.highlights = {}
    this.underlines = {}
    this.marks = {}
    this.markCursorProxyDocument = undefined
    this.markCursorProxyMove = undefined
    this.markCursorProxyLeave = undefined
    this.activeMarkCursor = undefined
  }

  container(axis) {
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
      this.element = this.createContainer()
    }

    this.iframe = document.createElement('iframe')
    this.iframe.id = this.id
    this.iframe.scrolling = 'no' // Might need to be removed: breaks ios width calculations
    this.iframe.style.overflow = 'hidden'
    this.iframe.seamless = 'seamless'
    // Back up if seamless isn't supported
    this.iframe.style.border = 'none'

    // sandbox
    this.iframe.sandbox = 'allow-same-origin'
    if (this.settings.allowScriptedContent) {
      this.iframe.sandbox += ' allow-scripts'
    }
    if (this.settings.allowPopups) {
      this.iframe.sandbox += ' allow-popups'
    }

    this.iframe.setAttribute('enable-annotation', 'true')

    this.resizing = true

    // this.iframe.style.display = "none";
    this.element.style.visibility = 'hidden'
    this.iframe.style.visibility = 'hidden'

    this.iframe.style.width = '0'
    this.iframe.style.height = '0'
    this._width = 0
    this._height = 0

    this.element.setAttribute('ref', this.index)

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

  render(request, show) {
    // view.onLayout = this.layout.format.bind(this.layout);
    this.create()

    // Fit to size of the container, apply padding
    this.size()

    if (!this.sectionRender) {
      this.sectionRender = this.section.render(request)
    }

    // Render Chain
    return this.sectionRender
      .then(
        function (contents) {
          return this.load(contents)
        }.bind(this),
      )
      .then(
        function () {
          // find and report the writingMode axis
          let writingMode = this.contents.writingMode()

          // Set the axis based on the flow and writing mode
          let axis
          if (this.settings.flow === 'scrolled') {
            axis =
              writingMode.indexOf('vertical') === 0 ? 'horizontal' : 'vertical'
          } else {
            axis =
              writingMode.indexOf('vertical') === 0 ? 'vertical' : 'horizontal'
          }

          if (
            writingMode.indexOf('vertical') === 0 &&
            this.settings.flow === 'paginated'
          ) {
            this.layout.delta = this.layout.height
          }

          this.setAxis(axis)
          this.emit(EVENTS.VIEWS.AXIS, axis)

          this.setWritingMode(writingMode)
          this.emit(EVENTS.VIEWS.WRITING_MODE, writingMode)

          if (typeof this.settings.beforeLayout === 'function') {
            this.settings.beforeLayout(this.contents, this)
          }

          // apply the layout function to the contents
          this.layout.format(this.contents, this.section, this.axis)
          this.fitLeadingTitleImagesBeforeMeasure()
          this.fitMediaBeforeMeasure()

          // Listen for events that require an expansion of the iframe
          this.addListeners()

          return new Promise((resolve, reject) => {
            // Expand the iframe to the full size of the content
            this.expand()

            if (this.settings.forceRight) {
              this.element.style.marginLeft = this.width() + 'px'
            }
            resolve()
          })
        }.bind(this),
        function (e) {
          this.emit(EVENTS.VIEWS.LOAD_ERROR, e)
          return new Promise((resolve, reject) => {
            reject(e)
          })
        }.bind(this),
      )
      .then(
        function () {
          this.emit(EVENTS.VIEWS.RENDERED, this.section)
        }.bind(this),
      )
  }

  reset() {
    if (this.iframe) {
      this.iframe.style.width = '0'
      this.iframe.style.height = '0'
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
  size(_width, _height) {
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
  lock(what, width, height) {
    var elBorders = borders(this.element)
    var iframeBorders

    if (this.iframe) {
      iframeBorders = borders(this.iframe)
    } else {
      iframeBorders = { width: 0, height: 0 }
    }

    if (what == 'width' && isNumber(width)) {
      this.lockedWidth = width - elBorders.width - iframeBorders.width
      // this.resize(this.lockedWidth, width); //  width keeps ratio correct
    }

    if (what == 'height' && isNumber(height)) {
      this.lockedHeight = height - elBorders.height - iframeBorders.height
      // this.resize(width, this.lockedHeight);
    }

    if (what === 'both' && isNumber(width) && isNumber(height)) {
      this.lockedWidth = width - elBorders.width - iframeBorders.width
      this.lockedHeight = height - elBorders.height - iframeBorders.height
      // this.resize(this.lockedWidth, this.lockedHeight);
    }

    if (this.displayed && this.iframe) {
      // this.contents.layout();
      this.expand()
    }
  }

  eachContentRect(callback) {
    let doc = this.document
    let root = this.contents && this.contents.content

    if (!doc || !root) {
      return false
    }

    let nodeFilter = doc.defaultView.NodeFilter
    let walker = doc.createTreeWalker(
      root,
      nodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          return node.data && node.data.trim().length > 0
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
        if (callback(rects[i])) {
          range.detach && range.detach()
          return true
        }
      }
    }

    range.detach && range.detach()

    let media = root.querySelectorAll('img, svg, math, video, audio, canvas')
    for (let i = 0; i < media.length; i++) {
      if (callback(media[i].getBoundingClientRect())) {
        return true
      }
    }

    return false
  }

  // Resize a single axis based on content dimensions
  hasContentInRange(start, end) {
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
    let contentBounds
    let addRect = (rect) => {
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

  pageBoundaryThreshold(pageWidth) {
    return Math.min(Math.max(pageWidth * 0.02, 2), 24)
  }

  contentRangeSummary(pageWidth) {
    let threshold = this.pageBoundaryThreshold(pageWidth)
    let summary

    let addRect = (rect) => {
      if (!rect || rect.width <= 0 || rect.height <= 0) {
        return
      }

      if (!summary) {
        summary = {
          bounds: {
            left: rect.left,
            right: rect.right,
            top: rect.top,
            bottom: rect.bottom,
          },
          crossesPageBoundary: false,
          startsInsideSecondPage: false,
        }
      } else {
        summary.bounds.left = Math.min(summary.bounds.left, rect.left)
        summary.bounds.right = Math.max(summary.bounds.right, rect.right)
        summary.bounds.top = Math.min(summary.bounds.top, rect.top)
        summary.bounds.bottom = Math.max(summary.bounds.bottom, rect.bottom)
      }

      if (
        rect.left < pageWidth - threshold &&
        rect.right > pageWidth + threshold
      ) {
        summary.crossesPageBoundary = true
      }

      if (rect.left >= pageWidth + threshold && rect.width > threshold) {
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

    if (typeof this.contents.findPageBackgrounds === 'function') {
      let height = this.lockedHeight || this.layout.height || 0
      let width = this.layout.columnWidth || this.layout.pageWidth
      return this.contents.findPageBackgrounds(width, height).length > 0
    }

    return false
  }

  shouldTreatTwoPageWidthAsSinglePage(width) {
    if (
      !this.layout ||
      !this.layout.pageWidth ||
      this.layout.name !== 'reflowable' ||
      this.settings.axis !== 'horizontal' ||
      this.settings.direction === 'rtl'
    ) {
      return false
    }

    let pageWidth = this.layout.pageWidth
    if (Math.max(1, Math.ceil(width / pageWidth)) !== 2) {
      return false
    }

    let summary = this.contentRangeSummary(pageWidth)
    if (!summary) {
      return this.hasPageVisualBackground()
    }

    if (summary.startsInsideSecondPage) {
      return false
    }

    let rect = summary.bounds
    let rectWidth = rect.right - rect.left
    if (rectWidth <= 0 || rectWidth > pageWidth * 1.5) {
      return false
    }

    return summary.crossesPageBoundary
  }

  clearSinglePageFirstPageOffset() {
    let content = this.contents && this.contents.content

    if (!content || !this._singlePageFirstPageOffset) {
      return
    }

    content.style.removeProperty('translate')
    this._singlePageFirstPageOffset = undefined
  }

  singlePageFirstPageOffset(width) {
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

  applySinglePageFirstPageOffset(width) {
    let content = this.contents && this.contents.content
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
      !this.contents.content ||
      !this.contents.window ||
      !this.layout ||
      this.layout.name === 'pre-paginated'
    ) {
      return false
    }

    let root = this.contents.content
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

      let style = this.contents.window.getComputedStyle(block, null)
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

  fitMediaBeforeMeasure() {
    if (
      !this.contents ||
      !this.layout ||
      this.layout.name === 'pre-paginated'
    ) {
      return
    }

    let computed = this.contents.window.getComputedStyle(
      this.contents.content,
      null,
    )
    let height =
      (this.contents.content.offsetHeight -
        (parseFloat(computed.paddingTop) +
          parseFloat(computed.paddingBottom))) *
      0.95
    let horizontalPadding =
      parseFloat(computed.paddingLeft) + parseFloat(computed.paddingRight)
    let maxWidth = this.layout.columnWidth
      ? this.layout.columnWidth - horizontalPadding + 'px'
      : '100%'

    this.contents.addStylesheetRules(
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
      'epubjs-media-fit-before-measure',
    )
  }

  trimTrailingBlankPages(width) {
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

  displayWidthForContentWidth(contentWidth) {
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

  expand(force) {
    var width = this.lockedWidth
    var height = this.lockedHeight

    var textWidth, textHeight
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
      width = this.contents.textWidth()

      if (width % this.layout.pageWidth > 0) {
        width = Math.ceil(width / this.layout.pageWidth) * this.layout.pageWidth
      }
      displayWidth = width
    } // Expand Vertically
    else if (this.settings.axis === 'vertical') {
      height = this.contents.textHeight()
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
      this._measureWidth = width

      let trimmedWidth = this.trimTrailingBlankPages(width)
      displayWidth = this.displayWidthForContentWidth(trimmedWidth)
      if (displayWidth != width) {
        this.reframe(displayWidth, height)
      }
    }

    if (horizontal) {
      if (
        this.contents &&
        typeof this.contents.fillReadablePageBackgrounds === 'function'
      ) {
        this.contents.fillReadablePageBackgrounds(
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

  reframe(width, height) {
    var size

    if (isNumber(width)) {
      this.element.style.width = width + 'px'
      this.iframe.style.width = width + 'px'
      this._width = width
    }

    if (isNumber(height)) {
      this.element.style.height = height + 'px'
      this.iframe.style.height = height + 'px'
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

    requestAnimationFrame(() => {
      let mark
      for (let m in this.marks) {
        if (Object.prototype.hasOwnProperty.call(this.marks, m)) {
          mark = this.marks[m]
          try {
            this.placeMark(mark.element, mark.range)
          } catch (error) {
            // Ignore detached ranges; active annotations are redrawn by callers.
          }
        }
      }
    })

    this.onResize(this, size)

    this.emit(EVENTS.VIEWS.RESIZED, size)

    this.prevBounds = size

    this.elementBounds = bounds(this.element)
  }

  load(contents) {
    var loading = new defer()
    var loaded = loading.promise

    if (!this.iframe) {
      loading.reject(new Error('No Iframe Available'))
      return loaded
    }

    this.iframe.onload = function (event) {
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

      this.document = this.iframe.contentDocument

      if (!this.document) {
        loading.reject(new Error('No Document Available'))
        return loaded
      }

      this.iframe.contentDocument.open()
      // For Cordova windows platform
      if (window.MSApp && window.MSApp.execUnsafeLocalFunction) {
        window.MSApp.execUnsafeLocalFunction(() => {
          this.iframe.contentDocument.write(contents)
        })
      } else {
        this.iframe.contentDocument.write(contents)
      }
      this.iframe.contentDocument.close()
    }

    return loaded
  }

  onLoad(event, promise) {
    this.window = this.iframe.contentWindow
    this.document = this.iframe.contentDocument

    this.contents = new Contents(
      this.document,
      this.document.body,
      this.section.cfiBase,
      this.section.index,
    )
    this._onWheel = (event) => {
      this.emit(EVENTS.VIEWS.WHEEL, event)
    }
    this.document.addEventListener('wheel', this._onWheel, { passive: false })

    this.rendering = false

    var link = this.document.querySelector("link[rel='canonical']")
    if (link) {
      link.setAttribute('href', this.section.canonical)
    } else {
      link = this.document.createElement('link')
      link.setAttribute('rel', 'canonical')
      link.setAttribute('href', this.section.canonical)
      this.document.querySelector('head').appendChild(link)
    }

    this.contents.on(EVENTS.CONTENTS.EXPAND, () => {
      if (this.displayed && this.iframe) {
        this.expand()
        if (this.contents) {
          this.layout.format(this.contents)
        }
      }
    })

    this.contents.on(EVENTS.CONTENTS.RESIZE, (e) => {
      if (this.displayed && this.iframe) {
        this.expand()
        if (this.contents) {
          this.layout.format(this.contents)
        }
      }
    })

    promise.resolve(this.contents)
  }

  setLayout(layout) {
    this.layout = layout

    if (this.contents) {
      if (typeof this.settings.beforeLayout === 'function') {
        this.settings.beforeLayout(this.contents, this)
      }
      this.layout.format(this.contents)
      this.expand()
    }
  }

  setAxis(axis) {
    this.settings.axis = axis

    if (axis == 'horizontal') {
      this.element.style.flex = 'none'
    } else {
      this.element.style.flex = 'initial'
    }

    this.size()
  }

  setWritingMode(mode) {
    // this.element.style.writingMode = writingMode;
    this.writingMode = mode
  }

  addListeners() {
    //TODO: Add content listeners for expanding
  }

  removeListeners(layoutFunc) {
    //TODO: remove content listeners for expanding
  }

  display(request) {
    var displayed = new defer()

    if (!this.displayed) {
      this.render(request).then(
        function () {
          this.emit(EVENTS.VIEWS.DISPLAYED, this)
          this.onDisplayed(this)

          this.displayed = true
          displayed.resolve(this)
        }.bind(this),
        function (err) {
          displayed.reject(err, this)
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
      this.iframe.style.visibility = 'visible'

      // Remind Safari to redraw the iframe
      this.iframe.style.transform = 'translateZ(0)'
      this.iframe.offsetWidth
      this.iframe.style.transform = null
    }

    this.emit(EVENTS.VIEWS.SHOWN, this)
  }

  hide() {
    // this.iframe.style.display = "none";
    this.element.style.visibility = 'hidden'
    this.iframe.style.visibility = 'hidden'

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

  locationOf(target) {
    var parentPos = this.iframe.getBoundingClientRect()
    var targetPos = this.contents.locationOf(target, this.settings.ignoreClass)

    return {
      left: targetPos.left,
      top: targetPos.top,
    }
  }

  onDisplayed(view) {
    // Stub, override with a custom functions
  }

  onResize(view, e) {
    // Stub, override with a custom functions
  }

  bounds(force) {
    if (force || !this.elementBounds) {
      this.elementBounds = bounds(this.element)
    }

    return this.elementBounds
  }

  highlight(cfiRange, data = {}, cb, className = 'epubjs-hl', styles = {}) {
    if (!this.contents) {
      return
    }
    const attributes = Object.assign(
      { fill: 'yellow', 'fill-opacity': '0.3', 'mix-blend-mode': 'multiply' },
      styles,
    )
    let range = this.contents.range(cfiRange)

    let emitter = () => {
      this.emit(EVENTS.VIEWS.MARK_CLICKED, cfiRange, data)
    }

    data['epubcfi'] = cfiRange

    if (!this.pane) {
      this.pane = new Pane(this.iframe, this.element)
    }

    let m = new Highlight(range, className, data, attributes)
    let h = this.pane.addMark(m)

    this.highlights[cfiRange] = {
      mark: h,
      element: h.element,
      listeners: [emitter, cb],
    }

    h.element.setAttribute('ref', className)
    this.applyMarkCursor(h, attributes.cursor)
    h.element.addEventListener('click', emitter)
    h.element.addEventListener('touchstart', emitter)

    if (cb) {
      h.element.addEventListener('click', cb)
      h.element.addEventListener('touchstart', cb)
    }
    return h
  }

  underline(cfiRange, data = {}, cb, className = 'epubjs-ul', styles = {}) {
    if (!this.contents) {
      return
    }
    const attributes = Object.assign(
      {
        stroke: 'black',
        'stroke-opacity': '0.3',
        'mix-blend-mode': 'multiply',
      },
      styles,
    )
    let range = this.contents.range(cfiRange)
    let emitter = () => {
      this.emit(EVENTS.VIEWS.MARK_CLICKED, cfiRange, data)
    }

    data['epubcfi'] = cfiRange

    if (!this.pane) {
      this.pane = new Pane(this.iframe, this.element)
    }

    let Mark =
      attributes['data-underline-style'] === 'wavy' ? WavyUnderline : Underline
    let m = new Mark(range, className, data, attributes)
    let h = this.pane.addMark(m)

    this.underlines[cfiRange] = {
      mark: h,
      element: h.element,
      listeners: [emitter, cb],
    }

    h.element.setAttribute('ref', className)
    this.applyMarkCursor(h, attributes.cursor)
    h.element.addEventListener('click', emitter)
    h.element.addEventListener('touchstart', emitter)

    if (cb) {
      h.element.addEventListener('click', cb)
      h.element.addEventListener('touchstart', cb)
    }
    return h
  }

  applyMarkCursor(mark, cursor) {
    if (!mark || !cursor) {
      return
    }

    mark.element.setAttribute('cursor', cursor)
    mark.element.style.cursor = cursor
    this.ensureMarkCursorProxy()
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
    this.document.addEventListener('mousemove', this.markCursorProxyMove, false)
    this.document.addEventListener(
      'mouseleave',
      this.markCursorProxyLeave,
      false,
    )
  }

  updateMarkCursor(event) {
    let cursor = this.cursorForMarkPoint(event.clientX, event.clientY)
    this.setDocumentCursor(cursor)
  }

  cursorForMarkPoint(x, y) {
    if (!this.iframe) {
      return
    }

    let offset = this.iframe.getBoundingClientRect()
    let marks = [
      ...Object.values(this.highlights),
      ...Object.values(this.underlines),
    ]

    for (let i = marks.length - 1; i >= 0; i--) {
      let mark = marks[i] && marks[i].mark
      let cursor = mark && mark.element && mark.element.style.cursor
      if (!cursor || !this.markContainsPoint(mark, offset, x, y)) {
        continue
      }

      return cursor
    }
  }

  markContainsPoint(mark, offset, x, y) {
    let rect = mark.getBoundingClientRect()
    if (!rectContainsPoint(rect, offset, x, y)) {
      return false
    }

    let rects = mark.getClientRects()
    for (let i = 0, len = rects.length; i < len; i++) {
      if (rectContainsPoint(rects[i], offset, x, y)) {
        return true
      }
    }

    return false
  }

  setDocumentCursor(cursor) {
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

  mark(cfiRange, data = {}, cb) {
    if (!this.contents) {
      return
    }

    if (cfiRange in this.marks) {
      let item = this.marks[cfiRange]
      return item
    }

    let range = this.contents.range(cfiRange)
    if (!range) {
      return
    }
    let container = range.commonAncestorContainer
    let parent = container.nodeType === 1 ? container : container.parentNode

    let emitter = (e) => {
      this.emit(EVENTS.VIEWS.MARK_CLICKED, cfiRange, data)
    }

    if (range.collapsed && container.nodeType === 1) {
      range = new Range()
      range.selectNodeContents(container)
    } else if (range.collapsed) {
      // Webkit doesn't like collapsed ranges
      range = new Range()
      range.selectNodeContents(parent)
    }

    let mark = this.document.createElement('a')
    mark.setAttribute('ref', 'epubjs-mk')
    mark.style.position = 'absolute'

    mark.dataset['epubcfi'] = cfiRange

    if (data) {
      Object.keys(data).forEach((key) => {
        mark.dataset[key] = data[key]
      })
    }

    if (cb) {
      mark.addEventListener('click', cb)
      mark.addEventListener('touchstart', cb)
    }

    mark.addEventListener('click', emitter)
    mark.addEventListener('touchstart', emitter)

    this.placeMark(mark, range)

    this.element.appendChild(mark)

    this.marks[cfiRange] = {
      element: mark,
      range: range,
      listeners: [emitter, cb],
    }

    return parent
  }

  placeMark(element, range) {
    let top, right, left

    if (
      this.layout.name === 'pre-paginated' ||
      this.settings.axis !== 'horizontal'
    ) {
      let pos = range.getBoundingClientRect()
      top = pos.top
      right = pos.right
    } else {
      // Element might break columns, so find the left most element
      let rects = range.getClientRects()

      let rect
      for (var i = 0; i != rects.length; i++) {
        rect = rects[i]
        if (!left || rect.left < left) {
          left = rect.left
          // right = rect.right;
          right =
            Math.ceil(left / this.layout.props.pageWidth) *
              this.layout.props.pageWidth -
            this.layout.gap / 2
          top = rect.top
        }
      }
    }

    element.style.top = `${top}px`
    element.style.left = `${right}px`
  }

  unhighlight(cfiRange) {
    let item
    if (cfiRange in this.highlights) {
      item = this.highlights[cfiRange]

      this.pane.removeMark(item.mark)
      item.listeners.forEach((l) => {
        if (l) {
          item.element.removeEventListener('click', l)
          item.element.removeEventListener('touchstart', l)
        }
      })
      delete this.highlights[cfiRange]
    }
  }

  ununderline(cfiRange) {
    let item
    if (cfiRange in this.underlines) {
      item = this.underlines[cfiRange]
      this.pane.removeMark(item.mark)
      item.listeners.forEach((l) => {
        if (l) {
          item.element.removeEventListener('click', l)
          item.element.removeEventListener('touchstart', l)
        }
      })
      delete this.underlines[cfiRange]
    }
  }

  unmark(cfiRange) {
    let item
    if (cfiRange in this.marks) {
      item = this.marks[cfiRange]
      this.element.removeChild(item.element)
      item.listeners.forEach((l) => {
        if (l) {
          item.element.removeEventListener('click', l)
          item.element.removeEventListener('touchstart', l)
        }
      })
      delete this.marks[cfiRange]
    }
  }

  destroy() {
    for (let cfiRange in this.highlights) {
      this.unhighlight(cfiRange)
    }

    for (let cfiRange in this.underlines) {
      this.ununderline(cfiRange)
    }

    for (let cfiRange in this.marks) {
      this.unmark(cfiRange)
    }

    if (this.blobUrl) {
      revokeBlobUrl(this.blobUrl)
    }

    if (this.displayed) {
      this.displayed = false

      this.removeListeners()
      if (this._onWheel && this.document) {
        this.document.removeEventListener('wheel', this._onWheel)
        this._onWheel = undefined
      }
      this.contents.destroy()

      this.stopExpanding = true
      this.element.removeChild(this.iframe)

      if (this.pane) {
        this.pane.element.remove()
        this.pane = undefined
      }

      this.iframe = undefined
      this.contents = undefined

      this._textWidth = null
      this._textHeight = null
      this._width = null
      this._height = null
    }

    // this.element.style.height = "0px";
    // this.element.style.width = "0px";
  }
}

EventEmitter(IframeView.prototype)

export default IframeView
