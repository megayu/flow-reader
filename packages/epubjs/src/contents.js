import EventEmitter from './utils/event-emitter'

import EpubCFI from './epubcfi'
import Mapping from './mapping'
import { EPUBJS_VERSION, EVENTS, DOM_EVENTS } from './utils/constants'
import { isNumber, prefixed, borders, defaults } from './utils/core'
import { replaceLinks } from './utils/replacements'

const hasNavigator = typeof navigator !== 'undefined'

const isChrome = hasNavigator && /Chrome/.test(navigator.userAgent)
const isWebkit =
  hasNavigator && !isChrome && /AppleWebKit/.test(navigator.userAgent)

const ELEMENT_NODE = 1
const TEXT_NODE = 3
const PAGE_BACKGROUND_STYLE = 'page-background-normalize'
const PAGE_BACKGROUND_ATTRIBUTE = 'data-epubjs-page-background'
const PAGE_BACKGROUND_SOURCE_ATTRIBUTE = 'data-epubjs-page-background-source'
const SPREAD_BACKGROUND_STYLE = 'spread-background-fit'
const SPREAD_BACKGROUND_ATTRIBUTE = 'data-epubjs-spread-background-fit'
const SPREAD_BACKGROUND_SOURCE_ATTRIBUTE =
  'data-epubjs-spread-background-source'

/**
 * Handles DOM manipulation, queries and events for View contents
 * @class
 * @param {document} doc Document
 * @param {element} content Parent Element (typically Body)
 * @param {string} cfiBase Section component of CFIs
 * @param {number} sectionIndex Index in Spine of Conntent's Section
 */
class Contents {
  constructor(doc, content, cfiBase, sectionIndex) {
    // Blank Cfi for Parsing
    this.epubcfi = new EpubCFI()

    this.document = doc
    this.documentElement = this.document.documentElement
    this.content = content || this.document.body
    this.window = this.document.defaultView

    this._size = {
      width: 0,
      height: 0,
    }

    this.sectionIndex = sectionIndex || 0
    this.cfiBase = cfiBase || ''

    this.epubReadingSystem('epub.js', EPUBJS_VERSION)
    this.called = 0
    this.active = true
    this.listeners()
  }

  /**
   * Get DOM events that are listened for and passed along
   */
  static get listenedEvents() {
    return DOM_EVENTS
  }

  /**
   * Get or Set width
   * @param {number} [w]
   * @returns {number} width
   */
  width(w) {
    // var frame = this.documentElement;
    var frame = this.content

    if (w && isNumber(w)) {
      w = w + 'px'
    }

    if (w) {
      frame.style.width = w
      // this.content.style.width = w;
    }

    return parseInt(this.window.getComputedStyle(frame)['width'])
  }

  /**
   * Get or Set height
   * @param {number} [h]
   * @returns {number} height
   */
  height(h) {
    // var frame = this.documentElement;
    var frame = this.content

    if (h && isNumber(h)) {
      h = h + 'px'
    }

    if (h) {
      frame.style.height = h
      // this.content.style.height = h;
    }

    return parseInt(this.window.getComputedStyle(frame)['height'])
  }

  /**
   * Get or Set width of the contents
   * @param {number} [w]
   * @returns {number} width
   */
  contentWidth(w) {
    var content = this.content || this.document.body

    if (w && isNumber(w)) {
      w = w + 'px'
    }

    if (w) {
      content.style.width = w
    }

    return parseInt(this.window.getComputedStyle(content)['width'])
  }

  /**
   * Get or Set height of the contents
   * @param {number} [h]
   * @returns {number} height
   */
  contentHeight(h) {
    var content = this.content || this.document.body

    if (h && isNumber(h)) {
      h = h + 'px'
    }

    if (h) {
      content.style.height = h
    }

    return parseInt(this.window.getComputedStyle(content)['height'])
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
  overflow(overflow) {
    if (overflow) {
      this.documentElement.style.overflow = overflow
    }

    return this.window.getComputedStyle(this.documentElement)['overflow']
  }

  /**
   * Set overflowX css style of the documentElement
   * @param {string} [overflow]
   */
  overflowX(overflow) {
    if (overflow) {
      this.documentElement.style.overflowX = overflow
    }

    return this.window.getComputedStyle(this.documentElement)['overflowX']
  }

  /**
   * Set overflowY css style of the documentElement
   * @param {string} [overflow]
   */
  overflowY(overflow) {
    if (overflow) {
      this.documentElement.style.overflowY = overflow
    }

    return this.window.getComputedStyle(this.documentElement)['overflowY']
  }

  /**
   * Set Css styles on the contents element (typically Body)
   * @param {string} property
   * @param {string} value
   * @param {boolean} [priority] set as "important"
   */
  css(property, value, priority) {
    var content = this.content || this.document.body

    if (value) {
      content.style.setProperty(property, value, priority ? 'important' : '')
    } else {
      content.style.removeProperty(property)
    }

    return this.window.getComputedStyle(content)[property]
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
  viewport(options) {
    var _width, _height, _scale, _minimum, _maximum, _scalable
    // var width, height, scale, minimum, maximum, scalable;
    var $viewport = this.document.querySelector("meta[name='viewport']")
    var parsed = {
      width: undefined,
      height: undefined,
      scale: undefined,
      minimum: undefined,
      maximum: undefined,
      scalable: undefined,
    }
    var newContent = []
    var settings = {}

    /*
     * check for the viewport size
     * <meta name="viewport" content="width=1024,height=697" />
     */
    if ($viewport && $viewport.hasAttribute('content')) {
      let content = $viewport.getAttribute('content')
      let _width = content.match(/width\s*=\s*([^,]*)/)
      let _height = content.match(/height\s*=\s*([^,]*)/)
      let _scale = content.match(/initial-scale\s*=\s*([^,]*)/)
      let _minimum = content.match(/minimum-scale\s*=\s*([^,]*)/)
      let _maximum = content.match(/maximum-scale\s*=\s*([^,]*)/)
      let _scalable = content.match(/user-scalable\s*=\s*([^,]*)/)

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
      if (
        _scalable &&
        _scalable.length &&
        typeof _scalable[1] !== 'undefined'
      ) {
        parsed.scalable = _scalable[1]
      }
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
        this.document.querySelector('head').appendChild($viewport)
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
  listeners() {
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

    if (this.observer) {
      this.observer.disconnect()
    }

    clearTimeout(this.expanding)
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

  /**
   * Poll for resize detection
   * @private
   */
  resizeListeners() {
    var width, height
    // Test size again
    clearTimeout(this.expanding)
    requestAnimationFrame(this.resizeCheck.bind(this))
    this.expanding = setTimeout(this.resizeListeners.bind(this), 350)
  }

  /**
   * Listen for visibility of tab to change
   * @private
   */
  visibilityListeners() {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.active === false) {
        this.active = true
        this.resizeListeners()
      } else {
        this.active = false
        clearTimeout(this.expanding)
      }
    })
  }

  /**
   * Use css transitions to detect resize
   * @private
   */
  transitionListeners() {
    let body = this.content

    body.style['transitionProperty'] =
      'font, font-size, font-size-adjust, font-stretch, font-variation-settings, font-weight, width, height'
    body.style['transitionDuration'] = '0.001ms'
    body.style['transitionTimingFunction'] = 'linear'
    body.style['transitionDelay'] = '0'

    this._resizeCheck = this.resizeCheck.bind(this)
    this.document.addEventListener('transitionend', this._resizeCheck)
  }

  /**
   * Listen for media query changes and emit 'expand' event
   * Adapted from: https://github.com/tylergaw/media-query-events/blob/master/js/mq-events.js
   * @private
   */
  mediaQueryListeners() {
    var sheets = this.document.styleSheets
    var mediaChangeHandler = function (m) {
      if (m.matches && !this._expanding) {
        setTimeout(this.expand.bind(this), 1)
      }
    }.bind(this)

    for (var i = 0; i < sheets.length; i += 1) {
      var rules
      // Firefox errors if we access cssRules cross-domain
      try {
        rules = sheets[i].cssRules
      } catch (e) {
        return
      }
      if (!rules) return // Stylesheets changed
      for (var j = 0; j < rules.length; j += 1) {
        //if (rules[j].constructor === CSSMediaRule) {
        if (rules[j].media) {
          var mql = this.window.matchMedia(rules[j].media.mediaText)
          mql.addListener(mediaChangeHandler)
          //mql.onchange = mediaChangeHandler;
        }
      }
    }
  }

  /**
   * Use ResizeObserver to listen for changes in the DOM and check for resize
   * @private
   */
  resizeObservers() {
    // create an observer instance
    this.observer = new ResizeObserver((e) => {
      requestAnimationFrame(this.resizeCheck.bind(this))
    })

    // pass in the target node
    this.observer.observe(this.document.documentElement)
  }

  /**
   * Use MutationObserver to listen for changes in the DOM and check for resize
   * @private
   */
  mutationObservers() {
    // create an observer instance
    this.observer = new MutationObserver((mutations) => {
      this.resizeCheck()
    })

    // configuration of the observer:
    let config = {
      attributes: true,
      childList: true,
      characterData: true,
      subtree: true,
    }

    // pass in the target node, as well as the observer options
    this.observer.observe(this.document, config)
  }

  /**
   * Test if images are loaded or add listener for when they load
   * @private
   */
  imageLoadListeners() {
    var images = this.document.querySelectorAll('img')
    var img
    for (var i = 0; i < images.length; i++) {
      img = images[i]

      if (typeof img.naturalWidth !== 'undefined' && img.naturalWidth === 0) {
        img.onload = this.expand.bind(this)
      }
    }
  }

  /**
   * Listen for font load and check for resize when loaded
   * @private
   */
  fontLoadListeners() {
    if (!this.document || !this.document.fonts) {
      return
    }

    this.document.fonts.ready.then(
      function () {
        this.resizeCheck()
      }.bind(this),
    )
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
  locationOf(target, ignoreClass) {
    var position
    var targetPos = { left: 0, top: 0 }

    if (!this.document) return targetPos

    if (this.epubcfi.isCfiString(target)) {
      let range = new EpubCFI(target).toRange(this.document, ignoreClass)

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
            let pos = range.startContainer.textContent.indexOf(
              ' ',
              range.startOffset,
            )
            if (pos == -1) {
              pos = range.startContainer.textContent.length
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
          position = range.startContainer.getBoundingClientRect()
          targetPos.left = position.left
          targetPos.top = position.top
        } else {
          // Webkit does not handle collapsed range bounds correctly
          // https://bugs.webkit.org/show_bug.cgi?id=138949

          // Construct a new non-collapsed range
          if (isWebkit) {
            let container = range.startContainer
            let newRange = new Range()
            try {
              if (container.nodeType === ELEMENT_NODE) {
                position = container.getBoundingClientRect()
              } else if (range.startOffset + 2 < container.length) {
                newRange.setStart(container, range.startOffset)
                newRange.setEnd(container, range.startOffset + 2)
                position = newRange.getBoundingClientRect()
              } else if (range.startOffset - 2 > 0) {
                newRange.setStart(container, range.startOffset - 2)
                newRange.setEnd(container, range.startOffset)
                position = newRange.getBoundingClientRect()
              } else {
                // empty, return the parent element
                position = container.parentNode.getBoundingClientRect()
              }
            } catch (e) {
              console.error(e, e.stack)
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

    if (position) {
      targetPos.left = position.left
      targetPos.top = position.top
    }

    return targetPos
  }

  /**
   * Append a stylesheet link to the document head
   * @param {string} src url
   */
  addStylesheet(src) {
    return new Promise(
      function (resolve, reject) {
        var $stylesheet
        var ready = false

        if (!this.document) {
          resolve(false)
          return
        }

        // Check if link already exists
        $stylesheet = this.document.querySelector("link[href='" + src + "']")
        if ($stylesheet) {
          resolve(true)
          return // already present
        }

        $stylesheet = this.document.createElement('link')
        $stylesheet.type = 'text/css'
        $stylesheet.rel = 'stylesheet'
        $stylesheet.href = src
        $stylesheet.onload = $stylesheet.onreadystatechange = function () {
          if (!ready && (!this.readyState || this.readyState == 'complete')) {
            ready = true
            // Let apply
            setTimeout(() => {
              resolve(true)
            }, 1)
          }
        }

        this.document.head.appendChild($stylesheet)
      }.bind(this),
    )
  }

  _getStylesheetNode(key) {
    var styleEl
    key = 'epubjs-inserted-css-' + (key || '')

    if (!this.document) return false

    // Check if link already exists
    styleEl = this.document.getElementById(key)
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
  addStylesheetCss(serializedCss, key) {
    if (!this.document || !serializedCss) return false

    var styleEl
    styleEl = this._getStylesheetNode(key)
    styleEl.innerHTML = serializedCss

    return true
  }

  /**
   * Fit a single-page visual background to the real content page when
   * a reflowable spread adds a synthetic blank page.
   * @param {number} width
   * @param {number} height
   * @param {string} [direction="ltr"]
   */
  fitSpreadBackground(width, height, direction) {
    if (
      !this.document ||
      !this.documentElement ||
      !this.content ||
      !isNumber(width) ||
      !isNumber(height) ||
      width <= 0 ||
      height <= 0
    ) {
      this.clearSpreadBackgroundFit()
      return false
    }

    var alignRight = direction === 'rtl'
    var background =
      this._spreadBackgroundFit || this.findSpreadBackground(width, height)

    this.documentElement.setAttribute(SPREAD_BACKGROUND_ATTRIBUTE, 'true')
    this.content.setAttribute(SPREAD_BACKGROUND_ATTRIBUTE, 'true')

    if (this._spreadBackgroundSource) {
      this._spreadBackgroundSource.removeAttribute(
        SPREAD_BACKGROUND_SOURCE_ATTRIBUTE,
      )
      this._spreadBackgroundSource = undefined
    }

    if (background) {
      this._spreadBackgroundFit = background
      this._spreadBackgroundSource = background.element
      this._spreadBackgroundSource.setAttribute(
        SPREAD_BACKGROUND_SOURCE_ATTRIBUTE,
        'true',
      )

      this.content.style.setProperty(
        '--epubjs-spread-background-color',
        background.backgroundColor,
      )
      this.content.style.setProperty(
        '--epubjs-spread-background-image',
        background.backgroundImage,
      )
      this.content.style.setProperty(
        '--epubjs-spread-background-blend-mode',
        background.backgroundBlendMode,
      )
    } else {
      this._spreadBackgroundFit = undefined
      this.content.style.removeProperty('--epubjs-spread-background-color')
      this.content.style.removeProperty('--epubjs-spread-background-image')
      this.content.style.removeProperty('--epubjs-spread-background-blend-mode')
    }

    var css = `
      html[${SPREAD_BACKGROUND_ATTRIBUTE}],
      body[${SPREAD_BACKGROUND_ATTRIBUTE}],
      [${SPREAD_BACKGROUND_SOURCE_ATTRIBUTE}] {
        background-image: none !important;
        background-color: transparent !important;
      }

      [${SPREAD_BACKGROUND_SOURCE_ATTRIBUTE}]::before,
      [${SPREAD_BACKGROUND_SOURCE_ATTRIBUTE}]::after {
        background-image: none !important;
        background-color: transparent !important;
      }

      body[${SPREAD_BACKGROUND_ATTRIBUTE}] {
        position: relative !important;
        z-index: 0 !important;
      }

      body[${SPREAD_BACKGROUND_ATTRIBUTE}]::before {
        content: "" !important;
        position: fixed !important;
        top: 0 !important;
        right: ${alignRight ? '0' : 'auto'} !important;
        bottom: auto !important;
        left: ${alignRight ? 'auto' : '0'} !important;
        width: ${width}px !important;
        height: ${height}px !important;
        margin: 0 !important;
        padding: 0 !important;
        pointer-events: none !important;
        z-index: -1 !important;
        background-color: var(--epubjs-spread-background-color, transparent) !important;
        background-image: var(--epubjs-spread-background-image, none) !important;
        background-position: center center !important;
        background-size: contain !important;
        background-repeat: no-repeat !important;
        background-origin: border-box !important;
        background-clip: border-box !important;
        background-attachment: scroll !important;
        background-blend-mode: var(--epubjs-spread-background-blend-mode, normal) !important;
      }

      body[${SPREAD_BACKGROUND_ATTRIBUTE}] img,
      body[${SPREAD_BACKGROUND_ATTRIBUTE}] svg {
        max-width: ${width}px !important;
        max-height: ${height}px !important;
        object-fit: contain !important;
        break-inside: avoid !important;
        page-break-inside: avoid !important;
      }
    `

    this.addStylesheetCss(css, SPREAD_BACKGROUND_STYLE)
    return true
  }

  clearSpreadBackgroundFit() {
    if (!this.document) return false

    if (this.documentElement) {
      this.documentElement.removeAttribute(SPREAD_BACKGROUND_ATTRIBUTE)
    }

    if (this.content) {
      this.content.removeAttribute(SPREAD_BACKGROUND_ATTRIBUTE)
    }

    if (this._spreadBackgroundSource) {
      this._spreadBackgroundSource.removeAttribute(
        SPREAD_BACKGROUND_SOURCE_ATTRIBUTE,
      )
    }

    this._spreadBackgroundFit = undefined
    this._spreadBackgroundSource = undefined
    if (this.content) {
      this.content.style.removeProperty('--epubjs-spread-background-color')
      this.content.style.removeProperty('--epubjs-spread-background-image')
      this.content.style.removeProperty('--epubjs-spread-background-blend-mode')
    }
    this.addStylesheetCss(' ', SPREAD_BACKGROUND_STYLE)

    return true
  }

  normalizePageBackgrounds(width, height, direction) {
    if (
      !this.document ||
      !this.documentElement ||
      !this.content ||
      !isNumber(width) ||
      !isNumber(height) ||
      width <= 0 ||
      height <= 0
    ) {
      this.clearPageBackgroundNormalization()
      return false
    }

    this.restorePageBackgroundOverrides()

    this.documentElement.setAttribute(PAGE_BACKGROUND_ATTRIBUTE, 'true')
    this.content.setAttribute(PAGE_BACKGROUND_ATTRIBUTE, 'true')

    if (this._pageBackgroundSources) {
      this._pageBackgroundSources.forEach((element) => {
        element.removeAttribute(PAGE_BACKGROUND_SOURCE_ATTRIBUTE)
      })
    }

    var backgrounds = this.findPageBackgrounds(width, height)
    var hasReadableText = this.hasReadableTextContent()
    this._readablePageBackgrounds = hasReadableText
      ? backgrounds.map((background) => ({
          element: background.element,
          backgroundImage: background.computed.backgroundImage,
        }))
      : undefined
    this._pageBackgroundSources = backgrounds.map((background) => {
      background.element.setAttribute(PAGE_BACKGROUND_SOURCE_ATTRIBUTE, 'true')
      return background.element
    })

    var css = `
      html[${PAGE_BACKGROUND_ATTRIBUTE}],
      body[${PAGE_BACKGROUND_ATTRIBUTE}],
      [${PAGE_BACKGROUND_SOURCE_ATTRIBUTE}] {
        background-color: transparent !important;
      }
    `

    this.addStylesheetCss(css, PAGE_BACKGROUND_STYLE)

    this._pageBackgroundVersion = (this._pageBackgroundVersion || 0) + 1
    var version = this._pageBackgroundVersion

    backgrounds.forEach((background) => {
      if (hasReadableText) {
        this.fillPageBackground(background, width, height, width, direction)
      } else {
        this.fitOversizedPageBackground(background, width, height, version)
      }
    })

    return true
  }

  clearPageBackgroundNormalization() {
    if (!this.document) return false

    this.restorePageBackgroundOverrides()
    this._pageBackgroundVersion = (this._pageBackgroundVersion || 0) + 1

    if (this.documentElement) {
      this.documentElement.removeAttribute(PAGE_BACKGROUND_ATTRIBUTE)
    }

    if (this.content) {
      this.content.removeAttribute(PAGE_BACKGROUND_ATTRIBUTE)
    }

    if (this._pageBackgroundSources) {
      this._pageBackgroundSources.forEach((element) => {
        element.removeAttribute(PAGE_BACKGROUND_SOURCE_ATTRIBUTE)
      })
    }

    this._pageBackgroundSources = undefined
    this._readablePageBackgrounds = undefined
    this.addStylesheetCss(' ', PAGE_BACKGROUND_STYLE)

    return true
  }

  restorePageBackgroundOverrides() {
    if (!this._pageBackgroundOverrides) return

    this._pageBackgroundOverrides.forEach((override) => {
      if (!override.element) return

      if (override.value) {
        override.element.style.setProperty(
          override.property,
          override.value,
          override.priority,
        )
      } else {
        override.element.style.removeProperty(override.property)
      }
    })

    this._pageBackgroundOverrides = undefined
  }

  hasReadableTextContent() {
    if (!this.document || !this.content) return false

    var nodeFilter = this.window && this.window.NodeFilter
    if (!nodeFilter || !this.document.createTreeWalker) return false

    var ignoredParents = {
      SCRIPT: true,
      STYLE: true,
      NOSCRIPT: true,
      TEMPLATE: true,
    }
    var walker = this.document.createTreeWalker(
      this.content,
      nodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          var parent = node.parentElement
          while (parent) {
            if (
              ignoredParents[parent.tagName] ||
              parent.hidden ||
              parent.getAttribute('aria-hidden') === 'true'
            ) {
              return nodeFilter.FILTER_REJECT
            }

            var style = node.ownerDocument.defaultView.getComputedStyle(parent)
            if (
              style &&
              (style.display === 'none' || style.visibility === 'hidden')
            ) {
              return nodeFilter.FILTER_REJECT
            }
            parent = parent.parentElement
          }

          return node.data && node.data.trim().length > 0
            ? nodeFilter.FILTER_ACCEPT
            : nodeFilter.FILTER_REJECT
        },
      },
      false,
    )

    return Boolean(walker.nextNode())
  }

  findPageBackgrounds(width, height) {
    if (!this.window || !this.content) return []

    var targets = [this.documentElement, this.content]
    var children = this.content.children || []

    for (var i = 0; i < children.length; i++) {
      targets.push(children[i])
    }

    var backgrounds = []

    for (i = 0; i < targets.length; i++) {
      var element = targets[i]
      if (!element) continue

      var computed = this.window.getComputedStyle(element)
      if (
        !computed ||
        !computed.backgroundImage ||
        computed.backgroundImage === 'none'
      ) {
        continue
      }

      var rect = element.getBoundingClientRect()
      var area = Math.max(rect.width, 0) * Math.max(rect.height, 0)
      var isRoot = element === this.content || element === this.documentElement
      var isPageSized =
        rect.width >= width * 0.45 &&
        rect.height >= height * 0.25 &&
        area >= width * height * 0.15

      if (!isRoot && !isPageSized) continue

      backgrounds.push({
        element,
        computed,
        isRoot,
      })
    }

    return backgrounds
  }

  fitOversizedPageBackground(background, width, height, version) {
    var computed = background.computed
    var imageUrl = this.backgroundImageUrl(computed.backgroundImage)

    if (
      !imageUrl ||
      this.hasMultipleBackgroundImages(computed.backgroundImage)
    ) {
      return
    }

    this.setPageBackgroundProperty(
      background.element,
      'background-repeat',
      'no-repeat',
    )
    this.setPageBackgroundProperty(
      background.element,
      'background-position',
      'center center',
    )
    this.setPageBackgroundProperty(
      background.element,
      'background-attachment',
      'scroll',
    )

    this.backgroundImageSize(imageUrl, (imageSize) => {
      if (
        !imageSize ||
        !this.document ||
        this._pageBackgroundVersion !== version
      ) {
        return
      }

      var nextSize = this.nextPageBackgroundSize(
        background,
        imageSize,
        width,
        height,
      )

      if (!nextSize) return

      this.setPageBackgroundSize(background.element, nextSize)
    })
  }

  fillPageBackground(background, width, height, totalWidth, direction) {
    var computed = background.computed
    if (
      !computed ||
      !this.backgroundImageUrl(computed.backgroundImage) ||
      this.hasMultipleBackgroundImages(computed.backgroundImage)
    ) {
      return
    }

    this.setPageBackgroundLayers(
      background.element,
      computed.backgroundImage,
      width,
      height,
      totalWidth,
      direction,
    )
  }

  fillReadablePageBackgrounds(width, height, totalWidth, direction) {
    if (
      !this._readablePageBackgrounds ||
      !isNumber(width) ||
      !isNumber(height) ||
      !isNumber(totalWidth) ||
      width <= 0 ||
      height <= 0 ||
      totalWidth <= 0
    ) {
      return false
    }

    this._readablePageBackgrounds.forEach((background) => {
      this.setPageBackgroundLayers(
        background.element,
        background.backgroundImage,
        width,
        height,
        totalWidth,
        direction,
      )
    })

    return true
  }

  setPageBackgroundLayers(
    element,
    backgroundImage,
    width,
    height,
    totalWidth,
    direction,
  ) {
    if (!element || !backgroundImage) return

    var pageCount = Math.max(1, Math.ceil(totalWidth / width))
    var pageSize = `${Math.round(width)}px ${Math.round(height)}px`
    var images = []
    var sizes = []
    var repeats = []
    var positions = []
    var attachments = []

    for (var i = 0; i < pageCount; i++) {
      images.push(backgroundImage)
      sizes.push(pageSize)
      repeats.push('no-repeat')
      attachments.push('scroll')
      positions.push(
        direction === 'rtl'
          ? `right ${Math.round(i * width)}px top 0px`
          : `${Math.round(i * width)}px top`,
      )
    }

    this.setPageBackgroundProperty(
      element,
      'background-image',
      images.join(', '),
    )
    this.setPageBackgroundProperty(element, 'background-size', sizes.join(', '))
    this.setPageBackgroundProperty(
      element,
      'background-repeat',
      repeats.join(', '),
    )
    this.setPageBackgroundProperty(
      element,
      'background-position',
      positions.join(', '),
    )
    this.setPageBackgroundProperty(
      element,
      'background-attachment',
      attachments.join(', '),
    )
  }

  nextPageBackgroundSize(background, imageSize, width, height) {
    var element = background.element
    var computed = this.window.getComputedStyle(element)
    var rect = element.getBoundingClientRect()
    var boxWidth = background.isRoot
      ? width
      : Math.min(rect.width || width, width)
    var boxHeight = background.isRoot
      ? height
      : Math.min(rect.height || height, height)

    if (boxWidth <= 0 || boxHeight <= 0) return undefined

    var size = this.resolveBackgroundSize(
      computed.backgroundSize,
      imageSize,
      boxWidth,
      boxHeight,
    )

    if (!size) return undefined

    if (
      size.overflow ||
      (background.isRoot && (size.usesPagePercent || size.usesPageBox))
    ) {
      return `${Math.round(size.width)}px ${Math.round(size.height)}px`
    }

    return undefined
  }

  resolveBackgroundSize(backgroundSize, imageSize, boxWidth, boxHeight) {
    var layer = this.firstBackgroundLayer(backgroundSize || 'auto')
    if (!layer) return undefined

    var normalized = layer.trim().toLowerCase()
    var naturalWidth = imageSize.width
    var naturalHeight = imageSize.height
    var ratio = naturalHeight / naturalWidth

    if (normalized === 'cover' || normalized === 'contain') {
      var scale =
        normalized === 'cover'
          ? Math.max(boxWidth / naturalWidth, boxHeight / naturalHeight)
          : Math.min(boxWidth / naturalWidth, boxHeight / naturalHeight)
      var width = naturalWidth * scale
      var height = naturalHeight * scale

      if (normalized === 'cover') {
        scale = Math.min(boxWidth / naturalWidth, boxHeight / naturalHeight)
        return {
          width: naturalWidth * scale,
          height: naturalHeight * scale,
          overflow: width > boxWidth + 1 || height > boxHeight + 1,
        }
      }

      return { width, height, overflow: false, usesPageBox: true }
    }

    var tokens = normalized.split(/\s+/).filter(Boolean)
    if (tokens.length === 0 || tokens.length > 2) return undefined
    if (tokens.length === 1) tokens.push('auto')

    var widthValue = this.resolveBackgroundSizeToken(tokens[0], boxWidth)
    var heightValue = this.resolveBackgroundSizeToken(tokens[1], boxHeight)

    if (widthValue === undefined || heightValue === undefined) return undefined

    var usesPagePercent = widthValue.percent || heightValue.percent
    var displayWidth = widthValue.value
    var displayHeight = heightValue.value

    if (displayWidth === undefined && displayHeight === undefined) {
      displayWidth = naturalWidth
      displayHeight = naturalHeight
    } else if (displayWidth === undefined) {
      displayWidth = displayHeight / ratio
    } else if (displayHeight === undefined) {
      displayHeight = displayWidth * ratio
    }

    if (displayWidth <= 0 || displayHeight <= 0) return undefined

    if (displayWidth > boxWidth + 1 || displayHeight > boxHeight + 1) {
      var fitScale = Math.min(
        boxWidth / displayWidth,
        boxHeight / displayHeight,
      )
      return {
        width: displayWidth * fitScale,
        height: displayHeight * fitScale,
        overflow: true,
        usesPagePercent,
      }
    }

    return {
      width: displayWidth,
      height: displayHeight,
      overflow: false,
      usesPagePercent,
    }
  }

  resolveBackgroundSizeToken(token, basis) {
    if (!token || token === 'auto') return { value: undefined, percent: false }

    if (token.endsWith('%')) {
      var percent = parseFloat(token)
      if (!isFinite(percent)) return undefined
      return { value: (basis * percent) / 100, percent: true }
    }

    if (token.endsWith('px')) {
      var px = parseFloat(token)
      if (!isFinite(px)) return undefined
      return { value: px, percent: false }
    }

    return undefined
  }

  firstBackgroundLayer(value) {
    var depth = 0
    var quote

    for (var i = 0; i < value.length; i++) {
      var char = value[i]

      if (quote) {
        if (char === quote && value[i - 1] !== '\\') quote = undefined
        continue
      }

      if (char === '"' || char === "'") {
        quote = char
      } else if (char === '(') {
        depth++
      } else if (char === ')') {
        depth--
      } else if (char === ',' && depth === 0) {
        return value.slice(0, i)
      }
    }

    return value
  }

  backgroundImageUrl(value) {
    var match = /url\((?:"([^"]+)"|'([^']+)'|([^)]*))\)/.exec(value || '')
    if (!match) return undefined
    return (match[1] || match[2] || match[3] || '').trim()
  }

  hasMultipleBackgroundImages(value) {
    if (!value) return false
    var first = this.firstBackgroundLayer(value)
    return first.length < value.length
  }

  backgroundImageSize(url, callback) {
    this._backgroundImageSizes = this._backgroundImageSizes || {}

    if (this._backgroundImageSizes[url]) {
      callback(this._backgroundImageSizes[url])
      return
    }

    var image = new this.window.Image()
    image.onload = () => {
      var size = {
        width: image.naturalWidth || image.width,
        height: image.naturalHeight || image.height,
      }

      if (size.width > 0 && size.height > 0) {
        this._backgroundImageSizes[url] = size
        callback(size)
      }
    }
    image.onerror = () => callback(undefined)
    image.src = url
  }

  setPageBackgroundSize(element, value) {
    this.setPageBackgroundProperty(element, 'background-size', value)
  }

  setPageBackgroundProperty(element, property, value) {
    this._pageBackgroundOverrides = this._pageBackgroundOverrides || []

    var existing = this._pageBackgroundOverrides.find(
      (override) =>
        override.element === element && override.property === property,
    )

    if (!existing) {
      this._pageBackgroundOverrides.push({
        element,
        property,
        value: element.style.getPropertyValue(property),
        priority: element.style.getPropertyPriority(property),
      })
    }

    element.style.setProperty(property, value, 'important')
  }

  findSpreadBackground(width, height) {
    if (!this.window || !this.content) return undefined

    var targets = [this.content, this.documentElement]
    var descendants = this.content.querySelectorAll('*')

    for (var i = 0; i < descendants.length; i++) {
      targets.push(descendants[i])
    }

    var match
    var matchScore = 0

    for (i = 0; i < targets.length; i++) {
      var target = targets[i]
      if (!target) continue

      var styles = [
        this.window.getComputedStyle(target),
        this.window.getComputedStyle(target, '::before'),
        this.window.getComputedStyle(target, '::after'),
      ]

      for (var j = 0; j < styles.length; j++) {
        var computed = styles[j]
        if (
          !computed ||
          !computed.backgroundImage ||
          computed.backgroundImage === 'none'
        ) {
          continue
        }

        var rect = target.getBoundingClientRect()
        var area = Math.max(rect.width, 0) * Math.max(rect.height, 0)
        var isRoot = target === this.content || target === this.documentElement
        var isPageSized =
          rect.width >= width * 0.45 &&
          rect.height >= height * 0.25 &&
          area >= width * height * 0.15

        if (!isRoot && !isPageSized) continue

        var score = area + (isRoot ? width * height : 0)
        if (score <= matchScore) continue

        matchScore = score
        match = {
          element: target,
          backgroundColor: computed.backgroundColor,
          backgroundImage: computed.backgroundImage,
          backgroundBlendMode: computed.backgroundBlendMode,
        }
      }
    }

    return match
  }

  /**
   * Append stylesheet rules to a generate stylesheet
   * Array: https://developer.mozilla.org/en-US/docs/Web/API/CSSStyleSheet/insertRule
   * Object: https://github.com/desirable-objects/json-to-css
   * @param {array | object} rules
   * @param {string} key If the key is the same, the CSS will be replaced instead of inserted
   */
  addStylesheetRules(rules, key) {
    var styleSheet

    if (!this.document || !rules || rules.length === 0) return

    // Grab style sheet
    styleSheet = this._getStylesheetNode(key).sheet

    if (Object.prototype.toString.call(rules) === '[object Array]') {
      for (var i = 0, rl = rules.length; i < rl; i++) {
        var j = 1,
          rule = rules[i],
          selector = rules[i][0],
          propStr = ''
        // If the second argument of a rule is an array of arrays, correct our variables.
        if (Object.prototype.toString.call(rule[1][0]) === '[object Array]') {
          rule = rule[1]
          j = 0
        }

        for (var pl = rule.length; j < pl; j++) {
          var prop = rule[j]
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
        const definition = rules[selector]
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
   * Append a script tag to the document head
   * @param {string} src url
   * @returns {Promise} loaded
   */
  addScript(src) {
    return new Promise(
      function (resolve, reject) {
        var $script
        var ready = false

        if (!this.document) {
          resolve(false)
          return
        }

        $script = this.document.createElement('script')
        $script.type = 'text/javascript'
        $script.async = true
        $script.src = src
        $script.onload = $script.onreadystatechange = function () {
          if (!ready && (!this.readyState || this.readyState == 'complete')) {
            ready = true
            setTimeout(function () {
              resolve(true)
            }, 1)
          }
        }

        this.document.head.appendChild($script)
      }.bind(this),
    )
  }

  /**
   * Add a class to the contents container
   * @param {string} className
   */
  addClass(className) {
    var content

    if (!this.document) return

    content = this.content || this.document.body

    if (content) {
      content.classList.add(className)
    }
  }

  /**
   * Remove a class from the contents container
   * @param {string} removeClass
   */
  removeClass(className) {
    var content

    if (!this.document) return

    content = this.content || this.document.body

    if (content) {
      content.classList.remove(className)
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

    DOM_EVENTS.forEach(function (eventName) {
      this.document.addEventListener(eventName, this._triggerEvent, {
        passive: true,
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
    DOM_EVENTS.forEach(function (eventName) {
      this.document.removeEventListener(eventName, this._triggerEvent, {
        passive: true,
      })
    }, this)
    this._triggerEvent = undefined
  }

  /**
   * Emit passed browser events
   * @private
   */
  triggerEvent(e) {
    this.emit(e.type, e)
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
      this._onSelectionChange,
      { passive: true },
    )
    this._onSelectionChange = undefined
  }

  /**
   * Handle getting text on selection
   * @private
   */
  onSelectionChange(e) {
    if (this.selectionEndTimeout) {
      clearTimeout(this.selectionEndTimeout)
    }
    this.selectionEndTimeout = setTimeout(
      function () {
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
  triggerSelectedEvent(selection) {
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
  range(_cfi, ignoreClass) {
    var cfi = new EpubCFI(_cfi)
    return cfi.toRange(this.document, ignoreClass)
  }

  /**
   * Get an EpubCFI from a Dom Range
   * @param {Range} range
   * @param {string} [ignoreClass]
   * @returns {EpubCFI} cfi
   */
  cfiFromRange(range, ignoreClass) {
    return new EpubCFI(range, this.cfiBase, ignoreClass).toString()
  }

  /**
   * Get an EpubCFI from a Dom node
   * @param {node} node
   * @param {string} [ignoreClass]
   * @returns {EpubCFI} cfi
   */
  cfiFromNode(node, ignoreClass) {
    return new EpubCFI(node, this.cfiBase, ignoreClass).toString()
  }

  // TODO: find where this is used - remove?
  map(layout) {
    var map = new Mapping(layout)
    return map.section()
  }

  /**
   * Size the contents to a given width and height
   * @param {number} [width]
   * @param {number} [height]
   */
  size(width, height) {
    var viewport = { scale: 1.0, scalable: 'no' }

    this.layoutStyle('scrolling')

    if (width >= 0) {
      this.width(width)
      viewport.width = width
      this.css('padding', '0 ' + width / 12 + 'px')
    }

    if (height >= 0) {
      this.height(height)
      viewport.height = height
    }

    this.css('margin', '0')
    this.css('box-sizing', 'border-box')

    if (isNumber(width) && isNumber(height) && width >= 0 && height >= 0) {
      this.normalizePageBackgrounds(width, height)
    } else {
      this.clearPageBackgroundNormalization()
    }

    this.viewport(viewport)
  }

  /**
   * Apply columns to the contents for pagination
   * @param {number} width
   * @param {number} height
   * @param {number} columnWidth
   * @param {number} gap
   */
  columns(width, height, columnWidth, gap, dir) {
    let COLUMN_AXIS = prefixed('column-axis')
    let COLUMN_GAP = prefixed('column-gap')
    let COLUMN_WIDTH = prefixed('column-width')
    let COLUMN_FILL = prefixed('column-fill')

    let writingMode = this.writingMode()
    let axis = writingMode.indexOf('vertical') === 0 ? 'vertical' : 'horizontal'

    this.layoutStyle('paginated')

    if (dir === 'rtl' && axis === 'horizontal') {
      this.direction(dir)
    }

    this.width(width)
    this.height(height)

    // Deal with Mobile trying to scale to viewport
    this.viewport({ width: width, height: height, scale: 1.0, scalable: 'no' })

    // TODO: inline-block needs more testing
    // Fixes Safari column cut offs, but causes RTL issues
    // this.css("display", "inline-block");

    this.overflow('hidden')
    this.css('overflow', 'visible')
    this.css('margin', '0', true)

    if (axis === 'vertical') {
      this.css('padding-top', gap / 2 + 'px')
      this.css('padding-bottom', gap / 2 + 'px')
      this.css('padding-left', '10px')
      this.css('padding-right', '10px')
      this.css(COLUMN_AXIS, 'vertical')
    } else {
      this.css('padding-top', '10px')
      this.css('padding-bottom', '10px')
      this.css('padding-left', gap / 2 + 'px')
      this.css('padding-right', gap / 2 + 'px')
      this.css(COLUMN_AXIS, 'horizontal')
    }

    this.css('box-sizing', 'border-box')
    this.css('max-width', 'inherit')

    this.css(COLUMN_FILL, 'auto')

    this.css(COLUMN_GAP, gap + 'px')
    this.css(COLUMN_WIDTH, columnWidth + 'px')

    var pageBackgroundWidth =
      axis === 'horizontal' && width > columnWidth + gap
        ? columnWidth + gap
        : columnWidth
    this.normalizePageBackgrounds(pageBackgroundWidth, height, dir)

    // Fix glyph clipping in WebKit
    // https://github.com/futurepress/epub.js/issues/983
    this.css('-webkit-line-box-contain', 'block glyphs replaced')
  }

  /**
   * Scale contents from center
   * @param {number} scale
   * @param {number} offsetX
   * @param {number} offsetY
   */
  scaler(scale, offsetX, offsetY) {
    var scaleStr = 'scale(' + scale + ')'
    var translateStr = ''
    // this.css("position", "absolute"));
    this.css('transform-origin', 'top left')

    if (offsetX >= 0 || offsetY >= 0) {
      translateStr =
        ' translate(' + (offsetX || 0) + 'px, ' + (offsetY || 0) + 'px )'
    }

    this.css('transform', scaleStr + translateStr)
  }

  /**
   * Fit contents into a fixed width and height
   * @param {number} width
   * @param {number} height
   */
  fit(width, height, section) {
    var viewport = this.viewport()
    var viewportWidth = parseInt(viewport.width)
    var viewportHeight = parseInt(viewport.height)
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
    this.width(viewportWidth)
    this.height(viewportHeight)
    this.overflow('hidden')

    // Scale to the correct size
    this.scaler(scale, 0, 0)
    // this.scaler(scale, offsetX > 0 ? offsetX : 0, offsetY);

    // background images are not scaled by transform
    this.css(
      'background-size',
      viewportWidth * scale + 'px ' + viewportHeight * scale + 'px',
    )

    this.css('background-color', 'transparent')
    if (section && section.properties.includes('page-spread-left')) {
      // set margin since scale is weird
      var marginLeft = width - viewportWidth * scale
      this.css('margin-left', marginLeft + 'px')
    }
  }

  /**
   * Set the direction of the text
   * @param {string} [dir="ltr"] "rtl" | "ltr"
   */
  direction(dir) {
    if (this.documentElement) {
      this.documentElement.style['direction'] = dir
    }
  }

  mapPage(cfiBase, layout, start, end, dev) {
    var mapping = new Mapping(layout, dev)

    return mapping.page(this, cfiBase, start, end)
  }

  /**
   * Emit event when link in content is clicked
   * @private
   */
  linksHandler() {
    replaceLinks(this.content, (href) => {
      this.emit(EVENTS.CONTENTS.LINK_CLICKED, href)
    })
  }

  /**
   * Set the writingMode of the text
   * @param {string} [mode="horizontal-tb"] "horizontal-tb" | "vertical-rl" | "vertical-lr"
   */
  writingMode(mode) {
    let WRITING_MODE = prefixed('writing-mode')

    if (mode && this.documentElement) {
      this.documentElement.style[WRITING_MODE] = mode
    }

    return (
      this.window.getComputedStyle(this.documentElement)[WRITING_MODE] || ''
    )
  }

  /**
   * Set the layoutStyle of the content
   * @param {string} [style="paginated"] "scrolling" | "paginated"
   * @private
   */
  layoutStyle(style) {
    if (style) {
      this._layoutStyle = style
      navigator.epubReadingSystem.layoutStyle = this._layoutStyle
    }

    return this._layoutStyle || 'paginated'
  }

  /**
   * Add the epubReadingSystem object to the navigator
   * @param {string} name
   * @param {string} version
   * @private
   */
  epubReadingSystem(name, version) {
    navigator.epubReadingSystem = {
      name: name,
      version: version,
      layoutStyle: this.layoutStyle(),
      hasFeature: function (feature) {
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
    return navigator.epubReadingSystem
  }

  destroy() {
    // this.document.removeEventListener('transitionend', this._resizeCheck);

    this.removeListeners()
  }
}

EventEmitter(Contents.prototype)

export default Contents
