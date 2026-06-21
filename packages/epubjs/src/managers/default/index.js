import EventEmitter from 'event-emitter'

import Mapping from '../../mapping'
import { EVENTS } from '../../utils/constants'
import { extend, defer, windowBounds, isNumber } from '../../utils/core'
import Queue from '../../utils/queue'
import scrollType from '../../utils/scrolltype'
import Stage from '../helpers/stage'
import Views from '../helpers/views'

class DefaultViewManager {
  constructor(options) {
    this.name = 'default'
    this.optsSettings = options.settings
    this.View = options.view
    this.request = options.request
    this.renditionQueue = options.queue
    this.q = new Queue(this)

    this.settings = extend(this.settings || {}, {
      infinite: true,
      hidden: false,
      width: undefined,
      height: undefined,
      axis: undefined,
      writingMode: undefined,
      flow: 'scrolled',
      ignoreClass: '',
      fullsize: undefined,
      allowScriptedContent: false,
      allowPopups: false,
    })

    extend(this.settings, options.settings || {})

    this.viewSettings = {
      ignoreClass: this.settings.ignoreClass,
      axis: this.settings.axis,
      flow: this.settings.flow,
      layout: this.layout,
      method: this.settings.method, // srcdoc, blobUrl, write
      width: 0,
      height: 0,
      forceEvenPages: true,
      allowScriptedContent: this.settings.allowScriptedContent,
      allowPopups: this.settings.allowPopups,
    }

    this.rendered = false
    this.reflowablePageCountCache = {}
    this.currentReflowableSpread = undefined
  }

  resetReflowablePageState(clearCache) {
    this.currentReflowableSpread = undefined
    if (clearCache) {
      this.reflowablePageCountCache = {}
    }
  }

  render(element, size) {
    let tag = element.tagName

    if (
      typeof this.settings.fullsize === 'undefined' &&
      tag &&
      (tag.toLowerCase() == 'body' || tag.toLowerCase() == 'html')
    ) {
      this.settings.fullsize = true
    }

    if (this.settings.fullsize) {
      this.settings.overflow = 'visible'
      this.overflow = this.settings.overflow
    }

    this.settings.size = size

    this.settings.rtlScrollType = scrollType()

    // Save the stage
    this.stage = new Stage({
      width: size.width,
      height: size.height,
      overflow: this.overflow,
      hidden: this.settings.hidden,
      axis: this.settings.axis,
      fullsize: this.settings.fullsize,
      direction: this.settings.direction,
    })

    this.stage.attachTo(element)

    // Get this stage container div
    this.container = this.stage.getContainer()

    // Views array methods
    this.views = new Views(this.container)

    // Calculate Stage Size
    this._bounds = this.bounds()
    this._stageSize = this.stage.size()

    // Set the dimensions for views
    this.viewSettings.width = this._stageSize.width
    this.viewSettings.height = this._stageSize.height

    // Function to handle a resize event.
    // Will only attach if width and height are both fixed.
    this.stage.onResize(this.onResized.bind(this))

    this.stage.onOrientationChange(this.onOrientationChange.bind(this))

    // Add Event Listeners
    this.addEventListeners()

    // Add Layout method
    // this.applyLayoutMethod();
    if (this.layout) {
      this.updateLayout()
    }

    this.rendered = true
  }

  addEventListeners() {
    var scroller

    window.addEventListener(
      'unload',
      function (e) {
        this.destroy()
      }.bind(this),
    )

    if (!this.settings.fullsize) {
      scroller = this.container
    } else {
      scroller = window
    }

    this._onScroll = this.onScroll.bind(this)
    scroller.addEventListener('scroll', this._onScroll)
  }

  removeEventListeners() {
    var scroller

    if (!this.settings.fullsize) {
      scroller = this.container
    } else {
      scroller = window
    }

    scroller.removeEventListener('scroll', this._onScroll)
    this._onScroll = undefined
  }

  destroy() {
    clearTimeout(this.orientationTimeout)
    clearTimeout(this.resizeTimeout)
    clearTimeout(this.afterScrolled)

    this.clear()

    this.removeEventListeners()

    this.stage.destroy()

    this.rendered = false

    /*

			clearTimeout(this.trimTimeout);
			if(this.settings.hidden) {
				this.element.removeChild(this.wrapper);
			} else {
				this.element.removeChild(this.container);
			}
		*/
  }

  onOrientationChange(e) {
    let { orientation } = window

    if (this.optsSettings.resizeOnOrientationChange) {
      this.resize()
    }

    // Per ampproject:
    // In IOS 10.3, the measured size of an element is incorrect if the
    // element size depends on window size directly and the measurement
    // happens in window.resize event. Adding a timeout for correct
    // measurement. See https://github.com/ampproject/amphtml/issues/8479
    clearTimeout(this.orientationTimeout)
    this.orientationTimeout = setTimeout(
      function () {
        this.orientationTimeout = undefined

        if (this.optsSettings.resizeOnOrientationChange) {
          this.resize()
        }

        this.emit(EVENTS.MANAGERS.ORIENTATION_CHANGE, orientation)
      }.bind(this),
      500,
    )
  }

  onResized(e) {
    this.resize()
  }

  resize(width, height, epubcfi) {
    let stageSize = this.stage.size(width, height)

    // For Safari, wait for orientation to catch up
    // if the window is a square
    this.winBounds = windowBounds()
    if (
      this.orientationTimeout &&
      this.winBounds.width === this.winBounds.height
    ) {
      // reset the stage size for next resize
      this._stageSize = undefined
      return
    }

    if (
      this._stageSize &&
      this._stageSize.width === stageSize.width &&
      this._stageSize.height === stageSize.height
    ) {
      // Size is the same, no need to resize
      return
    }

    this._stageSize = stageSize

    this._bounds = this.bounds()

    // Clear current views
    this.clear()
    this.resetReflowablePageState(true)

    // Update for new views
    this.viewSettings.width = this._stageSize.width
    this.viewSettings.height = this._stageSize.height

    this.updateLayout()

    this.emit(
      EVENTS.MANAGERS.RESIZED,
      {
        width: this._stageSize.width,
        height: this._stageSize.height,
      },
      epubcfi,
    )
  }

  createView(section, forceRight) {
    return new this.View(section, extend(this.viewSettings, { forceRight }))
  }

  handleNextPrePaginated(forceRight, section, action) {
    let next

    if (this.layout.name === 'pre-paginated' && this.layout.divisor > 1) {
      if (forceRight || section.index === 0) {
        // First page (cover) should stand alone for pre-paginated books
        return
      }
      next = section.next()
      if (next && !next.properties.includes('page-spread-left')) {
        return action.call(this, next)
      }
    }
  }

  isReflowableSpread() {
    return (
      this.isPaginated &&
      this.settings.axis === 'horizontal' &&
      this.layout &&
      this.layout.name === 'reflowable' &&
      this.layout.divisor > 1
    )
  }

  canUseLogicalReflowableSpread() {
    return (
      this.isReflowableSpread() &&
      !this.settings.fullsize &&
      (!this.settings.direction || this.settings.direction === 'ltr')
    )
  }

  reflowableLayoutCacheKey(section) {
    if (!this.layout) {
      return section.index + ':unknown'
    }

    return [
      section.index,
      this.layout.width,
      this.layout.height,
      this.layout.pageWidth,
      this.layout.columnWidth,
      this.layout.gap,
      this.settings.axis,
      this.settings.direction || 'ltr',
      this.viewSettings && this.viewSettings.layoutStyleSignature
        ? this.viewSettings.layoutStyleSignature
        : '',
    ].join(':')
  }

  cacheReflowablePageCount(view) {
    if (!view || !view.section) {
      return 0
    }

    let pageCount = this.viewPageCount(view)
    this.reflowablePageCountCache[this.reflowableLayoutCacheKey(view.section)] =
      pageCount
    return pageCount
  }

  deleteReflowablePageCountCache(section) {
    if (!section) {
      return
    }

    delete this.reflowablePageCountCache[this.reflowableLayoutCacheKey(section)]
  }

  async measureReflowableSectionPageCount(section) {
    if (!section) {
      return 0
    }

    let existing = this.views && this.views.find(section)
    if (existing) {
      return this.cacheReflowablePageCount(existing)
    }

    let key = this.reflowableLayoutCacheKey(section)
    if (this.reflowablePageCountCache[key]) {
      return this.reflowablePageCountCache[key]
    }

    let scrollLeft = this.container ? this.container.scrollLeft : 0
    let view = this.createView(section)
    view.element.style.visibility = 'hidden'
    view.iframe && (view.iframe.style.visibility = 'hidden')

    view.on(EVENTS.VIEWS.AXIS, (axis) => {
      this.updateAxis(axis)
    })

    view.on(EVENTS.VIEWS.WRITING_MODE, (mode) => {
      this.updateWritingMode(mode)
    })

    this.views.append(view)

    try {
      await view.display(this.request)
      return this.cacheReflowablePageCount(view)
    } finally {
      this.views.remove(view)
      this.scrollTo(scrollLeft, 0, true)
    }
  }

  async withReflowableSectionView(section, callback) {
    let existing = this.views && this.views.find(section)
    if (existing) {
      return callback(existing)
    }

    let scrollLeft = this.container ? this.container.scrollLeft : 0
    let view = this.createView(section)
    view.element.style.visibility = 'hidden'
    view.iframe && (view.iframe.style.visibility = 'hidden')

    view.on(EVENTS.VIEWS.AXIS, (axis) => {
      this.updateAxis(axis)
    })

    view.on(EVENTS.VIEWS.WRITING_MODE, (mode) => {
      this.updateWritingMode(mode)
    })

    this.views.append(view)

    try {
      await view.display(this.request)
      return callback(view)
    } finally {
      this.views.remove(view)
      this.scrollTo(scrollLeft, 0, true)
    }
  }

  reflowablePage(section, pageIndex) {
    return {
      section,
      pageIndex,
    }
  }

  clampReflowablePageToCount(address, pageCount) {
    if (!address || !address.section || !pageCount) {
      return
    }

    return this.reflowablePage(
      address.section,
      Math.min(Math.max(address.pageIndex, 0), pageCount - 1),
    )
  }

  async firstReflowablePageAfterSection(section) {
    let next = section && section.next && section.next()
    while (next) {
      let pageCount = await this.measureReflowableSectionPageCount(next)
      if (pageCount) {
        return this.reflowablePage(next, 0)
      }
      next = next.next && next.next()
    }
  }

  async lastReflowablePageBeforeSection(section) {
    let prev = section && section.prev && section.prev()
    while (prev) {
      let pageCount = await this.measureReflowableSectionPageCount(prev)
      if (pageCount) {
        return this.reflowablePage(prev, pageCount - 1)
      }
      prev = prev.prev && prev.prev()
    }
  }

  async reflowablePageAfterRenderedLeft(left, leftPageCount) {
    if (!left || !leftPageCount) {
      return
    }

    if (left.pageIndex + 1 < leftPageCount) {
      return this.reflowablePage(left.section, left.pageIndex + 1)
    }

    return this.firstReflowablePageAfterSection(left.section)
  }

  async reflowablePageBeforeRenderedRight(right, rightPageCount) {
    if (!right || !rightPageCount) {
      return
    }

    if (right.pageIndex > 0) {
      return this.reflowablePage(right.section, right.pageIndex - 1)
    }

    return this.lastReflowablePageBeforeSection(right.section)
  }

  renderedReflowablePageCount(section) {
    let view = section && this.views && this.views.find(section)
    return view ? this.cacheReflowablePageCount(view) : 0
  }

  async nextReflowablePageFromRendered(address) {
    let pageCount = this.renderedReflowablePageCount(address && address.section)
    if (pageCount) {
      address = this.clampReflowablePageToCount(address, pageCount)
      return this.reflowablePageAfterRenderedLeft(address, pageCount)
    }

    return this.nextReflowablePage(address)
  }

  async previousReflowablePageFromRendered(address) {
    let pageCount = this.renderedReflowablePageCount(address && address.section)
    if (pageCount) {
      address = this.clampReflowablePageToCount(address, pageCount)
      return this.reflowablePageBeforeRenderedRight(address, pageCount)
    }

    return this.previousReflowablePage(address)
  }

  async reflowablePageForTarget(section, target) {
    if (!section) {
      return
    }

    return this.withReflowableSectionView(section, async (view) => {
      this.cacheReflowablePageCount(view)

      let pageIndex = 0
      if (target) {
        let targetOffset = view.locationOf(target)
        pageIndex = Math.floor(
          Math.max(targetOffset.left, 0) / this.layout.pageWidth,
        )
        pageIndex = Math.min(
          Math.max(pageIndex, 0),
          Math.max(this.viewPageCount(view) - 1, 0),
        )
      }

      return this.reflowablePage(section, pageIndex)
    })
  }

  sameReflowableSection(left, right) {
    return (
      left &&
      right &&
      left.section &&
      right.section &&
      left.section.index === right.section.index
    )
  }

  async normalizeReflowablePage(address) {
    if (!address || !address.section) {
      return
    }

    let pageCount = await this.measureReflowableSectionPageCount(
      address.section,
    )
    if (!pageCount) {
      return
    }

    return this.reflowablePage(
      address.section,
      Math.min(Math.max(address.pageIndex, 0), pageCount - 1),
    )
  }

  async nextReflowablePage(address) {
    address = await this.normalizeReflowablePage(address)
    if (!address) {
      return
    }

    let pageCount = await this.measureReflowableSectionPageCount(
      address.section,
    )
    if (address.pageIndex + 1 < pageCount) {
      return this.reflowablePage(address.section, address.pageIndex + 1)
    }

    let next = address.section.next && address.section.next()
    while (next) {
      let nextPageCount = await this.measureReflowableSectionPageCount(next)
      if (nextPageCount) {
        return this.reflowablePage(next, 0)
      }
      next = next.next && next.next()
    }
  }

  async previousReflowablePage(address) {
    address = await this.normalizeReflowablePage(address)
    if (!address) {
      return
    }

    if (address.pageIndex > 0) {
      return this.reflowablePage(address.section, address.pageIndex - 1)
    }

    let prev = address.section.prev && address.section.prev()
    while (prev) {
      let pageCount = await this.measureReflowableSectionPageCount(prev)
      if (pageCount) {
        return this.reflowablePage(prev, pageCount - 1)
      }
      prev = prev.prev && prev.prev()
    }
  }

  async reflowableSpreadFromLeft(left) {
    left = await this.normalizeReflowablePage(left)
    if (!left) {
      return
    }

    return {
      left,
      right: await this.nextReflowablePage(left),
      anchor: 'left',
    }
  }

  async reflowableSpreadEndingAt(right) {
    right = await this.normalizeReflowablePage(right)
    if (!right) {
      return
    }

    return {
      left: await this.previousReflowablePage(right),
      right,
      anchor: 'right',
    }
  }

  async reflowableSpreadContaining(page) {
    page = await this.normalizeReflowablePage(page)
    if (!page) {
      return
    }

    let left = page
    if (this.layout.divisor > 1 && page.pageIndex % this.layout.divisor) {
      left = await this.previousReflowablePage(page)
    }

    return this.reflowableSpreadFromLeft(left || page)
  }

  async reflowableSpreadFromCurrentPhase(page) {
    page = await this.normalizeReflowablePage(page)
    if (!page || !this.currentReflowableSpread || this.layout.divisor <= 1) {
      return
    }

    let spread = this.currentReflowableSpread
    let leftInSection = this.sameReflowableSection(spread.left, page)
    let rightInSection = this.sameReflowableSection(spread.right, page)
    if (!leftInSection && !rightInSection) {
      return
    }

    if (
      (leftInSection && spread.left.pageIndex === page.pageIndex) ||
      (rightInSection && spread.right.pageIndex === page.pageIndex)
    ) {
      return spread
    }

    let divisor = this.layout.divisor
    let basePageIndex = leftInSection
      ? spread.left.pageIndex
      : spread.right.pageIndex + 1
    let startPageIndex

    if (page.pageIndex < basePageIndex) {
      startPageIndex =
        basePageIndex -
        Math.ceil((basePageIndex - page.pageIndex) / divisor) * divisor
    } else {
      startPageIndex =
        basePageIndex +
        Math.floor((page.pageIndex - basePageIndex) / divisor) * divisor
    }

    return this.reflowableSpreadFromLeft(
      this.reflowablePage(page.section, startPageIndex),
    )
  }

  async reflowableSpreadForTarget(page) {
    return (
      (await this.reflowableSpreadFromCurrentPhase(page)) ||
      this.reflowableSpreadContaining(page)
    )
  }

  async displayReflowableTarget(section, target) {
    let page = await this.reflowablePageForTarget(section, target)
    let spread = await this.reflowableSpreadForTarget(page)
    if (!spread) {
      this.views.show()
      return
    }

    return this.renderReflowableSpread(spread)
  }

  async renderReflowableSpread(spread) {
    if (spread && spread.exact) {
      return this.renderExactReflowableSpread(spread)
    }

    let viewBySectionIndex = {}
    let resolvedSpread = {
      ...spread,
    }

    this.clear()
    this.updateLayout()

    if (resolvedSpread.anchor === 'right' && resolvedSpread.right) {
      resolvedSpread.right = await this.normalizeReflowablePage(
        resolvedSpread.right,
      )
      if (resolvedSpread.right) {
        let rightView = await this.add(resolvedSpread.right.section)
        viewBySectionIndex[resolvedSpread.right.section.index] = rightView
        let rightPageCount = this.cacheReflowablePageCount(rightView)
        let rightPageIndex = resolvedSpread.endsAtSectionEnd
          ? rightPageCount - 1
          : resolvedSpread.right.pageIndex
        resolvedSpread.right = this.clampReflowablePageToCount(
          this.reflowablePage(resolvedSpread.right.section, rightPageIndex),
          rightPageCount,
        )
        resolvedSpread.left = await this.reflowablePageBeforeRenderedRight(
          resolvedSpread.right,
          rightPageCount,
        )
      }

      if (
        resolvedSpread.left &&
        resolvedSpread.right &&
        !this.sameReflowableSection(resolvedSpread.left, resolvedSpread.right)
      ) {
        let leftView = await this.prepend(resolvedSpread.left.section)
        viewBySectionIndex[resolvedSpread.left.section.index] = leftView
        let leftPageCount = this.cacheReflowablePageCount(leftView)
        resolvedSpread.left = this.reflowablePage(
          resolvedSpread.left.section,
          Math.max(leftPageCount - 1, 0),
        )
      }

      this.applyReflowableSpreadPosition(resolvedSpread, viewBySectionIndex)
      return
    }

    if (resolvedSpread.left) {
      resolvedSpread.left = await this.normalizeReflowablePage(
        resolvedSpread.left,
      )
    }

    if (resolvedSpread.left) {
      let leftView = await this.add(resolvedSpread.left.section)
      viewBySectionIndex[resolvedSpread.left.section.index] = leftView
      let leftPageCount = this.cacheReflowablePageCount(leftView)
      resolvedSpread.left = this.clampReflowablePageToCount(
        resolvedSpread.left,
        leftPageCount,
      )
      resolvedSpread.right = await this.reflowablePageAfterRenderedLeft(
        resolvedSpread.left,
        leftPageCount,
      )
    } else if (resolvedSpread.right) {
      resolvedSpread.right = await this.normalizeReflowablePage(
        resolvedSpread.right,
      )
    }

    if (
      resolvedSpread.right &&
      (!resolvedSpread.left ||
        !this.sameReflowableSection(resolvedSpread.left, resolvedSpread.right))
    ) {
      let rightView = resolvedSpread.left
        ? await this.append(resolvedSpread.right.section)
        : await this.add(resolvedSpread.right.section)
      viewBySectionIndex[resolvedSpread.right.section.index] = rightView
      this.cacheReflowablePageCount(rightView)
    }

    this.applyReflowableSpreadPosition(resolvedSpread, viewBySectionIndex)
  }

  async renderExactReflowableSpread(spread) {
    let viewBySectionIndex = {}
    let resolvedSpread = {
      ...spread,
      anchor: spread.anchor || (spread.left ? 'left' : 'right'),
    }

    this.clear()
    this.updateLayout()

    if (resolvedSpread.left) {
      resolvedSpread.left = await this.normalizeReflowablePage(
        resolvedSpread.left,
      )
    }
    if (resolvedSpread.right) {
      resolvedSpread.right = await this.normalizeReflowablePage(
        resolvedSpread.right,
      )
    }

    if (!resolvedSpread.left && !resolvedSpread.right) {
      this.views.show()
      return
    }

    let leftPageCount
    if (resolvedSpread.left) {
      let leftView = await this.add(resolvedSpread.left.section)
      viewBySectionIndex[resolvedSpread.left.section.index] = leftView
      leftPageCount = this.cacheReflowablePageCount(leftView)
      resolvedSpread.left = this.clampReflowablePageToCount(
        resolvedSpread.left,
        leftPageCount,
      )
    }

    if (resolvedSpread.right) {
      if (
        resolvedSpread.left &&
        this.sameReflowableSection(resolvedSpread.left, resolvedSpread.right)
      ) {
        resolvedSpread.right = this.clampReflowablePageToCount(
          resolvedSpread.right,
          leftPageCount || 1,
        )
      } else {
        let rightView = resolvedSpread.left
          ? await this.append(resolvedSpread.right.section)
          : await this.add(resolvedSpread.right.section)
        viewBySectionIndex[resolvedSpread.right.section.index] = rightView
        let rightPageCount = this.cacheReflowablePageCount(rightView)
        resolvedSpread.right = this.clampReflowablePageToCount(
          resolvedSpread.right,
          rightPageCount,
        )
      }
    }

    this.applyReflowableSpreadPosition(resolvedSpread, viewBySectionIndex)
  }

  async displayReflowableSpread(section, target) {
    let page = await this.reflowablePageForTarget(section, target)
    let spread = await this.reflowableSpreadForTarget(page)
    if (!spread) {
      this.views.show()
      return
    }

    return this.renderReflowableSpread(spread)
  }

  applyReflowableSpreadPosition(spread, viewBySectionIndex) {
    let left = spread.left
    let right = spread.right
    let pageWidth = this.layout.pageWidth
    let leftView = left && viewBySectionIndex[left.section.index]
    let rightView = right && viewBySectionIndex[right.section.index]

    if (leftView) {
      leftView.element.style.marginLeft = ''
      leftView.element.style.marginRight = right ? '' : pageWidth + 'px'
      this.scrollTo(
        leftView.offset().left + left.pageIndex * pageWidth,
        0,
        true,
      )
    } else if (rightView) {
      rightView.element.style.marginLeft = pageWidth + 'px'
      rightView.element.style.marginRight = ''
      this.scrollTo(
        rightView.offset().left + right.pageIndex * pageWidth - pageWidth,
        0,
        true,
      )
    }

    this.currentReflowableSpread = spread
    this.views.show()
  }

  async nextReflowableSpread() {
    let spread = this.currentReflowableSpread
    if (!spread) {
      spread = this.reflowableSpreadFromVisible()
    }

    let current = spread && (spread.right || spread.left)
    let nextLeft = await this.nextReflowablePageFromRendered(current)
    if (!nextLeft) {
      this.views.show()
      return
    }

    let nextSpread = await this.reflowableSpreadFromLeft(nextLeft)
    if (!nextSpread) {
      this.views.show()
      return
    }

    return this.renderReflowableSpread(nextSpread)
  }

  async previousReflowableSpread() {
    let spread = this.currentReflowableSpread
    if (!spread) {
      spread = this.reflowableSpreadFromVisible()
    }

    let current = spread && spread.left
    let prevRight = await this.previousReflowablePageFromRendered(current)
    if (!prevRight) {
      this.views.show()
      return
    }

    let previousSpread = await this.reflowableSpreadEndingAt(prevRight)
    if (!previousSpread) {
      this.views.show()
      return
    }

    if (current && !this.sameReflowableSection(current, prevRight)) {
      previousSpread.endsAtSectionEnd = true
    }

    return this.renderReflowableSpread(previousSpread)
  }

  reflowableSpreadFromVisible() {
    let visible = this.paginatedLocation()
    if (!visible.length) {
      return
    }

    let pages = []
    visible.forEach((location) => {
      let view = this.views
        .displayed()
        .find((candidate) => candidate.section.index === location.index)
      if (!view) {
        return
      }

      location.pages.forEach((page) => {
        pages.push(this.reflowablePage(view.section, page - 1))
      })
    })

    if (!pages.length) {
      return
    }

    return {
      left: pages[0],
      right: pages[1],
    }
  }

  viewPageCount(view) {
    if (!view || !this.layout || !this.layout.pageWidth) {
      return 0
    }

    if (typeof view.pageCount === 'function') {
      return view.pageCount()
    }

    return Math.max(1, Math.ceil(view.width() / this.layout.pageWidth))
  }

  visibleLengthThreshold() {
    if (!this.isReflowableSpread() || !this.layout.pageWidth) {
      return 1
    }

    return Math.min(Math.max(this.layout.pageWidth * 0.02, 2), 24)
  }

  snapReflowablePageOffset(offset) {
    if (!this.isReflowableSpread() || !this.layout.pageWidth) {
      return offset
    }

    let pageWidth = this.layout.pageWidth
    let snapped = Math.round(offset / pageWidth) * pageWidth

    if (Math.abs(snapped - offset) <= this.visibleLengthThreshold()) {
      return snapped
    }

    return offset
  }

  display(section, target) {
    var displaying = new defer()
    var displayed = displaying.promise

    // Check if moving to target is needed
    if (target === section.href || isNumber(target)) {
      target = undefined
    }

    if (this.canUseLogicalReflowableSpread()) {
      this.displayReflowableSpread(section, target).then(
        function () {
          displaying.resolve()
        },
        function (err) {
          displaying.reject(err)
        },
      )
      return displayed
    }

    // Check to make sure the section we want isn't already shown
    var visible = this.views.find(section)

    // View is already shown, just move to correct location in view
    if (
      visible &&
      section &&
      this.layout.name !== 'pre-paginated' &&
      !this.isReflowableSpread()
    ) {
      let offset = visible.offset()
      let targetOffset
      let targetWidth

      if (target) {
        targetOffset = visible.locationOf(target)
        targetWidth = visible.width()
      }

      if (targetOffset) {
        this.moveTo(targetOffset, targetWidth)
      } else if (this.settings.direction === 'ltr') {
        this.scrollTo(offset.left, offset.top, true)
      } else {
        let width = visible.width()
        this.scrollTo(offset.left + width, offset.top, true)
      }

      displaying.resolve()
      return displayed
    }

    // Hide all current views
    this.clear()

    let forceRight = false
    if (
      this.layout.name === 'pre-paginated' &&
      this.layout.divisor === 2 &&
      section.properties.includes('page-spread-right')
    ) {
      forceRight = true
    }

    let targetOffset
    let targetWidth

    this.add(section, forceRight)
      .then(
        function (view) {
          // Move to correct place within the section, if needed
          if (target) {
            targetOffset = view.locationOf(target)
            targetWidth = view.width()
          }
        }.bind(this),
        (err) => {
          displaying.reject(err)
        },
      )
      .then(
        function () {
          return this.handleNextPrePaginated(forceRight, section, this.add)
        }.bind(this),
      )
      .then(
        function () {
          if (targetOffset) {
            this.moveTo(targetOffset, targetWidth)
          }

          this.views.show()

          displaying.resolve()
        }.bind(this),
      )
    // .then(function(){
    // 	return this.hooks.display.trigger(view);
    // }.bind(this))
    // .then(function(){
    // 	this.views.show();
    // }.bind(this));
    return displayed
  }

  afterDisplayed(view) {
    this.emit(EVENTS.MANAGERS.ADDED, view)
  }

  afterResized(view) {
    if (this.canUseLogicalReflowableSpread()) {
      this.deleteReflowablePageCountCache(view && view.section)
    }

    this.emit(EVENTS.MANAGERS.RESIZE, view.section)
  }

  moveTo(offset, width) {
    var distX = 0,
      distY = 0

    if (!this.isPaginated) {
      distY = offset.top
    } else {
      distX = Math.floor(offset.left / this.layout.delta) * this.layout.delta

      if (distX + this.layout.delta > this.container.scrollWidth) {
        distX = this.container.scrollWidth - this.layout.delta
      }

      distY = Math.floor(offset.top / this.layout.delta) * this.layout.delta

      if (distY + this.layout.delta > this.container.scrollHeight) {
        distY = this.container.scrollHeight - this.layout.delta
      }
    }
    if (this.settings.direction === 'rtl') {
      /***
				the `floor` function above (L343) is on positive values, so we should add one `layout.delta`
				to distX or use `Math.ceil` function, or multiply offset.left by -1
				before `Math.floor`
			*/
      distX = distX + this.layout.delta
      distX = distX - width
    }
    this.scrollTo(distX, distY, true)
  }

  add(section, forceRight) {
    var view = this.createView(section, forceRight)

    this.views.append(view)

    // view.on(EVENTS.VIEWS.SHOWN, this.afterDisplayed.bind(this));
    view.onDisplayed = this.afterDisplayed.bind(this)
    view.onResize = this.afterResized.bind(this)

    view.on(EVENTS.VIEWS.AXIS, (axis) => {
      this.updateAxis(axis)
    })

    view.on(EVENTS.VIEWS.WRITING_MODE, (mode) => {
      this.updateWritingMode(mode)
    })

    return view.display(this.request)
  }

  append(section, forceRight) {
    var view = this.createView(section, forceRight)
    this.views.append(view)

    view.onDisplayed = this.afterDisplayed.bind(this)
    view.onResize = this.afterResized.bind(this)

    view.on(EVENTS.VIEWS.AXIS, (axis) => {
      this.updateAxis(axis)
    })

    view.on(EVENTS.VIEWS.WRITING_MODE, (mode) => {
      this.updateWritingMode(mode)
    })

    return view.display(this.request)
  }

  prepend(section, forceRight) {
    var view = this.createView(section, forceRight)

    view.on(EVENTS.VIEWS.RESIZED, (bounds) => {
      this.counter(bounds)
    })

    this.views.prepend(view)

    view.onDisplayed = this.afterDisplayed.bind(this)
    view.onResize = this.afterResized.bind(this)

    view.on(EVENTS.VIEWS.AXIS, (axis) => {
      this.updateAxis(axis)
    })

    view.on(EVENTS.VIEWS.WRITING_MODE, (mode) => {
      this.updateWritingMode(mode)
    })

    return view.display(this.request)
  }

  counter(bounds) {
    if (this.settings.axis === 'vertical') {
      this.scrollBy(0, bounds.heightDelta, true)
    } else {
      this.scrollBy(bounds.widthDelta, 0, true)
    }
  }

  // resizeView(view) {
  //
  // 	if(this.settings.globalLayoutProperties.layout === "pre-paginated") {
  // 		view.lock("both", this.bounds.width, this.bounds.height);
  // 	} else {
  // 		view.lock("width", this.bounds.width, this.bounds.height);
  // 	}
  //
  // };

  next() {
    var next
    var left
    var maxLeft

    let dir = this.settings.direction

    if (!this.views.length) return

    if (this.canUseLogicalReflowableSpread()) {
      return this.nextReflowableSpread()
    }

    if (
      this.isPaginated &&
      this.settings.axis === 'horizontal' &&
      (!dir || dir === 'ltr')
    ) {
      this.scrollLeft = this.container.scrollLeft
      maxLeft = Math.max(
        this.container.scrollWidth - this.container.offsetWidth,
        0,
      )

      if (this.container.scrollLeft < maxLeft - 1) {
        left = Math.min(this.container.scrollLeft + this.layout.delta, maxLeft)
        this.scrollTo(left, 0, true)
      } else {
        next = this.views.last().section.next()
      }
    } else if (
      this.isPaginated &&
      this.settings.axis === 'horizontal' &&
      dir === 'rtl'
    ) {
      this.scrollLeft = this.container.scrollLeft

      if (this.settings.rtlScrollType === 'default') {
        left = this.container.scrollLeft

        if (left > 0) {
          this.scrollBy(this.layout.delta, 0, true)
        } else {
          next = this.views.last().section.next()
        }
      } else {
        left = this.container.scrollLeft + this.layout.delta * -1

        if (left > this.container.scrollWidth * -1) {
          this.scrollBy(this.layout.delta, 0, true)
        } else {
          next = this.views.last().section.next()
        }
      }
    } else if (this.isPaginated && this.settings.axis === 'vertical') {
      this.scrollTop = this.container.scrollTop

      let top = this.container.scrollTop + this.container.offsetHeight

      if (top < this.container.scrollHeight) {
        this.scrollBy(0, this.layout.height, true)
      } else {
        next = this.views.last().section.next()
      }
    } else {
      next = this.views.last().section.next()
    }

    if (next) {
      this.clear()
      // The new section may have a different writing-mode from the old section. Thus, we need to update layout.
      this.updateLayout()

      let forceRight = false
      if (
        this.layout.name === 'pre-paginated' &&
        this.layout.divisor === 2 &&
        next.properties.includes('page-spread-right')
      ) {
        forceRight = true
      }

      return this.append(next, forceRight)
        .then(
          function () {
            return this.handleNextPrePaginated(forceRight, next, this.append)
          }.bind(this),
          (err) => {
            return err
          },
        )
        .then(
          function () {
            // Reset position to start for scrolled-doc vertical-rl in default mode
            if (
              !this.isPaginated &&
              this.settings.axis === 'horizontal' &&
              this.settings.direction === 'rtl' &&
              this.settings.rtlScrollType === 'default'
            ) {
              this.scrollTo(this.container.scrollWidth, 0, true)
            }
            this.views.show()
          }.bind(this),
        )
    }
  }

  prev() {
    var prev
    var left
    let dir = this.settings.direction

    if (!this.views.length) return

    if (this.canUseLogicalReflowableSpread()) {
      return this.previousReflowableSpread()
    }

    if (
      this.isPaginated &&
      this.settings.axis === 'horizontal' &&
      (!dir || dir === 'ltr')
    ) {
      this.scrollLeft = this.container.scrollLeft

      if (this.container.scrollLeft > 1) {
        left = Math.max(this.container.scrollLeft - this.layout.delta, 0)
        this.scrollTo(left, 0, true)
      } else {
        prev = this.views.first().section.prev()
      }
    } else if (
      this.isPaginated &&
      this.settings.axis === 'horizontal' &&
      dir === 'rtl'
    ) {
      this.scrollLeft = this.container.scrollLeft

      if (this.settings.rtlScrollType === 'default') {
        left = this.container.scrollLeft + this.container.offsetWidth

        if (left < this.container.scrollWidth) {
          this.scrollBy(-this.layout.delta, 0, true)
        } else {
          prev = this.views.first().section.prev()
        }
      } else {
        left = this.container.scrollLeft

        if (left < 0) {
          this.scrollBy(-this.layout.delta, 0, true)
        } else {
          prev = this.views.first().section.prev()
        }
      }
    } else if (this.isPaginated && this.settings.axis === 'vertical') {
      this.scrollTop = this.container.scrollTop

      let top = this.container.scrollTop

      if (top > 1) {
        top = Math.max(top - this.layout.height, 0)
        this.scrollTo(0, top, true)
      } else {
        prev = this.views.first().section.prev()
      }
    } else {
      prev = this.views.first().section.prev()
    }

    if (prev) {
      this.clear()
      // The new section may have a different writing-mode from the old section. Thus, we need to update layout.
      this.updateLayout()

      let forceRight = false
      if (
        this.layout.name === 'pre-paginated' &&
        this.layout.divisor === 2 &&
        typeof prev.prev() !== 'object'
      ) {
        forceRight = true
      }

      return this.prepend(prev, forceRight)
        .then(
          function () {
            var left
            if (
              this.layout.name === 'pre-paginated' &&
              this.layout.divisor > 1
            ) {
              left = prev.prev()
              if (left) {
                return this.prepend(left)
              }
            }
          }.bind(this),
          (err) => {
            return err
          },
        )
        .then(
          function () {
            if (this.isPaginated && this.settings.axis === 'horizontal') {
              if (this.settings.direction === 'rtl') {
                if (this.settings.rtlScrollType === 'default') {
                  this.scrollTo(0, 0, true)
                } else {
                  this.scrollTo(
                    this.container.scrollWidth * -1 + this.layout.delta,
                    0,
                    true,
                  )
                }
              } else {
                this.scrollTo(
                  this.container.scrollWidth - this.layout.delta,
                  0,
                  true,
                )
              }
            }
            this.views.show()
          }.bind(this),
        )
    }
  }

  current() {
    var visible = this.visible()
    if (visible.length) {
      // Current is the last visible view
      return visible[visible.length - 1]
    }
    return null
  }

  clear() {
    // this.q.clear();

    if (this.views) {
      this.resetReflowablePageState(false)
      this.views.hide()
      this.scrollTo(0, 0, true)
      this.views.clear()
    }
  }

  currentLocation() {
    this.updateLayout()
    if (this.canUseLogicalReflowableSpread() && this.currentReflowableSpread) {
      this.location = this.reflowableSpreadLocation()
    } else if (this.isPaginated && this.settings.axis === 'horizontal') {
      this.location = this.paginatedLocation()
    } else {
      this.location = this.scrolledLocation()
    }
    return this.location
  }

  reflowableSpreadLocation() {
    let spread = this.currentReflowableSpread
    if (!spread) {
      return []
    }

    let addresses = []
    if (spread.left) {
      addresses.push(extend({ slot: 'left' }, spread.left))
    }
    if (spread.right) {
      addresses.push(extend({ slot: 'right' }, spread.right))
    }

    let grouped = []
    addresses.forEach((address) => {
      let last = grouped[grouped.length - 1]
      if (last && last.section.index === address.section.index) {
        last.endPageIndex = address.pageIndex
        last.pages.push(address.pageIndex + 1)
        last.endSlot = address.slot
      } else {
        grouped.push({
          section: address.section,
          startPageIndex: address.pageIndex,
          endPageIndex: address.pageIndex,
          pages: [address.pageIndex + 1],
          startSlot: address.slot,
          endSlot: address.slot,
        })
      }
    })

    return grouped
      .map((group) => {
        let view = this.views.find(group.section)
        if (!view) {
          return
        }

        let pageWidth = this.layout.pageWidth
        let start = group.startPageIndex * pageWidth
        let end = Math.min((group.endPageIndex + 1) * pageWidth, view.width())
        let mapping = this.mapping.page(
          view.contents,
          view.section.cfiBase,
          start,
          end,
        )

        return {
          index: group.section.index,
          href: group.section.href,
          pages: group.pages,
          totalPages: this.viewPageCount(view),
          mapping,
          startSlot: group.startSlot,
          endSlot: group.endSlot,
        }
      })
      .filter(Boolean)
  }

  scrolledLocation() {
    let visible = this.visible()
    let container = this.container.getBoundingClientRect()
    let pageHeight =
      container.height < window.innerHeight
        ? container.height
        : window.innerHeight
    let pageWidth =
      container.width < window.innerWidth ? container.width : window.innerWidth
    let vertical = this.settings.axis === 'vertical'
    let rtl = this.settings.direction === 'rtl'

    let offset = 0
    let used = 0

    if (this.settings.fullsize) {
      offset = vertical ? window.scrollY : window.scrollX
    }

    let sections = visible.map((view) => {
      let { index, href } = view.section
      let position = view.position()
      let width = view.width()
      let height = view.height()

      let startPos
      let endPos
      let stopPos
      let totalPages

      if (vertical) {
        startPos = offset + container.top - position.top + used
        endPos = startPos + pageHeight - used
        totalPages = this.layout.count(height, pageHeight).pages
        stopPos = pageHeight
      } else {
        startPos = offset + container.left - position.left + used
        endPos = startPos + pageWidth - used
        totalPages = this.layout.count(width, pageWidth).pages
        stopPos = pageWidth
      }

      let currPage = Math.ceil(startPos / stopPos)
      let pages = []
      let endPage = Math.ceil(endPos / stopPos)

      // Reverse page counts for horizontal rtl
      if (this.settings.direction === 'rtl' && !vertical) {
        let tempStartPage = currPage
        currPage = totalPages - endPage
        endPage = totalPages - tempStartPage
      }

      pages = []
      for (var i = currPage; i <= endPage; i++) {
        let pg = i + 1
        pages.push(pg)
      }

      let mapping = this.mapping.page(
        view.contents,
        view.section.cfiBase,
        startPos,
        endPos,
      )

      return {
        index,
        href,
        pages,
        totalPages,
        mapping,
      }
    })

    return sections
  }

  paginatedLocation() {
    let visible = this.visible()
    let container = this.container.getBoundingClientRect()

    let left = 0
    let used = 0

    if (this.settings.fullsize) {
      left = window.scrollX
    }

    let sections = []

    visible.forEach((view) => {
      let { index, href } = view.section
      let offset
      let position = view.position()
      let width = view.width()

      // Find mapping
      let start
      let end
      let pageWidth

      if (!this.settings.fullsize && this.settings.direction !== 'rtl') {
        let viewStart = view.offset().left
        let viewEnd = viewStart + width
        let viewportStart = this.container.scrollLeft
        let viewportEnd = viewportStart + this.layout.width

        let intersectionStart = Math.max(viewportStart, viewStart)
        let intersectionEnd = Math.min(viewportEnd, viewEnd)

        start = intersectionStart - viewStart
        end = intersectionEnd - viewStart
        start = Math.max(0, start)
        end = Math.min(width, Math.max(start, end))
        start = this.snapReflowablePageOffset(start)
        end = this.snapReflowablePageOffset(end)
        pageWidth = end - start
      } else if (this.settings.direction === 'rtl') {
        offset = container.right - left
        pageWidth =
          Math.min(Math.abs(offset - position.left), this.layout.width) - used
        end = position.width - (position.right - offset) - used
        start = end - pageWidth
      } else {
        offset = container.left + left
        pageWidth = Math.min(position.right - offset, this.layout.width) - used
        start = offset - position.left + used
        end = start + pageWidth
      }

      if (pageWidth <= this.visibleLengthThreshold() || end <= start) {
        return
      }

      used += pageWidth

      let mapping = this.mapping.page(
        view.contents,
        view.section.cfiBase,
        start,
        end,
      )

      let totalPages = this.viewPageCount(view)
      let pageFudge =
        !this.settings.fullsize && this.settings.direction !== 'rtl' ? 1 : 0
      let startPage = Math.floor((start + pageFudge) / this.layout.pageWidth)
      let pages = []
      let endPage = Math.floor((end + pageFudge) / this.layout.pageWidth)

      // start page should not be negative
      if (startPage < 0) {
        startPage = 0
        endPage = endPage + 1
      }

      if (startPage >= totalPages) {
        startPage = totalPages - 1
      }

      if (endPage > totalPages) {
        endPage = totalPages
      }

      // Reverse page counts for rtl
      if (this.settings.direction === 'rtl') {
        let tempStartPage = startPage
        startPage = totalPages - endPage
        endPage = totalPages - tempStartPage
      }

      for (var i = startPage + 1; i <= endPage; i++) {
        let pg = i
        pages.push(pg)
      }

      sections.push({
        index,
        href,
        pages,
        totalPages,
        mapping,
      })
    })

    return sections
  }

  isVisible(view, offsetPrev, offsetNext, _container) {
    var position = view.position()
    var container = _container || this.bounds()
    var visibleLength

    if (this.settings.axis === 'horizontal') {
      visibleLength =
        Math.min(position.right, container.right + offsetNext) -
        Math.max(position.left, container.left - offsetPrev)

      return visibleLength > this.visibleLengthThreshold()
    } else if (this.settings.axis === 'vertical') {
      visibleLength =
        Math.min(position.bottom, container.bottom + offsetNext) -
        Math.max(position.top, container.top - offsetPrev)

      return visibleLength > this.visibleLengthThreshold()
    }

    return false
  }

  visible() {
    var container = this.bounds()
    var views = this.views.displayed()
    var viewsLength = views.length
    var visible = []
    var isVisible
    var view

    for (var i = 0; i < viewsLength; i++) {
      view = views[i]
      isVisible = this.isVisible(view, 0, 0, container)

      if (isVisible === true) {
        visible.push(view)
      }
    }
    return visible
  }

  scrollBy(x, y, silent) {
    let dir = this.settings.direction === 'rtl' ? -1 : 1

    if (silent) {
      this.ignore = true
    }

    if (!this.settings.fullsize) {
      if (x) this.container.scrollLeft += x * dir
      if (y) this.container.scrollTop += y
    } else {
      window.scrollBy(x * dir, y * dir)
    }
    this.scrolled = true
  }

  scrollTo(x, y, silent) {
    if (silent) {
      this.ignore = true
    }

    if (!this.settings.fullsize) {
      this.container.scrollLeft = x
      this.container.scrollTop = y
    } else {
      window.scrollTo(x, y)
    }
    this.scrolled = true
  }

  onScroll() {
    let scrollTop
    let scrollLeft

    if (!this.settings.fullsize) {
      scrollTop = this.container.scrollTop
      scrollLeft = this.container.scrollLeft
    } else {
      scrollTop = window.scrollY
      scrollLeft = window.scrollX
    }

    this.scrollTop = scrollTop
    this.scrollLeft = scrollLeft

    if (!this.ignore) {
      this.emit(EVENTS.MANAGERS.SCROLL, {
        top: scrollTop,
        left: scrollLeft,
      })

      clearTimeout(this.afterScrolled)
      this.afterScrolled = setTimeout(
        function () {
          this.emit(EVENTS.MANAGERS.SCROLLED, {
            top: this.scrollTop,
            left: this.scrollLeft,
          })
        }.bind(this),
        20,
      )
    } else {
      this.ignore = false
    }
  }

  bounds() {
    var bounds

    bounds = this.stage.bounds()

    return bounds
  }

  applyLayout(layout) {
    this.layout = layout
    this.updateLayout()
    if (
      this.views &&
      this.views.length > 0 &&
      this.layout.name === 'pre-paginated'
    ) {
      this.display(this.views.first().section)
    }
    // this.manager.layout(this.layout.format);
  }

  updateLayout() {
    if (!this.stage) {
      return
    }

    this._stageSize = this.stage.size()

    if (!this.isPaginated) {
      this.layout.calculate(this._stageSize.width, this._stageSize.height)
    } else {
      this.layout.calculate(
        this._stageSize.width,
        this._stageSize.height,
        this.settings.gap,
      )

      // Set the look ahead offset for what is visible
      this.settings.offset = this.layout.delta / this.layout.divisor

      // this.stage.addStyleRules("iframe", [{"margin-right" : this.layout.gap + "px"}]);
    }

    // Set the dimensions for views
    this.viewSettings.width = this.layout.width
    this.viewSettings.height = this.layout.height

    this.setLayout(this.layout)
  }

  setLayout(layout) {
    this.viewSettings.layout = layout

    this.mapping = new Mapping(
      layout.props,
      this.settings.direction,
      this.settings.axis,
    )

    if (this.views) {
      this.views.forEach(function (view) {
        if (view) {
          view.setLayout(layout)
        }
      })
    }
  }

  updateWritingMode(mode) {
    this.writingMode = mode
  }

  updateAxis(axis, forceUpdate) {
    if (!forceUpdate && axis === this.settings.axis) {
      return
    }

    this.settings.axis = axis

    this.stage && this.stage.axis(axis)

    this.viewSettings.axis = axis

    if (this.mapping) {
      this.mapping = new Mapping(
        this.layout.props,
        this.settings.direction,
        this.settings.axis,
      )
    }

    if (this.layout) {
      if (axis === 'vertical') {
        this.layout.spread('none')
      } else {
        this.layout.spread(this.layout.settings.spread)
      }
    }
  }

  updateFlow(flow, defaultScrolledOverflow = 'auto') {
    let isPaginated = flow === 'paginated' || flow === 'auto'

    this.isPaginated = isPaginated

    if (
      flow === 'scrolled-doc' ||
      flow === 'scrolled-continuous' ||
      flow === 'scrolled'
    ) {
      this.updateAxis('vertical')
    } else {
      this.updateAxis('horizontal')
    }

    this.viewSettings.flow = flow

    if (!this.settings.overflow) {
      this.overflow = isPaginated ? 'hidden' : defaultScrolledOverflow
    } else {
      this.overflow = this.settings.overflow
    }

    this.stage && this.stage.overflow(this.overflow)

    this.updateLayout()
  }

  getContents() {
    var contents = []
    if (!this.views) {
      return contents
    }
    this.views.forEach(function (view) {
      const viewContents = view && view.contents
      if (viewContents) {
        contents.push(viewContents)
      }
    })
    return contents
  }

  direction(dir = 'ltr') {
    this.settings.direction = dir

    this.stage && this.stage.direction(dir)

    this.viewSettings.direction = dir

    this.updateLayout()
  }

  isRendered() {
    return this.rendered
  }
}

//-- Enable binding events to Manager
EventEmitter(DefaultViewManager.prototype)

export default DefaultViewManager
