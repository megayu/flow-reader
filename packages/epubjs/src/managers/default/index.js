import EventEmitter from 'eventemitter3'

import Mapping from '../../mapping'
import { EVENTS } from '../../utils/constants'
import { extend, defer, windowBounds, isNumber } from '../../utils/core'
import Queue from '../../utils/queue'
import scrollType from '../../utils/scrolltype'
import Stage from '../helpers/stage'
import Views from '../helpers/views'

function isUnavailableSectionError(error) {
  let status = error && error.status
  let message = String((error && error.message) || '')

  return status === 404 || /file not found|not found/i.test(message)
}

class DefaultViewManager extends EventEmitter {
  constructor(options) {
    super()

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
    this.prePaginatedSlotCache = new WeakMap()
    this.currentPrePaginatedSpread = undefined
    this._onUnload = this.onUnload.bind(this)
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

    window.addEventListener('unload', this._onUnload)

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

    window.removeEventListener('unload', this._onUnload)

    if (!this.settings.fullsize) {
      scroller = this.container
    } else {
      scroller = window
    }

    scroller.removeEventListener('scroll', this._onScroll)
    this._onScroll = undefined
  }

  onUnload() {
    this.destroy()
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
    if (this.suspendResize) {
      return
    }

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

  createView(section, forceRight, forceLeft, spreadSlot) {
    return new this.View(
      section,
      extend(this.viewSettings, { forceRight, forceLeft, spreadSlot }),
    )
  }

  isPrePaginatedSpread() {
    return this.layout.name === 'pre-paginated' && this.layout.divisor > 1
  }

  prePaginatedExplicitSlot(section) {
    let properties = section && section.properties
    if (!properties) return
    if (properties.includes('page-spread-left')) return 'left'
    if (properties.includes('page-spread-right')) return 'right'
  }

  oppositeSpreadSlot(slot) {
    return slot === 'right' ? 'left' : 'right'
  }

  prePaginatedSlot(section) {
    if (!section) return

    let cached = this.prePaginatedSlotCache.get(section)
    if (cached) return cached

    let first = section
    let previous = first.prev()
    while (previous) {
      first = previous
      previous = first.prev()
    }

    let firstSlot = this.prePaginatedExplicitSlot(first)
    if (!firstSlot) {
      let distance = 1
      let next = first.next()
      while (next) {
        let explicit = this.prePaginatedExplicitSlot(next)
        if (explicit) {
          firstSlot =
            distance % 2 === 0 ? explicit : this.oppositeSpreadSlot(explicit)
          break
        }
        distance += 1
        next = next.next()
      }
    }

    if (!firstSlot) {
      firstSlot = this.isRightFirstPagination() ? 'right' : 'left'
    }

    let current = first
    let slot = firstSlot
    this.prePaginatedSlotCache.set(current, slot)

    while (current !== section) {
      let next = current.next()
      if (!next) return
      slot =
        this.prePaginatedExplicitSlot(next) || this.oppositeSpreadSlot(slot)
      this.prePaginatedSlotCache.set(next, slot)
      current = next
    }

    return slot
  }

  prePaginatedSpreadContaining(section) {
    let slot = this.prePaginatedSlot(section)
    let earlierSlot = this.isRightFirstPagination() ? 'right' : 'left'
    let companion = slot === earlierSlot ? section.next() : section.prev()

    if (
      companion &&
      this.prePaginatedSlot(companion) !== this.oppositeSpreadSlot(slot)
    ) {
      companion = undefined
    }

    return slot === 'left'
      ? { left: section, right: companion }
      : { left: companion, right: section }
  }

  async renderPrePaginatedSpread(spread) {
    this.clear()
    this.updateLayout()

    let rightFirst = this.isRightFirstPagination()
    let entries = rightFirst
      ? [
          ['right', spread.right],
          ['left', spread.left],
        ]
      : [
          ['left', spread.left],
          ['right', spread.right],
        ]
    entries = entries.filter((entry) => entry[1])

    for (let index = 0; index < entries.length; index += 1) {
      let [slot, section] = entries[index]
      let onlyPage = entries.length === 1
      let forceRight = onlyPage && slot === 'right' && !rightFirst
      let forceLeft = onlyPage && slot === 'left' && rightFirst
      let action = index === 0 ? this.add : this.append
      await action.call(this, section, forceRight, forceLeft, slot)
    }

    this.currentPrePaginatedSpread = spread
    this.views.show()
  }

  displayPrePaginatedSpread(section) {
    return this.renderPrePaginatedSpread(
      this.prePaginatedSpreadContaining(section),
    )
  }

  handleNextPrePaginated(forceRight, section, action) {
    let next

    if (this.layout.name === 'pre-paginated' && this.layout.divisor > 1) {
      if (forceRight) return
      next = section.next()
      if (next && !next.properties.includes('page-spread-left')) {
        return action.call(this, next)
      }
    }
  }

  isReflowableSpread() {
    return this.isReflowablePagination() && this.layout.divisor > 1
  }

  isReflowablePagination() {
    return (
      this.isPaginated &&
      this.settings.axis === 'horizontal' &&
      this.layout &&
      this.layout.name === 'reflowable'
    )
  }

  paginationModel() {
    let writingMode =
      this.writingMode || this.settings.writingMode || 'horizontal-tb'
    let pageProgressionDirection = this.settings.direction || 'ltr'

    return {
      writingMode,
      pageProgressionAxis: this.settings.axis,
      pageProgressionDirection,
      spreadSlotOrder:
        pageProgressionDirection === 'rtl' ? 'right-first' : 'left-first',
    }
  }

  isRightFirstPagination() {
    let model = this.paginationModel()
    return (
      model.pageProgressionAxis === 'horizontal' &&
      model.pageProgressionDirection === 'rtl'
    )
  }

  isVerticalRtlGeometry() {
    let model = this.paginationModel()
    return (
      model.writingMode === 'vertical-rl' &&
      model.pageProgressionAxis === 'horizontal' &&
      model.pageProgressionDirection === 'rtl'
    )
  }

  reflowableSpreadEarlierPage(spread) {
    if (!spread) return
    return this.isRightFirstPagination() ? spread.right : spread.left
  }

  reflowableSpreadLaterPage(spread) {
    if (!spread) return
    return this.isRightFirstPagination() ? spread.left : spread.right
  }

  reflowableSpreadFromLogicalPages(earlier, later, properties) {
    let spread = this.isRightFirstPagination()
      ? { right: earlier, left: later, anchor: 'right' }
      : { left: earlier, right: later, anchor: 'left' }

    return extend(spread, properties || {})
  }

  canUseLogicalReflowableSpread() {
    return (
      this.isReflowablePagination() &&
      !this.settings.fullsize &&
      (this.isRightFirstPagination() || this.layout.divisor > 1)
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
      this.writingMode || this.settings.writingMode || 'horizontal-tb',
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

    // Hidden page-count views can belong to horizontal front matter or a
    // later vertical chapter. Their writing mode must not replace the mode
    // owned by the currently displayed reader view.

    this.views.append(view)

    try {
      await view.display(this.request)
      return this.cacheReflowablePageCount(view)
    } catch (err) {
      if (!isUnavailableSectionError(err)) {
        throw err
      }

      section.resourceAvailable = false
      console.warn('Skipping unavailable reflowable section', section.href, err)
      return 0
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

    // The temporary view keeps its own writing mode for measurement only.

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
      return this.reflowablePageForRenderedTarget(view, target)
    })
  }

  async findInDisplayedSection(section, query, signal) {
    const view = this.views && this.views.find(section)
    if (!view?.contents?.document || signal.aborted) return []
    const document = view.contents.document
    return section.findAsync(query, {
      signal,
      mapMatch: (match) => {
        if (signal.aborted || view.contents?.document !== document) return undefined
        const range = view.contents.range(match.cfi)
        const page = this.reflowablePageForRenderedTarget(view, match.cfi, range)
        return { ...match, range, pageIndex: page?.pageIndex ?? 0 }
      },
    }).then((matches) => signal.aborted || view.contents?.document !== document ? [] : matches.filter(Boolean))
  }

  reflowablePageForRenderedTarget(view, target, range) {
    let section = view && view.section
    if (!section) {
      return
    }

    this.cacheReflowablePageCount(view)

    let pageIndex = 0
    if (target) {
      let targetOffset = view.locationOf(target, range)
      let physicalOffset = this.isVerticalRtlGeometry()
        ? Math.max(view.width() - targetOffset.left - 1, 0)
        : Math.max(targetOffset.left, 0)
      pageIndex = Math.floor(physicalOffset / this.layout.pageWidth)
      pageIndex = Math.min(
        Math.max(pageIndex, 0),
        Math.max(this.viewPageCount(view) - 1, 0),
      )
    }

    return this.reflowablePage(section, pageIndex)
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
    if (this.isRightFirstPagination()) {
      return this.reflowableSpreadFromEarlier(left)
    }

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

  async reflowableSpreadFromEarlier(earlier) {
    earlier = await this.normalizeReflowablePage(earlier)
    if (!earlier) {
      return
    }

    let later
    if (this.layout.divisor > 1) {
      later = await this.nextReflowablePage(earlier)
    }

    let properties
    if (!later) {
      let pageCount = await this.measureReflowableSectionPageCount(
        earlier.section,
      )
      if (earlier.pageIndex === pageCount - 1) {
        properties = { endsAtSectionEnd: true }
      }
    }

    return this.reflowableSpreadFromLogicalPages(earlier, later, properties)
  }

  async reflowableSpreadEndingAt(right) {
    if (this.isRightFirstPagination()) {
      right = await this.normalizeReflowablePage(right)
      if (!right) {
        return
      }

      if (this.layout.divisor <= 1) {
        return this.reflowableSpreadFromEarlier(right)
      }

      return this.reflowableSpreadFromLogicalPages(
        await this.previousReflowablePage(right),
        right,
      )
    }

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

    let earlier = page
    if (this.layout.divisor > 1 && page.pageIndex % this.layout.divisor) {
      earlier = await this.previousReflowablePage(page)
    }

    return this.isRightFirstPagination()
      ? this.reflowableSpreadFromEarlier(earlier || page)
      : this.reflowableSpreadFromLeft(earlier || page)
  }

  async reflowableSpreadFromCurrentPhase(page) {
    page = await this.normalizeReflowablePage(page)
    if (!page || !this.currentReflowableSpread || this.layout.divisor <= 1) {
      return
    }

    let spread = this.currentReflowableSpread
    let earlier = this.reflowableSpreadEarlierPage(spread)
    let later = this.reflowableSpreadLaterPage(spread)
    let earlierInSection = this.sameReflowableSection(earlier, page)
    let laterInSection = this.sameReflowableSection(later, page)
    if (!earlierInSection && !laterInSection) {
      return
    }

    if (
      (earlierInSection && earlier.pageIndex === page.pageIndex) ||
      (laterInSection && later.pageIndex === page.pageIndex)
    ) {
      return spread
    }

    let divisor = this.layout.divisor
    let basePageIndex = earlierInSection
      ? earlier.pageIndex
      : later.pageIndex + 1
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

    let start = this.reflowablePage(page.section, startPageIndex)
    return this.isRightFirstPagination()
      ? this.reflowableSpreadFromEarlier(start)
      : this.reflowableSpreadFromLeft(start)
  }

  async reflowableSpreadForTarget(page, options) {
    if (options && options.alignTargetAsSpreadStart) {
      return this.isRightFirstPagination()
        ? this.reflowableSpreadFromEarlier(page)
        : this.reflowableSpreadFromLeft(page)
    }

    return (
      (await this.reflowableSpreadFromCurrentPhase(page)) ||
      this.reflowableSpreadContaining(page)
    )
  }

  async displayReflowableTarget(section, target) {
    return this.displayReflowableSpread(section, target)
  }

  viewMatchesCurrentLayoutStyle(view) {
    let currentSignature =
      (this.viewSettings && this.viewSettings.layoutStyleSignature) || ''
    let viewSignature =
      (view && view.settings && view.settings.layoutStyleSignature) || ''

    return viewSignature === currentSignature
  }

  renderedViewsForReflowableSpread(spread) {
    if (!spread) {
      return
    }

    let viewBySectionIndex = {}
    let addresses = [spread.left, spread.right].filter(Boolean)
    for (let address of addresses) {
      let view = this.views && this.views.find(address.section)
      if (!view || !this.viewMatchesCurrentLayoutStyle(view)) {
        return
      }

      viewBySectionIndex[address.section.index] = view
    }

    return viewBySectionIndex
  }

  trimRenderedViewsToReflowableSpread(spread) {
    if (!spread || !this.views) return

    let sectionIndexes = new Set(
      [spread.left, spread.right]
        .filter(Boolean)
        .map((address) => address.section.index),
    )
    this.views.slice().forEach((view) => {
      if (!sectionIndexes.has(view.section.index)) {
        this.views.remove(view)
      }
    })
  }

  tryApplyRenderedReflowableSpread(spread) {
    let viewBySectionIndex = this.renderedViewsForReflowableSpread(spread)
    if (!viewBySectionIndex) {
      return false
    }

    this.trimRenderedViewsToReflowableSpread(spread)
    let retainedViews = Object.values(viewBySectionIndex)
    if (retainedViews.length === 1 && retainedViews[0].writingMode) {
      // One manager mode cannot represent mixed adjacent sections. Once only
      // one section remains, its view owns the current pagination geometry.
      this.updateWritingMode(retainedViews[0].writingMode)
    }
    this.applyReflowableSpreadPosition(spread, viewBySectionIndex)
    return true
  }

  async renderReflowableSpread(spread) {
    if (this.isRightFirstPagination()) {
      return this.renderRightFirstReflowableSpread(spread)
    }

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
      let keepTerminalInLeftSlot =
        resolvedSpread.endsAtSectionEnd &&
        resolvedSpread.anchor === 'left' &&
        !resolvedSpread.right
      let leftPageIndex = keepTerminalInLeftSlot
        ? leftPageCount - 1
        : resolvedSpread.left.pageIndex
      resolvedSpread.left = this.clampReflowablePageToCount(
        this.reflowablePage(resolvedSpread.left.section, leftPageIndex),
        leftPageCount,
      )
      resolvedSpread.right = keepTerminalInLeftSlot
        ? undefined
        : await this.reflowablePageAfterRenderedLeft(
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

  async renderRightFirstReflowableSpread(spread) {
    let resolvedSpread = { ...spread }
    let viewBySectionIndex = {}

    this.clear()
    this.updateLayout()

    if (resolvedSpread.right) {
      resolvedSpread.right = await this.normalizeReflowablePage(
        resolvedSpread.right,
      )
    }
    if (resolvedSpread.left) {
      resolvedSpread.left = await this.normalizeReflowablePage(
        resolvedSpread.left,
      )
    }

    if (!resolvedSpread.right && !resolvedSpread.left) {
      this.views.show()
      return
    }

    if (resolvedSpread.endsAtSectionEnd) {
      let terminalSlot = resolvedSpread.left ? 'left' : 'right'
      let terminalPage = resolvedSpread[terminalSlot]
      let terminalPageCount = await this.measureReflowableSectionPageCount(
        terminalPage.section,
      )
      terminalPage = this.reflowablePage(
        terminalPage.section,
        Math.max(terminalPageCount - 1, 0),
      )

      if (terminalSlot === 'left') {
        resolvedSpread.left = terminalPage
        resolvedSpread.right =
          this.layout.divisor > 1
            ? await this.previousReflowablePage(terminalPage)
            : undefined
      } else {
        resolvedSpread.right = terminalPage
        resolvedSpread.left = undefined
      }
      resolvedSpread.anchor = terminalSlot
    }

    let rightPageCount
    if (resolvedSpread.right) {
      let rightView = await this.add(resolvedSpread.right.section)
      viewBySectionIndex[resolvedSpread.right.section.index] = rightView
      rightPageCount = this.cacheReflowablePageCount(rightView)
      resolvedSpread.right = this.clampReflowablePageToCount(
        resolvedSpread.right,
        rightPageCount,
      )
    }

    if (resolvedSpread.left) {
      if (
        resolvedSpread.right &&
        this.sameReflowableSection(resolvedSpread.right, resolvedSpread.left)
      ) {
        resolvedSpread.left = this.clampReflowablePageToCount(
          resolvedSpread.left,
          rightPageCount || 1,
        )
      } else {
        let leftView = resolvedSpread.right
          ? await this.append(resolvedSpread.left.section)
          : await this.add(resolvedSpread.left.section)
        viewBySectionIndex[resolvedSpread.left.section.index] = leftView
        let leftPageCount = this.cacheReflowablePageCount(leftView)
        resolvedSpread.left = this.clampReflowablePageToCount(
          resolvedSpread.left,
          leftPageCount,
        )
      }
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

  async displayReflowableSpread(section, target, options) {
    if (!section) {
      this.views.show()
      return
    }

    let visibleTargetView = this.views && this.views.find(section)
    if (
      visibleTargetView &&
      this.viewMatchesCurrentLayoutStyle(visibleTargetView)
    ) {
      let visiblePage = this.reflowablePageForRenderedTarget(
        visibleTargetView,
        target,
      )
      let visibleSpread = await this.reflowableSpreadForTarget(
        visiblePage,
        options,
      )
      if (this.tryApplyRenderedReflowableSpread(visibleSpread)) {
        return
      }
    }

    let previousSpread = this.currentReflowableSpread
    let viewBySectionIndex = {}

    this.clear()
    this.updateLayout()
    this.currentReflowableSpread = previousSpread

    let targetView = await this.add(section)
    viewBySectionIndex[section.index] = targetView

    let page = this.reflowablePageForRenderedTarget(targetView, target)
    let spread = await this.reflowableSpreadForTarget(page, options)
    if (!spread) {
      this.views.show()
      return
    }

    if (spread.left) {
      spread.left = await this.normalizeReflowablePage(spread.left)
    }
    if (spread.right) {
      spread.right = await this.normalizeReflowablePage(spread.right)
    }

    if (spread.left && !viewBySectionIndex[spread.left.section.index]) {
      let leftView = this.isRightFirstPagination()
        ? await this.append(spread.left.section)
        : await this.prepend(spread.left.section)
      viewBySectionIndex[spread.left.section.index] = leftView
      let leftPageCount = this.cacheReflowablePageCount(leftView)
      spread.left = this.clampReflowablePageToCount(spread.left, leftPageCount)
    }

    if (spread.right && !viewBySectionIndex[spread.right.section.index]) {
      let rightView = await this.append(spread.right.section)
      viewBySectionIndex[spread.right.section.index] = rightView
      let rightPageCount = this.cacheReflowablePageCount(rightView)
      spread.right = this.clampReflowablePageToCount(
        spread.right,
        rightPageCount,
      )
    }

    this.applyReflowableSpreadPosition(spread, viewBySectionIndex)
  }

  applyReflowableSpreadPosition(spread, viewBySectionIndex) {
    let left = spread.left
    let right = spread.right
    let pageWidth = this.layout.pageWidth
    let leftView = left && viewBySectionIndex[left.section.index]
    let rightView = right && viewBySectionIndex[right.section.index]

    if (this.isRightFirstPagination()) {
      if (leftView) {
        leftView.element.style.marginLeft = ''
        leftView.element.style.marginRight = ''
      }
      if (rightView) {
        rightView.element.style.marginRight = ''
        rightView.element.style.marginLeft =
          !left && this.layout.divisor > 1 ? pageWidth + 'px' : ''

        let rightPageCount = this.viewPageCount(rightView)
        let phaseOffset =
          (rightPageCount - this.layout.divisor - right.pageIndex) * pageWidth
        this.scrollTo(rightView.offset().left + phaseOffset, 0, true)
      }

      this.currentReflowableSpread = spread
      this.views.show()
      return
    }

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

    let current =
      this.reflowableSpreadLaterPage(spread) ||
      this.reflowableSpreadEarlierPage(spread)
    let nextEarlier = await this.nextReflowablePageFromRendered(current)
    if (!nextEarlier) {
      this.views.show()
      return
    }

    let nextSpread = this.isRightFirstPagination()
      ? await this.reflowableSpreadFromEarlier(nextEarlier)
      : await this.reflowableSpreadFromLeft(nextEarlier)
    if (!nextSpread) {
      this.views.show()
      return
    }

    if (this.tryApplyRenderedReflowableSpread(nextSpread)) {
      return
    }

    return this.renderReflowableSpread(nextSpread)
  }

  async previousReflowableSpread() {
    let spread = this.currentReflowableSpread
    if (!spread) {
      spread = this.reflowableSpreadFromVisible()
    }

    let current = this.reflowableSpreadEarlierPage(spread)
    let previousPage = await this.previousReflowablePageFromRendered(current)
    if (!previousPage) {
      this.views.show()
      return
    }

    let previousSpread =
      this.isRightFirstPagination() && this.layout.divisor <= 1
        ? await this.reflowableSpreadFromEarlier(previousPage)
        : await this.reflowableSpreadEndingAt(previousPage)
    if (!previousSpread) {
      this.views.show()
      return
    }

    if (current && !this.sameReflowableSection(current, previousPage)) {
      previousSpread.endsAtSectionEnd = true
    }

    if (this.tryApplyRenderedReflowableSpread(previousSpread)) {
      return
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

    return this.reflowableSpreadFromLogicalPages(pages[0], pages[1])
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

  display(section, target, options) {
    var displaying = new defer()
    var displayed = displaying.promise

    // Check if moving to target is needed
    if (target === section.href || isNumber(target)) {
      target = undefined
    }

    if (this.canUseLogicalReflowableSpread()) {
      this.displayReflowableSpread(section, target, options).then(
        function () {
          displaying.resolve()
        },
        function (err) {
          displaying.reject(err)
        },
      )
      return displayed
    }

    if (this.isPrePaginatedSpread()) {
      this.displayPrePaginatedSpread(section).then(
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
    let addedView

    this.add(section, forceRight)
      .then(
        function (view) {
          addedView = view
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
        async function () {
          if (this.canUseLogicalReflowableSpread() && addedView) {
            await this.displayReflowableSpread(section, target)
            displaying.resolve()
            return
          }

          if (targetOffset) {
            this.moveTo(targetOffset, targetWidth)
          }

          this.views.show()

          displaying.resolve()
        }.bind(this),
      )
      .catch((err) => displaying.reject(err))
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

  add(section, forceRight, forceLeft, spreadSlot) {
    var view = this.createView(section, forceRight, forceLeft, spreadSlot)

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

  append(section, forceRight, forceLeft, spreadSlot) {
    var view = this.createView(section, forceRight, forceLeft, spreadSlot)
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

  prepend(section, forceRight, forceLeft, spreadSlot) {
    var view = this.createView(section, forceRight, forceLeft, spreadSlot)

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

    if (this.isPrePaginatedSpread()) {
      let spread = this.currentPrePaginatedSpread
      let later =
        this.reflowableSpreadLaterPage(spread) ||
        this.reflowableSpreadEarlierPage(spread)
      let next = later && later.next()
      if (next) return this.displayPrePaginatedSpread(next)
      return
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
    } else if (!this.isPaginated && this.settings.axis === 'horizontal') {
      if (!this.scrollHorizontalByReadingDirection(this.layout.width, true)) {
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
            if (!this.isPaginated && this.settings.axis === 'horizontal') {
              this.scrollHorizontalToReadingBoundary(false, true)
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

    if (this.isPrePaginatedSpread()) {
      let spread = this.currentPrePaginatedSpread
      let earlier =
        this.reflowableSpreadEarlierPage(spread) ||
        this.reflowableSpreadLaterPage(spread)
      let previous = earlier && earlier.prev()
      if (previous) return this.displayPrePaginatedSpread(previous)
      return
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
    } else if (!this.isPaginated && this.settings.axis === 'horizontal') {
      if (!this.scrollHorizontalByReadingDirection(-this.layout.width, true)) {
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
            } else if (
              !this.isPaginated &&
              this.settings.axis === 'horizontal'
            ) {
              this.scrollHorizontalToReadingBoundary(true, true)
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
    } else if (this.isPrePaginatedSpread() && this.currentPrePaginatedSpread) {
      this.location = this.prePaginatedSpreadLocation()
    } else if (this.isPaginated && this.settings.axis === 'horizontal') {
      this.location = this.paginatedLocation()
    } else {
      this.location = this.scrolledLocation()
    }
    return this.location
  }

  prePaginatedSpreadLocation() {
    let spread = this.currentPrePaginatedSpread
    let firstSlot = this.isRightFirstPagination() ? 'right' : 'left'
    let secondSlot = this.oppositeSpreadSlot(firstSlot)

    return [firstSlot, secondSlot]
      .map((slot) => {
        let section = spread && spread[slot]
        let view = section && this.views.find(section)
        if (!view) {
          return
        }

        let mapping = this.mapping.page(
          view.contents,
          section.cfiBase,
          0,
          view.width(),
        )

        return {
          index: section.index,
          href: section.href,
          pages: [1],
          totalPages: this.viewPageCount(view),
          mapping,
          startSlot: slot,
          endSlot: slot,
        }
      })
      .filter(Boolean)
  }

  reflowableSpreadLocation() {
    let spread = this.currentReflowableSpread
    if (!spread) {
      return []
    }

    let addresses = []
    let firstSlot = this.isRightFirstPagination() ? 'right' : 'left'
    let secondSlot = firstSlot === 'right' ? 'left' : 'right'
    let first = spread[firstSlot]
    let second = spread[secondSlot]
    if (first) addresses.push(extend({ slot: firstSlot }, first))
    if (second) addresses.push(extend({ slot: secondSlot }, second))

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
        let start
        let end
        if (this.isVerticalRtlGeometry()) {
          start = Math.max(
            view.width() - (group.endPageIndex + 1) * pageWidth,
            0,
          )
          end = Math.min(
            view.width() - group.startPageIndex * pageWidth,
            view.width(),
          )
        } else {
          start = group.startPageIndex * pageWidth
          end = Math.min((group.endPageIndex + 1) * pageWidth, view.width())
        }
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
    let documentAsSinglePage =
      this.optsSettings.globalLayoutProperties &&
      this.optsSettings.globalLayoutProperties.flow === 'scrolled-doc'
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
        pages: documentAsSinglePage ? [1] : pages,
        totalPages: documentAsSinglePage ? 1 : totalPages,
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
        let viewportWidth =
          this.layout.name === 'pre-paginated'
            ? this.layout.spreadWidth
            : this.layout.width
        let viewportEnd = viewportStart + viewportWidth

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

      let spreadSlot =
        this.layout.name === 'pre-paginated' && this.layout.divisor > 1
          ? view.settings && view.settings.spreadSlot
          : undefined

      sections.push({
        index,
        href,
        pages,
        totalPages,
        mapping,
        startSlot: spreadSlot,
        endSlot: spreadSlot,
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

  horizontalScrollMaximum() {
    if (!this.container) return 0
    return Math.max(this.container.scrollWidth - this.container.clientWidth, 0)
  }

  horizontalPhysicalOffset() {
    if (!this.container) return 0

    let maximum = this.horizontalScrollMaximum()
    let offset = this.container.scrollLeft

    if (this.settings.direction === 'rtl') {
      if (this.settings.rtlScrollType === 'negative') {
        offset = maximum + offset
      } else if (this.settings.rtlScrollType === 'reverse') {
        offset = maximum - offset
      }
    }

    return Math.max(0, Math.min(maximum, offset))
  }

  scrollToHorizontalPhysicalOffset(offset, silent) {
    if (!this.container) return

    let maximum = this.horizontalScrollMaximum()
    let physicalOffset = Math.max(0, Math.min(maximum, offset))
    let scrollLeft = physicalOffset

    if (this.settings.direction === 'rtl') {
      if (this.settings.rtlScrollType === 'negative') {
        scrollLeft = physicalOffset - maximum
      } else if (this.settings.rtlScrollType === 'reverse') {
        scrollLeft = maximum - physicalOffset
      }
    }

    this.scrollTo(scrollLeft, this.container.scrollTop, silent)
  }

  scrollHorizontalByReadingDirection(distance, silent) {
    if (
      this.isPaginated ||
      this.settings.axis !== 'horizontal' ||
      !this.container
    ) {
      return false
    }

    let before = this.horizontalPhysicalOffset()
    let writingMode =
      this.writingMode || this.settings.writingMode || 'vertical-lr'
    let physicalDirection = writingMode.indexOf('vertical-rl') === 0 ? -1 : 1
    let target = Math.max(
      0,
      Math.min(
        this.horizontalScrollMaximum(),
        before + distance * physicalDirection,
      ),
    )

    if (Math.abs(target - before) <= 0.5) return false

    this.scrollToHorizontalPhysicalOffset(target, silent)
    return Math.abs(this.horizontalPhysicalOffset() - before) > 0.5
  }

  scrollHorizontalToReadingBoundary(end, silent) {
    if (
      this.isPaginated ||
      this.settings.axis !== 'horizontal' ||
      !this.container
    ) {
      return
    }

    let maximum = this.horizontalScrollMaximum()
    let writingMode =
      this.writingMode || this.settings.writingMode || 'vertical-lr'
    let startsAtRight = writingMode.indexOf('vertical-rl') === 0
    let offset = end === startsAtRight ? 0 : maximum

    this.scrollToHorizontalPhysicalOffset(offset, silent)
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
          view.settings = view.settings || {}
          view.settings.beforeLayout = this.viewSettings.beforeLayout
          view.settings.layoutStyleSignature =
            this.viewSettings.layoutStyleSignature
          view.setLayout(layout)
        }
      }, this)
    }
  }

  updateWritingMode(mode) {
    this.writingMode = mode
    this.settings.writingMode = mode
    this.viewSettings.writingMode = mode
  }

  updateAxis(axis, forceUpdate) {
    if (!forceUpdate && axis === this.settings.axis) {
      return
    }

    this.settings.axis = axis

    if (this.stage) {
      this.stage.axis(axis)
      if (!this.isPaginated && this.overflow) {
        this.stage.overflow(this.overflow)
      }
    }

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

export default DefaultViewManager
