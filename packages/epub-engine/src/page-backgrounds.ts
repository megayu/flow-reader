import type { LegacyWindow } from './utils/core'

type Size = { width: number; height: number }
type StyledElement = HTMLElement | SVGElement
type Background = {
  element: StyledElement
  computed: CSSStyleDeclaration
  isRoot: boolean
  hasAuthoredConstraints?: boolean
}
type NestedCssRule = CSSRule & Partial<CSSStyleRule & CSSMediaRule>
type ResolvedSize = Size & {
  overflow: boolean
  usesPagePercent?: boolean
  usesPageBox?: boolean
}

import { isNumber } from './utils/core'

const PAGE_BACKGROUND_CONSTRAINT_PROPERTIES = [
  'background-size',
  'background-repeat',
  'background-position',
  'background-position-x',
  'background-position-y',
  'background-attachment',
]

/** Owns background adaptation, original styles and pending image loads for one document. */
export default class PageBackgrounds {
  declare document: Document
  declare documentElement: HTMLElement
  declare content: HTMLElement
  declare window: LegacyWindow
  declare pendingImages: Set<HTMLImageElement>
  declare _readablePageBackgrounds:
    | { element: StyledElement; backgroundImage: string }[]
    | undefined
  declare _pageBackgroundVersion: number | undefined
  declare _pageBackgroundOverrides:
    | Map<StyledElement, Map<string, { value: string; priority: string }>>
    | undefined
  declare _backgroundImageSizes: Record<string, Size> | undefined

  constructor(document: Document, content: HTMLElement) {
    this.document = document
    this.documentElement = document.documentElement
    this.content = content
    this.window = document.defaultView as LegacyWindow
    this.pendingImages = new Set()
  }

  normalizePageBackgrounds(
    width: number,
    height: number,
    direction?: string | null,
  ) {
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

    var backgrounds = this.findPageBackgrounds(width, height)
    var backgroundColors = new Map<StyledElement, CSSStyleDeclaration>()
    backgrounds.forEach((background) => {
      backgroundColors.set(background.element, background.computed)
    })
    if (!backgroundColors.has(this.documentElement)) {
      backgroundColors.set(
        this.documentElement,
        this.window.getComputedStyle(this.documentElement),
      )
    }
    if (!backgroundColors.has(this.content)) {
      backgroundColors.set(
        this.content,
        this.window.getComputedStyle(this.content),
      )
    }
    backgroundColors.forEach((computed, element) => {
      if (
        computed.backgroundColor === 'rgb(255, 255, 255)' ||
        computed.backgroundColor === 'rgba(255, 255, 255, 1)'
      ) {
        this.setPageBackgroundProperty(
          element,
          'background-color',
          'transparent',
        )
      }
    })

    var hasReadableText = this.hasReadableTextContent()
    if (hasReadableText) {
      backgrounds.forEach((background) => {
        background.hasAuthoredConstraints =
          this.hasAuthoredPageBackgroundConstraints(background.element)
      })
    }

    this._readablePageBackgrounds = hasReadableText
      ? backgrounds
          .filter((background) => !background.hasAuthoredConstraints)
          .map((background) => ({
            element: background.element,
            backgroundImage: background.computed.backgroundImage,
          }))
      : undefined
    this._pageBackgroundVersion = (this._pageBackgroundVersion || 0) + 1
    var version = this._pageBackgroundVersion

    backgrounds.forEach((background) => {
      if (hasReadableText) {
        if (!background.hasAuthoredConstraints) {
          this.fillPageBackground(background, width, height, width, direction)
        }
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

    this._readablePageBackgrounds = undefined!

    return true
  }

  restorePageBackgroundOverrides() {
    if (!this._pageBackgroundOverrides) return

    this._pageBackgroundOverrides.forEach((properties, element) => {
      for (const [property, original] of properties) {
        if (original.value) {
          element.style.setProperty(property, original.value, original.priority)
        } else {
          element.style.removeProperty(property)
        }
      }
    })

    this._pageBackgroundOverrides = undefined!
  }

  hasReadableTextContent() {
    if (!this.document || !this.content) return false

    var nodeFilter = this.window && this.window.NodeFilter
    if (!nodeFilter || !this.document.createTreeWalker) return false

    var ignoredParents: Record<string, boolean> = {
      SCRIPT: true,
      STYLE: true,
      NOSCRIPT: true,
      TEMPLATE: true,
    }
    var walker = (
      this.document.createTreeWalker as (
        root: Node,
        mask: number,
        filter: NodeFilter,
        expand: boolean,
      ) => TreeWalker
    )(
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

            var style =
              node.ownerDocument!.defaultView!.getComputedStyle(parent)
            if (
              style &&
              (style.display === 'none' || style.visibility === 'hidden')
            ) {
              return nodeFilter.FILTER_REJECT
            }
            parent = parent.parentElement
          }

          return (node as Text).data && (node as Text).data.trim().length > 0
            ? nodeFilter.FILTER_ACCEPT
            : nodeFilter.FILTER_REJECT
        },
      },
      false,
    )

    return Boolean(walker.nextNode())
  }

  findPageBackgrounds(width: number, height: number) {
    if (!this.window || !this.content) return []

    var targets: StyledElement[] = [this.documentElement, this.content]
    var children = this.content.children || []

    for (var i = 0; i < children.length; i++) {
      targets.push(children[i] as StyledElement)
    }

    var backgrounds: Background[] = []

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

  fitOversizedPageBackground(
    background: Background,
    width: number,
    height: number,
    version: number,
  ) {
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

  fillPageBackground(
    background: Background,
    width: number,
    height: number,
    totalWidth: number,
    direction?: string | null,
  ) {
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

  fillReadablePageBackgrounds(
    width: number,
    height: number,
    totalWidth: number,
    direction?: string | null,
  ) {
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
    element: StyledElement,
    backgroundImage: string,
    width: number,
    height: number,
    totalWidth: number,
    direction?: string | null,
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

  nextPageBackgroundSize(
    background: Background,
    imageSize: Size,
    width: number,
    height: number,
  ) {
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

  resolveBackgroundSize(
    backgroundSize: string,
    imageSize: Size,
    boxWidth: number,
    boxHeight: number,
  ): ResolvedSize | undefined {
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
      displayWidth = displayHeight! / ratio
    } else if (displayHeight === undefined) {
      displayHeight = displayWidth * ratio
    }

    if (displayWidth! <= 0 || displayHeight! <= 0) return undefined

    if (displayWidth! > boxWidth + 1 || displayHeight! > boxHeight + 1) {
      var fitScale = Math.min(
        boxWidth / displayWidth!,
        boxHeight / displayHeight!,
      )
      return {
        width: displayWidth! * fitScale,
        height: displayHeight! * fitScale,
        overflow: true,
        usesPagePercent,
      }
    }

    return {
      width: displayWidth!,
      height: displayHeight!,
      overflow: false,
      usesPagePercent,
    }
  }

  resolveBackgroundSizeToken(token: string | undefined, basis: number) {
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

  firstBackgroundLayer(value: string) {
    var depth = 0
    var quote

    for (var i = 0; i < value.length; i++) {
      var char = value[i]

      if (quote) {
        if (char === quote && value[i - 1] !== '\\') quote = undefined!
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

  backgroundImageUrl(value: string) {
    value = value || ''
    var start = value.indexOf('url(')
    if (start === -1) return undefined

    var index = start + 4
    while (index < value.length && /\s/.test(value[index]!)) index++

    var quote =
      value[index] === '"' || value[index] === "'" ? value[index++] : undefined
    var urlStart = index
    while (index < value.length) {
      var char = value[index]
      if (char === '\\') {
        index += 2
        continue
      }
      if (quote ? char === quote : char === ')') break
      index++
    }

    if (index >= value.length) return undefined

    var url = value.slice(urlStart, index).trim()
    if (!quote) return url

    index++
    while (index < value.length && /\s/.test(value[index]!)) index++
    return value[index] === ')' ? url : undefined
  }

  hasMultipleBackgroundImages(value: string) {
    if (!value) return false
    var first = this.firstBackgroundLayer(value)
    return first.length < value.length
  }

  hasAuthoredPageBackgroundConstraints(element: StyledElement) {
    if (!element) return false

    if (this.styleDeclaresPageBackgroundConstraints(element.style)) {
      return true
    }

    var styleSheets = this.document && this.document.styleSheets
    if (!styleSheets) return false

    for (var i = 0; i < styleSheets.length; i++) {
      if (
        this.styleSheetDeclaresPageBackgroundConstraints(
          styleSheets[i]!,
          element,
        )
      ) {
        return true
      }
    }

    return false
  }

  styleSheetDeclaresPageBackgroundConstraints(
    styleSheet: CSSStyleSheet,
    element: StyledElement,
  ) {
    var rules
    try {
      rules = styleSheet.cssRules
    } catch (_error) {
      return false
    }

    return this.cssRulesDeclarePageBackgroundConstraints(rules, element)
  }

  cssRulesDeclarePageBackgroundConstraints(
    rules: CSSRuleList | undefined,
    element: StyledElement,
  ): boolean {
    if (!rules) return false

    for (var i = 0; i < rules.length; i++) {
      var rule = rules[i] as NestedCssRule

      if (
        rule.type === 1 &&
        rule.selectorText &&
        this.elementMatchesPageBackgroundRule(element, rule.selectorText) &&
        this.styleDeclaresPageBackgroundConstraints(rule.style)
      ) {
        return true
      }

      if (rule.cssRules) {
        var condition = rule.conditionText || rule.media?.mediaText
        if (
          condition &&
          this.window &&
          this.window.matchMedia &&
          !this.window.matchMedia(condition).matches
        ) {
          continue
        }

        if (
          this.cssRulesDeclarePageBackgroundConstraints(rule.cssRules, element)
        ) {
          return true
        }
      }
    }

    return false
  }

  elementMatchesPageBackgroundRule(element: Element, selectorText: string) {
    try {
      return element.matches(selectorText)
    } catch (_error) {
      return false
    }
  }

  styleDeclaresPageBackgroundConstraints(
    style: CSSStyleDeclaration | undefined,
  ) {
    if (!style) return false

    return PAGE_BACKGROUND_CONSTRAINT_PROPERTIES.some(
      (property) => !!style.getPropertyValue(property),
    )
  }

  backgroundImageSize(url: string, callback: (size: Size | undefined) => void) {
    this._backgroundImageSizes = this._backgroundImageSizes || {}

    if (this._backgroundImageSizes![url]) {
      callback(this._backgroundImageSizes![url])
      return
    }

    var image = new this.window.Image()
    this.pendingImages.add(image)
    image.onload = () => {
      this.pendingImages.delete(image)
      var size = {
        width: image.naturalWidth || image.width,
        height: image.naturalHeight || image.height,
      }

      if (size.width > 0 && size.height > 0) {
        this._backgroundImageSizes![url] = size
        callback(size)
      }
    }
    image.onerror = () => {
      this.pendingImages.delete(image)
      callback(undefined)
    }
    image.src = url
  }

  setPageBackgroundSize(element: StyledElement, value: string) {
    this.setPageBackgroundProperty(element, 'background-size', value)
  }

  setPageBackgroundProperty(
    element: StyledElement,
    property: string,
    value: string,
  ) {
    this._pageBackgroundOverrides ??= new Map()
    let properties = this._pageBackgroundOverrides.get(element)
    if (!properties) {
      properties = new Map()
      this._pageBackgroundOverrides.set(element, properties)
    }
    if (!properties.has(property)) {
      properties.set(property, {
        value: element.style.getPropertyValue(property),
        priority: element.style.getPropertyPriority(property),
      })
    }

    element.style.setProperty(property, value, 'important')
  }

  destroy() {
    this.clearPageBackgroundNormalization()
    for (const image of this.pendingImages) {
      image.onload = null
      image.onerror = null
    }
    this.pendingImages.clear()
    this._backgroundImageSizes = undefined!
    this.document = undefined!
    this.documentElement = undefined!
    this.content = undefined!
    this.window = undefined!
  }
}
