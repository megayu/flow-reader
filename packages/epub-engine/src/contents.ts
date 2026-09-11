import type Section from './section'
import type { ExternalLinkEvent } from './utils/replacements'
import type { LegacyWindow } from './utils/core'

export interface ViewportOptions {
  width?: number | string | null
  height?: number | string | null
  scale?: number | string
  minimum?: number | string
  maximum?: number | string
  scalable?: string
}
type Size = { width: number; height: number }
type CssPropertyRule = [string, string | number, boolean?]
type CssArrayRule = [string, ...CssPropertyRule[]] | [string, CssPropertyRule[]]
type CssDefinition = Record<string, string | number | boolean | undefined>
export type StylesheetRules =
  | Record<string, CssDefinition | CssDefinition[]>
  | CssArrayRule[]
type NestedCssRule = CSSRule &
  Partial<CSSStyleRule & CSSGroupingRule & CSSImportRule>
type ReadingNavigator = Navigator & {
  epubReadingSystem: {
    name: string
    version: string
    layoutStyle: string
    hasFeature: (feature: string) => boolean
  }
}
type ContentsEvents = {
  expand: []
  resize: [Size]
  selected: [string]
  selectedRange: [Range]
  linkClicked: [string, ExternalLinkEvent?]
} & { [K in (typeof DOM_EVENTS)[number]]: [Event] }

import EventEmitter from './utils/event-emitter'

import EpubCFI from './epubcfi'
import PageBackgrounds from './page-backgrounds'
import { EPUB_ENGINE_VERSION, EVENTS, DOM_EVENTS } from './utils/constants'
import { isNumber, prefixed, borders, defaults } from './utils/core'
import { replaceLinks } from './utils/replacements'

const hasNavigator = typeof navigator !== 'undefined'

const isChrome = hasNavigator && /Chrome/.test(navigator.userAgent)
const isWebkit =
  hasNavigator && !isChrome && /AppleWebKit/.test(navigator.userAgent)

const ELEMENT_NODE = 1
const PAGINATED_ROOT_STYLE = 'paginated-root-normalize'
const ORTHOGONAL_BLOCK_STYLE = 'orthogonal-block-sizing'
const ORTHOGONAL_BLOCK_ATTRIBUTE = 'data-flow-epub-orthogonal-block'

function parseViewportContent(content: string) {
  var parsed: ViewportOptions = {
    width: undefined,
    height: undefined,
    scale: undefined,
    minimum: undefined,
    maximum: undefined,
    scalable: undefined,
  }
  var _width = content.match(/width\s*=\s*([^,]*)/)
  var _height = content.match(/height\s*=\s*([^,]*)/)
  var _scale = content.match(/initial-scale\s*=\s*([^,]*)/)
  var _minimum = content.match(/minimum-scale\s*=\s*([^,]*)/)
  var _maximum = content.match(/maximum-scale\s*=\s*([^,]*)/)
  var _scalable = content.match(/user-scalable\s*=\s*([^,]*)/)

  if (_width && _width.length && typeof _width[1] !== 'undefined') {
    parsed.width = _width[1]
  }
  if (_height && _height.length && typeof _height[1] !== 'undefined') {
    parsed.height = _height[1]
  }
  if (_scale && _scale.length && typeof _scale[1] !== 'undefined') {
    parsed.scale = _scale[1]
  }
  if (_minimum && _minimum.length && typeof _minimum[1] !== 'undefined') {
    parsed.minimum = _minimum[1]
  }
  if (_maximum && _maximum.length && typeof _maximum[1] !== 'undefined') {
    parsed.maximum = _maximum[1]
  }
  if (_scalable && _scalable.length && typeof _scalable[1] !== 'undefined') {
    parsed.scalable = _scalable[1]
  }

  return parsed
}

/**
 * Handles DOM manipulation, queries and events for View contents
 * @class
 * @param {document} doc Document
 * @param {element} content Parent Element (typically Body)
 * @param {string} cfiBase Section component of CFIs
 * @param {number} sectionIndex Index in Spine of Conntent's Section
 */
class Contents extends EventEmitter<ContentsEvents> {
  declare epubcfi: EpubCFI
  declare document: Document
  declare documentElement: HTMLElement
  declare content: HTMLElement
  declare window: LegacyWindow
  declare backgrounds: PageBackgrounds
  declare _size: Size
  declare sectionIndex: number
  declare cfiBase: string
  declare called: number
  declare active: boolean
  declare destroyed: boolean | undefined
  declare mediaQueryListenerCleanup: (() => void)[]
  declare mediaQueryTimeouts: Set<ReturnType<typeof setTimeout>>
  declare imageLoadListenerCleanup: (() => void)[]
  declare visibilityListenerCleanup: (() => void) | undefined
  declare resizeCheckFrame: number | undefined
  declare expanding: ReturnType<typeof setTimeout> | undefined
  declare selectionEndTimeout: ReturnType<typeof setTimeout> | undefined
  declare observer: ResizeObserver | undefined
  declare onResize: ((size: Size) => void) | undefined
  declare _expanding: boolean | undefined
  declare _triggerEvent: ((event: Event) => void) | undefined
  declare _onSelectionChange: ((event: Event) => void) | undefined
  declare _writingModeRulesIncomplete: boolean | undefined
  declare _orthogonalBlockSizingApplied: boolean | undefined
  declare _orthogonalBlockLayoutSignature: string | undefined
  declare _orthogonalWritingModeCandidates: Element[] | undefined
  declare _layoutStyle: string | undefined

  constructor(
    doc: Document,
    content?: HTMLElement,
    cfiBase?: string,
    sectionIndex?: number,
  ) {
    super()

    // Blank Cfi for Parsing
    this.epubcfi = new EpubCFI()

    this.document = doc
    this.documentElement = this.document.documentElement
    this.content = content || this.document.body
    this.window = this.document.defaultView as LegacyWindow
    this.backgrounds = new PageBackgrounds(this.document, this.content)

    this._size = {
      width: 0,
      height: 0,
    }

    this.sectionIndex = sectionIndex || 0
    this.cfiBase = cfiBase || ''

    this.epubReadingSystem('Flow Reader EPUB Engine', EPUB_ENGINE_VERSION)
    this.called = 0
    this.active = true
    this.mediaQueryListenerCleanup = []
    this.mediaQueryTimeouts = new Set()
    this.imageLoadListenerCleanup = []
    this.visibilityListenerCleanup = undefined
    this.resizeCheckFrame = undefined
    this.addListeners()
  }

  /**
   * Get DOM events that are listened for and passed along
   */
  static get listenedEvents() {
    return DOM_EVENTS
  }

  /**
   * Set width without measuring layout
   * @param {number} [w]
   * @private
   */
  setWidth(w?: number | string | null) {
    if (w && isNumber(w)) {
      w = w + 'px'
    }

    if (w) {
      this.content.style.width = w as string
    }
  }

  /**
   * Set height without measuring layout
   * @param {number} [h]
   * @private
   */
  setHeight(h?: number | string | null) {
    if (h && isNumber(h)) {
      h = h + 'px'
    }

    if (h) {
      this.content.style.height = h as string
    }
  }

  /**
   * Get or Set width of the contents
   * @param {number} [w]
   * @returns {number} width
   */
  contentWidth(w?: number | string | null) {
    var content = this.content || this.document.body

    if (w && isNumber(w)) {
      w = w + 'px'
    }

    if (w) {
      content.style.width = w as string
    }

    return parseInt(this.window.getComputedStyle(content)['width'])
  }

  /**
   * Get the width of the text using Range
   * @returns {number} width
   */
  textWidth() {
    let rect
    let width
    let range = this.document.createRange()
    let content = this.content || this.document.body
    let border = borders(content)

    // Select the contents of frame
    range.selectNodeContents(content)

    // get the width of the text content
    rect = range.getBoundingClientRect()
    width = rect.width

    if (border && border.width) {
      width += border.width
    }

    return Math.round(width)
  }

  /**
   * Get the height of the text using Range
   * @returns {number} height
   */
  textHeight() {
    let rect
    let height
    let range = this.document.createRange()
    let content = this.content || this.document.body

    range.selectNodeContents(content)

    rect = range.getBoundingClientRect()
    height = rect.bottom

    return Math.round(height)
  }

  /**
   * Get documentElement scrollWidth
   * @returns {number} width
   */
  scrollWidth() {
    var width = this.documentElement.scrollWidth

    return width
  }

  /**
   * Get documentElement scrollHeight
   * @returns {number} height
   */
  scrollHeight() {
    var height = this.documentElement.scrollHeight

    return height
  }

  /**
   * Set overflow css style of the contents
   * @param {string} [overflow]
   */
  overflow(overflow?: string) {
    if (overflow) {
      this.documentElement.style.overflow = overflow
    }

    return this.window.getComputedStyle(this.documentElement)['overflow']
  }

  /**
   * Set overflowX css style of the documentElement
   * @param {string} [overflow]
   */
  overflowX(overflow?: string) {
    if (overflow) {
      this.documentElement.style.overflowX = overflow
    }

    return this.window.getComputedStyle(this.documentElement)['overflowX']
  }

  /**
   * Set overflowY css style of the documentElement
   * @param {string} [overflow]
   */
  overflowY(overflow?: string) {
    if (overflow) {
      this.documentElement.style.overflowY = overflow
    }

    return this.window.getComputedStyle(this.documentElement)['overflowY']
  }

  /**
   * Set or remove styles without reading computed values. Layout measurement
   * stays with the geometry reads after the required styles have been applied.
   * @param {string} property
   * @param {string} [value] omitted or empty removes the property
   * @param {boolean} [priority] set as "important"
   */
  setCss(property: string, value?: string | null, priority?: boolean) {
    var content = this.content || this.document.body

    if (value) {
      content.style.setProperty(property, value, priority ? 'important' : '')
    } else {
      content.style.removeProperty(property)
    }
  }

  /**
   * Get or Set the viewport element
   * @param {object} [options]
   * @param {string} [options.width]
   * @param {string} [options.height]
   * @param {string} [options.scale]
   * @param {string} [options.minimum]
   * @param {string} [options.maximum]
   * @param {string} [options.scalable]
   */
  viewport(options?: ViewportOptions) {
    // var width, height, scale, minimum, maximum, scalable;
    var $viewport = this.document.querySelector("meta[name='viewport']")
    var parsed = parseViewportContent('')
    var newContent = []
    var settings: ViewportOptions = {}

    /*
     * check for the viewport size
     * <meta name="viewport" content="width=1024,height=697" />
     */
    if ($viewport && $viewport.hasAttribute('content')) {
      let content = $viewport.getAttribute('content')
      parsed = parseViewportContent(content!)
    }

    settings = defaults(options || {}, parsed)

    if (options) {
      if (settings.width) {
        newContent.push('width=' + settings.width)
      }

      if (settings.height) {
        newContent.push('height=' + settings.height)
      }

      if (settings.scale) {
        newContent.push('initial-scale=' + settings.scale)
      }

      if (settings.scalable === 'no') {
        newContent.push('minimum-scale=' + settings.scale)
        newContent.push('maximum-scale=' + settings.scale)
        newContent.push('user-scalable=' + settings.scalable)
      } else {
        if (settings.scalable) {
          newContent.push('user-scalable=' + settings.scalable)
        }

        if (settings.minimum) {
          newContent.push('minimum-scale=' + settings.minimum)
        }

        if (settings.maximum) {
          newContent.push('minimum-scale=' + settings.maximum)
        }
      }

      if (!$viewport) {
        $viewport = this.document.createElement('meta')
        $viewport.setAttribute('name', 'viewport')
        this.document.querySelector('head')!.appendChild($viewport)
      }

      $viewport.setAttribute('content', newContent.join(', '))

      this.window.scrollTo(0, 0)
    }

    return settings
  }

  /**
   * Event emitter for when the contents has expanded
   * @private
   */
  expand() {
    this.emit(EVENTS.CONTENTS.EXPAND)
  }

  /**
   * Add DOM listeners
   * @private
   */
  addListeners() {
    this.imageLoadListeners()

    this.mediaQueryListeners()

    // this.fontLoadListeners();

    this.addEventListeners()

    this.addSelectionListeners()

    // this.transitionListeners();

    if (typeof ResizeObserver === 'undefined') {
      this.resizeListeners()
      this.visibilityListeners()
    } else {
      this.resizeObservers()
    }

    // this.mutationObservers();

    this.linksHandler()
  }

  /**
   * Remove DOM listeners
   * @private
   */
  removeListeners() {
    this.removeEventListeners()

    this.removeSelectionListeners()
    this.removeMediaQueryListeners()
    this.clearMediaQueryTimeouts()
    this.removeImageLoadListeners()

    if (this.visibilityListenerCleanup) {
      this.visibilityListenerCleanup()
      this.visibilityListenerCleanup = undefined
    }

    if (this.observer) {
      this.observer.disconnect()
      this.observer = undefined
    }

    if (this.resizeCheckFrame) {
      cancelAnimationFrame(this.resizeCheckFrame)
      this.resizeCheckFrame = undefined
    }

    clearTimeout(this.expanding)
    clearTimeout(this.selectionEndTimeout)
    this.expanding = undefined
    this.selectionEndTimeout = undefined
  }

  /**
   * Check if size of contents has changed and
   * emit 'resize' event if it has.
   * @private
   */
  resizeCheck() {
    let width = this.textWidth()
    let height = this.textHeight()

    if (width != this._size.width || height != this._size.height) {
      this._size = {
        width: width,
        height: height,
      }

      this.onResize && this.onResize(this._size)
      this.emit(EVENTS.CONTENTS.RESIZE, this._size)
    }
  }

  scheduleResizeCheck() {
    if (this.resizeCheckFrame) {
      return
    }

    this.resizeCheckFrame = requestAnimationFrame(() => {
      this.resizeCheckFrame = undefined
      this.resizeCheck()
    })
  }

  /**
   * Poll for resize detection
   * @private
   */
  resizeListeners() {
    // Test size again
    clearTimeout(this.expanding)
    this.scheduleResizeCheck()
    this.expanding = setTimeout(this.resizeListeners.bind(this), 350)
  }

  /**
   * Listen for visibility of tab to change
   * @private
   */
  visibilityListeners() {
    if (this.visibilityListenerCleanup) {
      this.visibilityListenerCleanup()
    }

    var handler = () => {
      if (document.visibilityState === 'visible' && this.active === false) {
        this.active = true
        this.resizeListeners()
      } else {
        this.active = false
        clearTimeout(this.expanding)
      }
    }

    document.addEventListener('visibilitychange', handler)
    this.visibilityListenerCleanup = () => {
      document.removeEventListener('visibilitychange', handler)
    }
  }

  /**
   * Listen for media query changes and emit 'expand' event
   * Adapted from: https://github.com/tylergaw/media-query-events/blob/master/js/mq-events.js
   * @private
   */
  mediaQueryListeners() {
    this.removeMediaQueryListeners()

    var sheets = this.document.styleSheets
    var mediaChangeHandler = function (this: Contents, m: MediaQueryListEvent) {
      if (m.matches && !this._expanding) {
        var timeout = setTimeout(() => {
          this.mediaQueryTimeouts.delete(timeout)
          this.expand()
        }, 1)
        this.mediaQueryTimeouts.add(timeout)
      }
    }.bind(this)

    for (var i = 0; i < sheets.length; i += 1) {
      var rules
      // Firefox errors if we access cssRules cross-domain
      try {
        rules = sheets[i]!.cssRules
      } catch (e) {
        return
      }
      if (!rules) return // Stylesheets changed
      for (var j = 0; j < rules.length; j += 1) {
        //if (rules[j].constructor === CSSMediaRule) {
        if ((rules[j] as CSSMediaRule).media) {
          let mql = this.window.matchMedia(
            (rules[j] as CSSMediaRule).media.mediaText,
          )
          if (mql.addEventListener) {
            mql.addEventListener('change', mediaChangeHandler)
            this.mediaQueryListenerCleanup.push(() => {
              mql.removeEventListener('change', mediaChangeHandler)
            })
          } else {
            mql.addListener(mediaChangeHandler)
            this.mediaQueryListenerCleanup.push(() => {
              mql.removeListener(mediaChangeHandler)
            })
          }
        }
      }
    }
  }

  removeMediaQueryListeners() {
    if (!this.mediaQueryListenerCleanup) {
      return
    }

    this.mediaQueryListenerCleanup.forEach((cleanup) => cleanup())
    this.mediaQueryListenerCleanup = []
  }

  clearMediaQueryTimeouts() {
    if (!this.mediaQueryTimeouts) {
      return
    }

    this.mediaQueryTimeouts.forEach((timeout) => clearTimeout(timeout))
    this.mediaQueryTimeouts.clear()
  }

  /**
   * Use ResizeObserver to listen for changes in the DOM and check for resize
   * @private
   */
  resizeObservers() {
    // create an observer instance
    this.observer = new ResizeObserver((e) => {
      this.scheduleResizeCheck()
    })

    // pass in the target node
    this.observer.observe(this.document.documentElement)
  }

  /**
   * Test if images are loaded or add listener for when they load
   * @private
   */
  imageLoadListeners() {
    this.removeImageLoadListeners()

    var images = this.document.querySelectorAll('img')
    var img
    for (var i = 0; i < images.length; i++) {
      img = images[i]!

      if (typeof img.naturalWidth !== 'undefined' && img.naturalWidth === 0) {
        var handler = this.expand.bind(this)
        img.addEventListener('load', handler)
        this.imageLoadListenerCleanup.push(
          img.removeEventListener.bind(img, 'load', handler),
        )
      }
    }
  }

  removeImageLoadListeners() {
    if (!this.imageLoadListenerCleanup) {
      return
    }

    this.imageLoadListenerCleanup.forEach((cleanup) => cleanup())
    this.imageLoadListenerCleanup = []
  }

  /**
   * Get the documentElement
   * @returns {element} documentElement
   */
  root() {
    if (!this.document) return null
    return this.document.documentElement
  }

  /**
   * Get the location offset of a EpubCFI or an #id
   * @param {string | EpubCFI} target
   * @param {string} [ignoreClass] for the cfi
   * @returns { {left: Number, top: Number }
   */
  locationOf(
    target: string | EpubCFI,
    ignoreClass?: string,
    resolvedRange?: Range | null,
    writingMode?: string,
  ) {
    var position
    var targetPos = { left: 0, top: 0 }
    var logicalStartNode
    var logicalStartOffset = 0

    if (!this.document) return targetPos

    if (this.epubcfi.isCfiString(target)) {
      let range =
        resolvedRange || new EpubCFI(target).toRange(this.document, ignoreClass)

      if (range) {
        try {
          if (
            !range.endContainer ||
            (range.startContainer == range.endContainer &&
              range.startOffset == range.endOffset)
          ) {
            // If the end for the range is not set, it results in collapsed becoming
            // true. This in turn leads to inconsistent behaviour when calling
            // getBoundingRect. Wrong bounds lead to the wrong page being displayed.
            // https://developer.microsoft.com/en-us/microsoft-edge/platform/issues/15684911/
            let pos = range.startContainer.textContent!.indexOf(
              ' ',
              range.startOffset,
            )
            if (pos == -1) {
              pos = range.startContainer.textContent!.length
            }
            range.setEnd(range.startContainer, pos)
          }
        } catch (e) {
          console.error(
            'setting end offset to start container length failed',
            e,
          )
        }

        if (range.startContainer.nodeType === Node.ELEMENT_NODE) {
          position = (range.startContainer as Element).getBoundingClientRect()
          logicalStartNode = range.startContainer
          logicalStartOffset = range.startOffset
          targetPos.left = position.left
          targetPos.top = position.top
        } else {
          logicalStartNode = range.startContainer
          logicalStartOffset = range.startOffset
          // Webkit does not handle collapsed range bounds correctly
          // https://bugs.webkit.org/show_bug.cgi?id=138949

          // Construct a new non-collapsed range
          if (isWebkit) {
            let container = range.startContainer
            let newRange = new Range()
            try {
              if (container.nodeType === ELEMENT_NODE) {
                position = (container as Element).getBoundingClientRect()
              } else if (range.startOffset + 2 < (container as Text).length) {
                newRange.setStart(container, range.startOffset)
                newRange.setEnd(container, range.startOffset + 2)
                position = newRange.getBoundingClientRect()
              } else if (range.startOffset - 2 > 0) {
                newRange.setStart(container, range.startOffset - 2)
                newRange.setEnd(container, range.startOffset)
                position = newRange.getBoundingClientRect()
              } else {
                // empty, return the parent element
                position = (
                  container.parentNode as Element
                ).getBoundingClientRect()
              }
            } catch (e) {
              console.error(e, (e as Error).stack)
            }
          } else {
            position = range.getBoundingClientRect()
          }
        }
      }
    } else if (typeof target === 'string' && target.indexOf('#') > -1) {
      let id = target.substring(target.indexOf('#') + 1)
      let el = this.document.getElementById(id)
      if (el) {
        logicalStartNode = el
        if (isWebkit) {
          // Webkit reports incorrect bounding rects in Columns
          let newRange = new Range()
          newRange.selectNode(el)
          position = newRange.getBoundingClientRect()
        } else {
          position = el.getBoundingClientRect()
        }
      }
    }

    if (
      (writingMode || this.writingMode()).indexOf('vertical-rl') === 0 &&
      logicalStartNode
    ) {
      position =
        this.verticalLogicalStartPosition(
          logicalStartNode,
          logicalStartOffset,
        ) || position
    }

    if (position) {
      targetPos.left = position.left
      targetPos.top = position.top
    }

    return targetPos
  }

  verticalLogicalStartPosition(node: Node, offset: number) {
    if (!node || !this.document) return

    let textNode
    let textOffset = 0
    if (node.nodeType === Node.TEXT_NODE) {
      textNode = node
      textOffset = Math.min(
        Math.max(offset || 0, 0),
        (node as Text).length || 0,
      )
    } else {
      let root = node
      if (node.nodeType === Node.ELEMENT_NODE && offset > 0) {
        root = node.childNodes[offset] || node
      }
      let walker = this.document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      textNode = walker.nextNode()
    }

    while (textNode) {
      let text = textNode.textContent || ''
      let start = textOffset
      while (start < text.length && /\s/.test(text[start]!)) start++
      if (start < text.length) {
        let range = this.document.createRange()
        range.setStart(textNode, start)
        range.setEnd(textNode, Math.min(start + 1, text.length))
        let rect = Array.from(range.getClientRects()).find(
          (candidate) => candidate.width > 0 && candidate.height > 0,
        )
        if (rect) return rect
      }

      let walker = this.document.createTreeWalker(node, NodeFilter.SHOW_TEXT)
      walker.currentNode = textNode
      textNode = walker.nextNode()
      textOffset = 0
    }

    if (node.nodeType === Node.ELEMENT_NODE) {
      return (node as Element).getBoundingClientRect()
    }
  }

  _getStylesheetNode(key?: string) {
    var styleEl
    key = 'flow-epub-inserted-css-' + (key || '')

    if (!this.document) return false

    // Check if link already exists
    styleEl = this.document.getElementById(key) as HTMLStyleElement | null
    if (!styleEl) {
      styleEl = this.document.createElement('style')
      styleEl.id = key
      // Append style element to head
      this.document.head.appendChild(styleEl)
    }
    return styleEl
  }

  /**
   * Append stylesheet css
   * @param {string} serializedCss
   * @param {string} key If the key is the same, the CSS will be replaced instead of inserted
   */
  addStylesheetCss(serializedCss: string, key?: string) {
    if (!this.document || !serializedCss) return false

    var styleEl
    styleEl = this._getStylesheetNode(key)
    ;(styleEl as HTMLStyleElement).innerHTML = serializedCss

    return true
  }

  /**
   * Append stylesheet rules to a generate stylesheet
   * Array: https://developer.mozilla.org/en-US/docs/Web/API/CSSStyleSheet/insertRule
   * Object: https://github.com/desirable-objects/json-to-css
   * @param {array | object} rules
   * @param {string} key If the key is the same, the CSS will be replaced instead of inserted
   */
  addStylesheetRules(rules: StylesheetRules, key?: string) {
    var styleSheet: CSSStyleSheet

    if (!this.document || !rules || (rules as CssArrayRule[]).length === 0)
      return

    // Grab style sheet
    styleSheet = (this._getStylesheetNode(key) as HTMLStyleElement).sheet!

    if (Object.prototype.toString.call(rules) === '[object Array]') {
      for (var i = 0, rl = (rules as CssArrayRule[]).length; i < rl; i++) {
        var j = 1,
          rule: CssArrayRule | CssPropertyRule[] = (rules as CssArrayRule[])[
            i
          ]!,
          selector = (rules as CssArrayRule[])[i]![0],
          propStr = ''
        // If the second argument of a rule is an array of arrays, correct our variables.
        if (Object.prototype.toString.call(rule[1]![0]) === '[object Array]') {
          rule = rule[1] as CssPropertyRule[]
          j = 0
        }

        for (var pl = rule.length; j < pl; j++) {
          var prop = rule[j] as CssPropertyRule
          propStr +=
            prop[0] + ':' + prop[1] + (prop[2] ? ' !important' : '') + ';\n'
        }

        // Insert CSS Rule
        styleSheet.insertRule(
          selector + '{' + propStr + '}',
          styleSheet.cssRules.length,
        )
      }
    } else {
      const selectors = Object.keys(rules)
      selectors.forEach((selector) => {
        const definition = (
          rules as Record<string, CssDefinition | CssDefinition[]>
        )[selector]!
        if (Array.isArray(definition)) {
          definition.forEach((item) => {
            const _rules = Object.keys(item)
            const result = _rules
              .map((rule) => {
                return `${rule}:${item[rule]}`
              })
              .join(';')
            styleSheet.insertRule(
              `${selector}{${result}}`,
              styleSheet.cssRules.length,
            )
          })
        } else {
          const _rules = Object.keys(definition)
          const result = _rules
            .map((rule) => {
              return `${rule}:${definition[rule]}`
            })
            .join(';')
          styleSheet.insertRule(
            `${selector}{${result}}`,
            styleSheet.cssRules.length,
          )
        }
      })
    }
  }

  /**
   * Add DOM event listeners
   * @private
   */
  addEventListeners() {
    if (!this.document) {
      return
    }

    this._triggerEvent = this.triggerEvent.bind(this)

    DOM_EVENTS.forEach(function (this: Contents, eventName) {
      this.document.addEventListener(eventName, this._triggerEvent!, {
        passive: !eventName.startsWith('key'),
      })
    }, this)
  }

  /**
   * Remove DOM event listeners
   * @private
   */
  removeEventListeners() {
    if (!this.document) {
      return
    }
    DOM_EVENTS.forEach(function (this: Contents, eventName) {
      this.document.removeEventListener(eventName, this._triggerEvent!, {
        passive: !eventName.startsWith('key'),
      } as EventListenerOptions)
    }, this)
    this._triggerEvent = undefined
  }

  /**
   * Emit passed browser events
   * @private
   */
  triggerEvent(e: Event) {
    this.emit(e.type as (typeof DOM_EVENTS)[number], e)
  }

  /**
   * Add listener for text selection
   * @private
   */
  addSelectionListeners() {
    if (!this.document) {
      return
    }
    this._onSelectionChange = this.onSelectionChange.bind(this)
    this.document.addEventListener('selectionchange', this._onSelectionChange, {
      passive: true,
    })
  }

  /**
   * Remove listener for text selection
   * @private
   */
  removeSelectionListeners() {
    if (!this.document) {
      return
    }
    this.document.removeEventListener(
      'selectionchange',
      this._onSelectionChange!,
      { passive: true } as EventListenerOptions,
    )
    this._onSelectionChange = undefined
  }

  /**
   * Handle getting text on selection
   * @private
   */
  onSelectionChange(e: Event) {
    if (this.selectionEndTimeout) {
      clearTimeout(this.selectionEndTimeout)
    }
    this.selectionEndTimeout = setTimeout(
      function (this: Contents) {
        var selection = this.window.getSelection()
        this.triggerSelectedEvent(selection)
      }.bind(this),
      250,
    )
  }

  /**
   * Emit event on text selection
   * @private
   */
  triggerSelectedEvent(selection: Selection | null) {
    var range, cfirange

    if (selection && selection.rangeCount > 0) {
      range = selection.getRangeAt(0)
      if (!range.collapsed) {
        // cfirange = this.section.cfiFromRange(range);
        cfirange = new EpubCFI(range, this.cfiBase).toString()
        this.emit(EVENTS.CONTENTS.SELECTED, cfirange)
        this.emit(EVENTS.CONTENTS.SELECTED_RANGE, range)
      }
    }
  }

  /**
   * Get a Dom Range from EpubCFI
   * @param {EpubCFI} _cfi
   * @param {string} [ignoreClass]
   * @returns {Range} range
   */
  range(_cfi: string | EpubCFI, ignoreClass?: string) {
    var cfi = new EpubCFI(_cfi)
    return cfi.toRange(this.document, ignoreClass)
  }

  /**
   * Get an EpubCFI from a Dom Range
   * @param {Range} range
   * @param {string} [ignoreClass]
   * @returns {EpubCFI} cfi
   */
  cfiFromRange(range: Range, ignoreClass?: string) {
    return new EpubCFI(range, this.cfiBase, ignoreClass).toString()
  }

  /**
   * Size the contents to a given width and height
   * @param {number} [width]
   * @param {number} [height]
   */
  size(width?: number | null, height?: number | null) {
    var viewport: ViewportOptions = { scale: 1.0, scalable: 'no' }

    this.layoutStyle('scrolling')
    this.addStylesheetCss(' ', PAGINATED_ROOT_STYLE)
    this.clearOrthogonalBlockSizing()

    if (width! >= 0) {
      this.setWidth(width)
      viewport.width = width
      this.setCss('padding', '0 ' + width! / 12 + 'px')
    }

    if (height! >= 0) {
      this.setHeight(height)
      viewport.height = height
    }

    this.setCss('margin', '0')
    this.setCss('box-sizing', 'border-box')

    if (isNumber(width) && isNumber(height) && width! >= 0 && height! >= 0) {
      this.backgrounds.normalizePageBackgrounds(width!, height!)
    } else {
      this.backgrounds.clearPageBackgroundNormalization()
    }

    this.viewport(viewport)
  }

  writingModeRuleSelectors() {
    let selectors: string[] = []
    let seen: Record<string, boolean> = {}
    this._writingModeRulesIncomplete = false
    let visitRules = (rules: CSSRuleList | undefined) => {
      if (!rules) return

      for (let i = 0; i < rules.length; i++) {
        let rule = rules[i] as NestedCssRule | undefined
        let style = rule && rule.style
        let selector = rule && rule.selectorText
        let writingMode =
          style &&
          (style.getPropertyValue('writing-mode') ||
            style.getPropertyValue('-webkit-writing-mode'))

        if (selector && writingMode && !seen[selector]) {
          seen[selector] = true
          selectors.push(selector)
        }

        if (rule) {
          try {
            if (rule.cssRules) {
              visitRules(rule.cssRules)
            } else if (rule.styleSheet) {
              visitRules(rule.styleSheet.cssRules)
            }
          } catch (error) {
            this._writingModeRulesIncomplete = true
          }
        }
      }
    }

    let sheets = (this.document && this.document.styleSheets) || []
    for (let i = 0; i < sheets.length; i++) {
      try {
        visitRules(sheets[i]!.cssRules)
      } catch (error) {
        this._writingModeRulesIncomplete = true
      }
    }

    return selectors
  }

  clearOrthogonalBlockSizing() {
    if (this.content && this._orthogonalBlockSizingApplied) {
      let marked = this.content.querySelectorAll(
        '[' + ORTHOGONAL_BLOCK_ATTRIBUTE + ']',
      )
      for (let i = 0; i < marked.length; i++) {
        marked[i]!.removeAttribute(ORTHOGONAL_BLOCK_ATTRIBUTE)
      }
    }

    this._orthogonalBlockSizingApplied = false
    this._orthogonalBlockLayoutSignature = undefined
    this.addStylesheetCss(' ', ORTHOGONAL_BLOCK_STYLE)
  }

  constrainOrthogonalBlocks(writingMode: string, availableInlineSize: number) {
    if (
      !this.content ||
      !this.window ||
      writingMode.indexOf('vertical') === 0
    ) {
      this.clearOrthogonalBlockSizing()
      return
    }

    let layoutSignature = writingMode + '|' + availableInlineSize
    if (this._orthogonalBlockLayoutSignature === layoutSignature) {
      return
    }

    let candidates = this._orthogonalWritingModeCandidates
    if (!candidates) {
      candidates = []
      let seen: Element[] = []
      let addMatches = (selector: string) => {
        let matches
        try {
          matches = this.content.querySelectorAll(selector)
        } catch (error) {
          return
        }

        for (let i = 0; i < matches.length; i++) {
          if (seen.indexOf(matches[i]!) === -1) {
            seen.push(matches[i]!)
            candidates!.push(matches[i]!)
          }
        }
      }

      addMatches('[style*="writing-mode"]')
      let selectors = this.writingModeRuleSelectors()
      for (let i = 0; i < selectors.length; i++) {
        addMatches(selectors[i]!)
      }
      if (this._writingModeRulesIncomplete) {
        addMatches('[class]')
      }
      this._orthogonalWritingModeCandidates = candidates
    }

    let applied = this._orthogonalBlockSizingApplied
    for (let i = 0; i < candidates.length; i++) {
      let element = candidates[i]!
      let parent = element.parentElement
      let style = this.window.getComputedStyle(element)
      let parentStyle = parent && this.window.getComputedStyle(parent)
      let mode =
        style.writingMode ||
        (style as CSSStyleDeclaration & { webkitWritingMode?: string })
          .webkitWritingMode ||
        ''
      let parentMode =
        (parentStyle &&
          (parentStyle.writingMode ||
            (
              parentStyle as CSSStyleDeclaration & {
                webkitWritingMode?: string
              }
            ).webkitWritingMode)) ||
        writingMode
      let blockLevel =
        style.display !== 'none' &&
        style.display !== 'contents' &&
        style.display.indexOf('inline') !== 0

      if (
        blockLevel &&
        mode.indexOf('vertical') === 0 &&
        parentMode.indexOf('vertical') !== 0
      ) {
        element.setAttribute(ORTHOGONAL_BLOCK_ATTRIBUTE, 'true')
        applied = true
      }
    }

    // Preserve the block's intrinsic vertical extent without inserting pages.
    // The resulting natural width must remain the pagination source of truth.
    this.addStylesheetCss(
      `
      [${ORTHOGONAL_BLOCK_ATTRIBUTE}] {
        inline-size: max-content !important;
        max-inline-size: ${availableInlineSize}px !important;
      }
      `,
      ORTHOGONAL_BLOCK_STYLE,
    )
    this._orthogonalBlockSizingApplied = applied
    this._orthogonalBlockLayoutSignature = layoutSignature
  }

  /**
   * Apply columns to the contents for pagination
   * @param {number} width
   * @param {number} height
   * @param {number} columnWidth
   * @param {number} gap
   */
  columns(
    width: number,
    height: number,
    columnWidth: number,
    gap: number,
    dir?: string | null,
  ) {
    let COLUMN_AXIS = prefixed('column-axis')
    let COLUMN_GAP = prefixed('column-gap')
    let COLUMN_WIDTH = prefixed('column-width')
    let COLUMN_FILL = prefixed('column-fill')
    let writingMode = this.writingMode()
    let verticalRtl = writingMode.indexOf('vertical-rl') === 0

    // Paginated reflowable content always advances across physical columns.
    // Writing mode controls glyph flow inside each column, not the page axis.
    let axis = 'horizontal'

    this.layoutStyle('paginated')
    this.addStylesheetCss(
      ':root { margin: 0 !important; }',
      PAGINATED_ROOT_STYLE,
    )
    this.constrainOrthogonalBlocks(writingMode, Math.max(height - 20, 1))

    if (dir === 'rtl' && !verticalRtl) {
      this.direction(dir)
    }

    this.setWidth(width)
    this.setHeight(height)

    // Deal with Mobile trying to scale to viewport
    this.viewport({ width: width, height: height, scale: 1.0, scalable: 'no' })

    this.documentElement.style.overflow = 'hidden'
    this.setCss('overflow', 'visible')
    this.setCss('margin', '0', true)

    this.setCss('padding-top', '10px')
    this.setCss('padding-bottom', '10px')
    this.setCss('padding-left', gap / 2 + 'px')
    this.setCss('padding-right', gap / 2 + 'px')
    this.setCss('box-sizing', 'border-box')
    this.setCss('max-width', 'inherit')

    this.setCss(COLUMN_FILL, 'auto')

    if (verticalRtl) {
      let rowHeight =
        width > columnWidth + gap ? columnWidth : Math.max(columnWidth - gap, 1)
      let supportsBlockDirectionColumns =
        this.window.CSS.supports('column-height', '1px') &&
        this.window.CSS.supports('column-wrap', 'wrap')

      if (supportsBlockDirectionColumns) {
        // CSS Multicol Level 2 maps column-width to the vertical inline size
        // and column-height to the horizontal block size. Wrapping rows in the
        // block direction creates real right-to-left physical pages.
        this.setCss(COLUMN_AXIS, null)
        this.setCss(COLUMN_WIDTH, Math.max(height - 20, 1) + 'px')
        this.setCss('column-height', rowHeight + 'px')
        this.setCss('column-count', '1')
        this.setCss('column-wrap', 'wrap')
        this.setCss(COLUMN_GAP, '0px')
        this.setCss('row-gap', gap + 'px')
      } else {
        // WebKit exposes the older column-axis extension instead of Multicol
        // Level 2. It produces the same horizontal physical page sequence.
        this.setCss(COLUMN_AXIS, 'horizontal')
        this.setCss(COLUMN_WIDTH, rowHeight + 'px')
        this.setCss(COLUMN_GAP, gap + 'px')
        this.setWidth(rowHeight + gap)
      }
    } else {
      this.setCss('column-height', null)
      this.setCss('column-count', null)
      this.setCss('column-wrap', null)
      this.setCss('row-gap', null)
      this.setCss(COLUMN_AXIS, axis)
      this.setCss(COLUMN_GAP, gap + 'px')
      this.setCss(COLUMN_WIDTH, columnWidth + 'px')
    }

    var pageBackgroundWidth =
      width > columnWidth + gap ? columnWidth + gap : columnWidth
    this.backgrounds.normalizePageBackgrounds(pageBackgroundWidth, height, dir)

    // Fix glyph clipping in WebKit
    // https://github.com/futurepress/epub.js/issues/983
    this.setCss('-webkit-line-box-contain', 'block glyphs replaced')
  }

  /**
   * Scale contents from center
   * @param {number} scale
   * @param {number} offsetX
   * @param {number} offsetY
   */
  scaler(scale: number, offsetX: number, offsetY: number) {
    var scaleStr = 'scale(' + scale + ')'
    var translateStr = ''
    this.setCss('transform-origin', 'top left')

    if (offsetX >= 0 || offsetY >= 0) {
      translateStr =
        ' translate(' + (offsetX || 0) + 'px, ' + (offsetY || 0) + 'px )'
    }

    this.setCss('transform', scaleStr + translateStr)
  }

  /**
   * Fit contents into a fixed width and height
   * @param {number} width
   * @param {number} height
   * @param {object} section
   * @param {string} fallbackViewport
   * @param {number} divisor
   * @param {string} spreadSlot
   */
  fit(
    width: number,
    height: number,
    section?: Section,
    fallbackViewport?: string | null,
    divisor?: number,
    spreadSlot?: string,
  ) {
    var viewport = this.viewport()
    if (
      (!viewport.width || !viewport.height) &&
      section &&
      section.type === 'image/svg+xml'
    ) {
      // SVG spine resources are parsed through srcdoc into a body wrapper.
      var svg = this.content && this.content.firstElementChild
      var viewBox =
        svg &&
        svg.namespaceURI === 'http://www.w3.org/2000/svg' &&
        svg.getAttribute('viewBox')
      var viewBoxValues =
        viewBox &&
        viewBox
          .trim()
          .split(/[\s,]+/)
          .map(Number)
      if (
        viewBoxValues &&
        viewBoxValues.length === 4 &&
        viewBoxValues[2]! > 0 &&
        viewBoxValues[3]! > 0
      ) {
        viewport = defaults(viewport, {
          width: viewBoxValues[2],
          height: viewBoxValues[3],
        })
      }
    }
    if (
      (!viewport.width || !viewport.height) &&
      section &&
      section.type &&
      section.type.indexOf('image/') === 0
    ) {
      var image = this.content && this.content.querySelector('img')
      if (image && image.naturalWidth > 0 && image.naturalHeight > 0) {
        viewport = defaults(viewport, {
          width: image.naturalWidth,
          height: image.naturalHeight,
        })
      }
    }
    if ((!viewport.width || !viewport.height) && fallbackViewport) {
      viewport = defaults(viewport, parseViewportContent(fallbackViewport))
    }
    var viewportWidth = parseInt(viewport.width as string)
    var viewportHeight = parseInt(viewport.height as string)
    var widthScale = width / viewportWidth
    var heightScale = height / viewportHeight
    var scale = widthScale < heightScale ? widthScale : heightScale

    // the translate does not work as intended, elements can end up unaligned
    // var offsetY = (height - (viewportHeight * scale)) / 2;
    // var offsetX = 0;
    // if (this.sectionIndex % 2 === 1) {
    // 	offsetX = width - (viewportWidth * scale);
    // }

    this.layoutStyle('paginated')

    // scale needs width and height to be set
    this.setWidth(viewportWidth)
    this.setHeight(viewportHeight)
    this.documentElement.style.overflow = 'hidden'
    this.setCss('overflow', 'hidden')

    // Scale to the correct size
    this.scaler(scale, 0, 0)
    // this.scaler(scale, offsetX > 0 ? offsetX : 0, offsetY);

    // background images are not scaled by transform
    this.setCss(
      'background-size',
      viewportWidth * scale + 'px ' + viewportHeight * scale + 'px',
    )

    this.setCss('background-color', 'transparent')

    var remainingWidth = Math.max(width - viewportWidth * scale, 0)
    var remainingHeight = Math.max(height - viewportHeight * scale, 0)
    var marginLeft = remainingWidth / 2
    if (divisor! > 1) {
      var slot = spreadSlot
      if (!slot && section) {
        if (section.properties.includes('page-spread-left')) {
          slot = 'left'
        } else if (section.properties.includes('page-spread-right')) {
          slot = 'right'
        }
      }

      if (slot === 'left') {
        marginLeft = remainingWidth
      } else if (slot === 'right') {
        marginLeft = 0
      }
    }
    this.setCss('margin-left', marginLeft + 'px')
    this.setCss('margin-top', remainingHeight / 2 + 'px')
  }

  /**
   * Set the direction of the text
   * @param {string} [dir="ltr"] "rtl" | "ltr"
   */
  direction(dir: string) {
    if (this.documentElement) {
      this.documentElement.style['direction'] = dir
    }
  }

  /**
   * Emit event when link in content is clicked
   * @private
   */
  linksHandler() {
    replaceLinks(this.content, (href, meta) => {
      this.emit(EVENTS.CONTENTS.LINK_CLICKED, href, meta)
    })
  }

  /**
   * Set the writingMode of the text
   * @param {string} [mode="horizontal-tb"] "horizontal-tb" | "vertical-rl" | "vertical-lr"
   * @param {string} [layoutName] "reflowable" | "pre-paginated"
   */
  writingMode(mode?: string, layoutName?: string) {
    let WRITING_MODE = prefixed('writing-mode')

    if (mode && this.documentElement) {
      ;(this.documentElement.style as unknown as Record<string, string>)[
        WRITING_MODE
      ] = mode
    }

    let readWritingMode = (element: Element | null) =>
      element
        ? (
            this.window.getComputedStyle(element) as unknown as Record<
              string,
              string
            >
          )[WRITING_MODE] || ''
        : ''
    let documentMode = readWritingMode(this.documentElement)
    if (mode || documentMode.indexOf('vertical') === 0) {
      return documentMode
    }

    let body = this.document && this.document.body
    let bodyMode = readWritingMode(body)
    if (bodyMode.indexOf('vertical') === 0) {
      return bodyMode
    }

    // A fixed-layout document owns an authored physical canvas. Descendant
    // writing modes describe content inside that canvas and must not
    // reclassify or reposition the document itself.
    if (layoutName === 'pre-paginated') {
      return bodyMode || documentMode
    }

    // Some EPUBs put writing-mode on one dominant wrapper instead of html or
    // body. Follow only the main text-bearing chain so a local vertical label
    // cannot reclassify an otherwise horizontal chapter.
    let current: Element | null = body
    for (let depth = 0; current && depth < 5; depth++) {
      let children = Array.prototype.slice.call(
        current.children || 0,
        0,
        16,
      ) as Element[]
      if (!children.length) break

      let parentLength = String(current.textContent || '').replace(
        /\s+/g,
        '',
      ).length
      let candidates = children.map((element) => ({
        element,
        length: String(element.textContent || '').replace(/\s+/g, '').length,
        mode: readWritingMode(element),
      }))
      let dominant = candidates.reduce<(typeof candidates)[number] | undefined>(
        (largest, candidate) =>
          !largest || candidate.length > largest.length ? candidate : largest,
        undefined,
      )
      let threshold = Math.max(parentLength * 0.5, 1)
      let vertical = candidates.find(
        (candidate) =>
          candidate.length >= threshold &&
          candidate.mode.indexOf('vertical') === 0,
      )
      if (vertical) return vertical.mode
      if (!dominant || dominant.length < threshold) break
      current = dominant.element
    }

    return bodyMode || documentMode
  }

  /**
   * Set the layoutStyle of the content
   * @param {string} [style="paginated"] "scrolling" | "paginated"
   * @private
   */
  layoutStyle(style?: string) {
    if (style) {
      this._layoutStyle = style
      ;(navigator as ReadingNavigator).epubReadingSystem.layoutStyle =
        this._layoutStyle
    }

    return this._layoutStyle || 'paginated'
  }

  /**
   * Add the epubReadingSystem object to the navigator
   * @param {string} name
   * @param {string} version
   * @private
   */
  epubReadingSystem(name: string, version: string) {
    ;(navigator as ReadingNavigator).epubReadingSystem = {
      name: name,
      version: version,
      layoutStyle: this.layoutStyle(),
      hasFeature: function (feature: string) {
        switch (feature) {
          case 'dom-manipulation':
            return true
          case 'layout-changes':
            return true
          case 'touch-events':
            return true
          case 'mouse-events':
            return true
          case 'keyboard-events':
            return true
          case 'spine-scripting':
            return false
          default:
            return false
        }
      },
    }
    return (navigator as ReadingNavigator).epubReadingSystem
  }

  destroy() {
    if (this.destroyed) return
    this.destroyed = true
    this.removeListeners()
    this.removeAllListeners()
    this.backgrounds.destroy()
  }
}

export default Contents
