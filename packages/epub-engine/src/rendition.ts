import type { Book } from './public-rendition'
import type Section from './section'
import type { Deferred } from './utils/core'
import type { ManagerLocation, ManagerSettings } from './managers/default'
import type { LayoutSettings, LayoutProperties } from './layout'
import type { PackagingMetadataObject } from './packaging'
import type { AnnotationData } from './annotations'
export interface RenditionDisplayOptions {
  alignTargetAsSpreadStart?: boolean
}

export interface RenditionOptions {
  width?: number | string
  height?: number | string
  ignoreClass?: string
  flow?:
    | 'auto'
    | 'paginated'
    | 'scrolled'
    | 'scrolled-continuous'
    | 'scrolled-doc'
  layout?: 'reflowable' | 'pre-paginated'
  spread?: (typeof RenditionSpread)[keyof typeof RenditionSpread]
  minSpreadWidth?: number
  stylesheet?: string
  resizeOnOrientationChange?: boolean
  script?: string
  overflow?: string
  defaultDirection?: 'ltr'
  allowScriptedContent?: boolean
  globalLayoutProperties?: {
    flow?: string
  }
}

export interface DisplayedLocation {
  index: number
  href: string
  cfi: string
  location?: number
  percentage?: number
  displayed: {
    page: number
    total: number
    slot?: 'left' | 'right'
  }
}

export interface Location {
  start: DisplayedLocation
  end: DisplayedLocation
  atStart?: boolean
  atEnd?: boolean
}

type Settings = Omit<
  RenditionOptions,
  | 'width'
  | 'height'
  | 'flow'
  | 'layout'
  | 'spread'
  | 'stylesheet'
  | 'script'
  | 'globalLayoutProperties'
> & {
  width?: number | string | null
  height?: number | string | null
  flow?: string | null
  layout?: string | null
  spread?: string | boolean | null
  stylesheet?: string | null
  script?: string | null
  globalLayoutProperties?: LayoutSettings
  orientation?: string
  direction?: string
  allowPopups?: boolean
}
export type RenditionEvents = {
  started: []
  attached: []
  displayed: [Section]
  displayerror: [unknown]
  rendered: [Section, IframeView]
  removed: [Section, IframeView]
  resized: [{ width: number; height: number }, string | undefined]
  orientationchange: [number]
  relocated: [Location, { requestId?: number }]
  externalLinkClicked: [string]
  markClicked: [string, AnnotationData, Contents | undefined]
  selected: [string, Contents]
  layout: [LayoutProperties, Partial<LayoutProperties>]
  wheel: [WheelEvent, Contents | undefined]
} & {
  [K in (typeof DOM_EVENTS)[number]]: [
    K extends keyof DocumentEventMap ? DocumentEventMap[K] : Event,
    Contents,
  ]
}
import EventEmitter from './utils/event-emitter'

import Annotations from './annotations'
import Contents from './contents'
import EpubCFI from './epubcfi'
import Layout from './layout'
import DefaultViewManager from './managers/default/index'
import IframeView from './managers/views/iframe'
import Themes from './themes'
import { EVENTS, DOM_EVENTS } from './utils/constants'
import { extend, defer } from './utils/core'
import Hook from './utils/hook'
import Queue from './utils/queue'
import ReaderSession from './reader-session'
import { ensureHtmlHead } from './utils/replacements'

export const RenditionSpread = Object.freeze({
  Auto: 'auto',
  None: 'none',
  Always: 'always',
})

/**
 * Displays an Epub as a series of Views for each Section.
 * Requires Manager and View class to handle specifics of rendering
 * the section content.
 * @class
 * @param {Book} book
 * @param {object} [options]
 * @param {number} [options.width]
 * @param {number} [options.height]
 * @param {string} [options.ignoreClass] class for the cfi parser to ignore
 * @param {string} [options.layout] layout to force
 * @param {string} [options.spread] force spread value
 * @param {number} [options.minSpreadWidth] overridden by spread: none (never) / both (always)
 * @param {string} [options.stylesheet] url of stylesheet to be injected
 * @param {boolean} [options.resizeOnOrientationChange] false to disable orientation events
 * @param {string} [options.script] url of script to be injected
 * @param {string} [options.defaultDirection='ltr'] default text direction
 * @param {boolean} [options.allowScriptedContent=false] enable running scripts in content
 * @param {boolean} [options.allowPopups=false] enable opening popup in content
 */
class Rendition extends EventEmitter<RenditionEvents> {
  declare settings: Settings
  declare book: Book
  declare session: ReaderSession
  declare hooks: {
    content: Hook<[Contents, Rendition]>
    unloaded: Hook<[IframeView, Rendition]>
    render: Hook<[IframeView, Rendition]>
  }
  declare spineContentHooks: ((doc: Document, section: Section) => void)[]
  declare themes: Themes
  declare annotations: Annotations
  declare epubcfi: EpubCFI
  declare q: Queue<Rendition>
  declare location: Location | undefined
  declare starting: Deferred<void>
  declare started: Promise<void>
  declare displaying: Deferred<Section | void> | undefined
  declare manager: DefaultViewManager
  declare _layout: Layout
  declare destroyed: boolean | undefined
  declare _displayRequestId: number
  declare _locationRequestId: number
  declare _flowSuppressResizeRedisplay: boolean | undefined

  constructor(book: Book, options?: RenditionOptions) {
    super()

    this.settings = extend(this.settings || {}, {
      width: null,
      height: null,
      ignoreClass: '',
      flow: null,
      layout: null,
      spread: null,
      minSpreadWidth: 800,
      stylesheet: null,
      resizeOnOrientationChange: true,
      script: null,
      defaultDirection: 'ltr',
      allowScriptedContent: false,
      allowPopups: false,
    })

    extend(this.settings, options)

    this.book = book
    this.session = new ReaderSession(this)

    /**
     * Adds Hook methods to the Rendition prototype
     * @member {object} hooks
     * @property {Hook} hooks.content
     * @memberof Rendition
     */
    this.hooks = {} as Rendition['hooks']
    this.hooks.content = new Hook(this)
    this.hooks.unloaded = new Hook(this)
    this.hooks.render = new Hook(this)

    this.hooks.content.register(this.handleLinks.bind(this))
    this.hooks.content.register(this.passEvents.bind(this))
    this.hooks.content.register(this.adjustImages.bind(this))

    this.spineContentHooks = [this.injectIdentifier.bind(this)]

    if (this.settings.stylesheet) {
      this.spineContentHooks.push(this.injectStylesheet.bind(this))
    }

    if (this.settings.script) {
      this.spineContentHooks.push(this.injectScript.bind(this))
    }
    this.book.spine.hooks.content.register(this.spineContentHooks)

    /**
     * @member {Themes} themes
     * @memberof Rendition
     */
    this.themes = new Themes(this)

    /**
     * @member {Annotations} annotations
     * @memberof Rendition
     */
    this.annotations = new Annotations(this)

    this.epubcfi = new EpubCFI()

    this.q = new Queue(this)

    /**
     * A Rendered Location Range
     * @typedef location
     * @type {Object}
     * @property {object} start
     * @property {string} start.index
     * @property {string} start.href
     * @property {object} start.displayed
     * @property {EpubCFI} start.cfi
     * @property {number} start.location
     * @property {number} start.percentage
     * @property {number} start.displayed.page
     * @property {number} start.displayed.total
     * @property {object} end
     * @property {string} end.index
     * @property {string} end.href
     * @property {object} end.displayed
     * @property {EpubCFI} end.cfi
     * @property {number} end.location
     * @property {number} end.percentage
     * @property {number} end.displayed.page
     * @property {number} end.displayed.total
     * @property {boolean} atStart
     * @property {boolean} atEnd
     * @memberof Rendition
     */
    this.location = undefined

    // Hold queue until book is opened
    this.q.enqueue(this.book.opened)

    this.starting = new defer()
    /**
     * @member {promise} started returns after the rendition has started
     * @memberof Rendition
     */
    this.started = this.starting.promise

    // Block the queue until rendering is started
    this.q.enqueue(this.start)
  }

  /**
   * Start the rendering
   * @return {Promise} rendering has started
   */
  start() {
    if (this.destroyed) return
    if (
      !this.settings.layout &&
      (this.book.package.metadata.layout === 'pre-paginated' ||
        this.book.displayOptions.fixedLayout === 'true')
    ) {
      this.settings.layout = 'pre-paginated'
    }
    switch (this.book.package.metadata.spread) {
      case 'none':
        this.settings.spread = 'none'
        break
      case 'both':
        this.settings.spread = true
        break
    }

    if (!this.manager) {
      this.manager = new DefaultViewManager({
        view: IframeView,
        queue: this.q,
        request: this.book.load.bind(this.book),
        settings: this.settings,
      })
    }

    this.direction(
      this.book.package.metadata.direction || this.settings.defaultDirection,
    )

    // Parse metadata to get layout props
    this.settings.globalLayoutProperties = this.determineLayoutProperties(
      this.book.package.metadata,
    )

    this.flow(this.settings.globalLayoutProperties.flow!)

    this.layout(this.settings.globalLayoutProperties)

    // Listen for displayed views
    this.manager.on(EVENTS.MANAGERS.ADDED, this.afterDisplayed.bind(this))
    this.manager.on(EVENTS.MANAGERS.REMOVED, this.afterRemoved.bind(this))

    // Listen for resizing
    this.manager.on(EVENTS.MANAGERS.RESIZED, this.onResized.bind(this))

    // Listen for rotation
    this.manager.on(
      EVENTS.MANAGERS.ORIENTATION_CHANGE,
      this.onOrientationChange.bind(this),
    )

    // Listen for scroll changes
    this.manager.on(EVENTS.MANAGERS.SCROLLED, () => this.reportLocation())

    /**
     * Emit that rendering has started
     * @event started
     * @memberof Rendition
     */
    this.emit(EVENTS.RENDITION.STARTED)

    // Start processing queue
    this.starting.resolve()
  }

  /**
   * Call to attach the container to an element in the dom
   * Container must be attached before rendering can begin
   * @param  {element} element to attach to
   * @return {Promise}
   */
  attachTo(element: HTMLElement) {
    return this.q.enqueue(
      function (this: Rendition) {
        // Start rendering
        this.manager.render(element, {
          width: this.settings.width,
          height: this.settings.height,
        })

        /**
         * Emit that rendering has attached to an element
         * @event attached
         * @memberof Rendition
         */
        this.emit(EVENTS.RENDITION.ATTACHED)
      }.bind(this),
    )
  }

  /**
   * Display a point in the book
   * The request will be added to the rendering Queue,
   * so it will wait until book is opened, rendering started
   * and all other rendering tasks have finished to be called.
   * @param  {string} target Url or EpubCFI
   * @return {Promise}
   */
  display(target?: string | number, options?: RenditionDisplayOptions) {
    if (this.destroyed) return Promise.resolve()
    if (this.displaying) {
      this.displaying.resolve()
    }

    this._displayRequestId = (this._displayRequestId || 0) + 1
    this.beginLocationRequest()
    const displayRequestId = this._displayRequestId
    const locationRequestId = this._locationRequestId

    return this.q
      .enqueue(this._display, target, displayRequestId, options)
      .then((section) => {
        if (displayRequestId !== this._displayRequestId) {
          return section
        }

        return this.reportLocation(locationRequestId).then(() => section)
      })
  }

  /**
   * Tells the manager what to display immediately
   * @private
   * @param  {string} target Url or EpubCFI
   * @return {Promise}
   */
  _display(
    target: string | number | undefined,
    requestId: number,
    options?: RenditionDisplayOptions,
  ) {
    if (!this.book) {
      return
    }
    var displaying = new defer<Section | void>()
    var displayed = displaying.promise
    var section: Section | null | undefined
    this.displaying = displaying

    if (requestId !== this._displayRequestId) {
      displaying.resolve()
      return displayed
    }

    section = this.book.spine.get(target)

    if (!section) {
      this.displaying = undefined
      displaying.reject(new Error('No Section Found'))
      return displayed
    }

    this.manager.display(section, target, options).then(
      () => {
        if (requestId !== this._displayRequestId) {
          displaying.resolve(section!)
          return
        }

        displaying.resolve(section!)
        this.displaying = undefined

        /**
         * Emit that a section has been displayed
         * @event displayed
         * @param {Section} section
         * @memberof Rendition
         */
        this.emit(EVENTS.RENDITION.DISPLAYED, section!)
      },
      (err) => {
        if (requestId !== this._displayRequestId) {
          displaying.resolve()
          return
        }

        /**
         * Emit that has been an error displaying
         * @event displayError
         * @param {Section} section
         * @memberof Rendition
         */
        this.displaying = undefined
        this.emit(EVENTS.RENDITION.DISPLAY_ERROR, err)
        displaying.reject(err)
      },
    )

    return displayed
  }

  /**
   * Report what section has been displayed
   * @private
   * @param  {*} view
   */
  afterDisplayed(view: IframeView) {
    view.on(EVENTS.VIEWS.MARK_CLICKED, (cfiRange, data) =>
      this.triggerMarkEvent(cfiRange, data, view.contents),
    )
    view.on(EVENTS.VIEWS.WHEEL, (event) =>
      this.emit(EVENTS.VIEWS.WHEEL, event, view.contents),
    )

    this.hooks.render
      .trigger(view, this)
      .then(() => {
        if (this.destroyed) return
        if (view.contents) {
          return this.hooks.content.trigger(view.contents, this).then(() => {
            if (this.destroyed) return
            /**
             * Emit that a section has been rendered
             * @event rendered
             * @param {Section} section
             * @param {View} view
             * @memberof Rendition
             */
            this.emit(EVENTS.RENDITION.RENDERED, view.section, view)
          })
        } else {
          this.emit(EVENTS.RENDITION.RENDERED, view.section, view)
        }
      })
      .catch((error) => {
        if (!this.destroyed) this.emit(EVENTS.RENDITION.DISPLAY_ERROR, error)
      })
  }

  /**
   * Report what has been removed
   * @private
   * @param  {*} view
   */
  afterRemoved(view: IframeView) {
    if (this.destroyed) return
    this.hooks.unloaded
      .trigger(view, this)
      .then(() => {
        if (this.destroyed) return
        /**
         * Emit that a section has been removed
         * @event removed
         * @param {Section} section
         * @param {View} view
         * @memberof Rendition
         */
        this.emit(EVENTS.RENDITION.REMOVED, view.section, view)
      })
      .catch((error) => {
        if (!this.destroyed) this.emit(EVENTS.RENDITION.DISPLAY_ERROR, error)
      })
  }

  /**
   * Report resize events and display the last seen location
   * @private
   */
  onResized(size: { width: number; height: number }, epubcfi?: string) {
    /**
     * Emit that the rendition has been resized
     * @event resized
     * @param {number} width
     * @param {height} height
     * @param {string} epubcfi (optional)
     * @memberof Rendition
     */
    this.emit(
      EVENTS.RENDITION.RESIZED,
      {
        width: size.width,
        height: size.height,
      },
      epubcfi,
    )

    if (this._flowSuppressResizeRedisplay) {
      return
    }

    if (this.location && this.location.start) {
      this.display(epubcfi || this.location.start.cfi).catch((err) => {
        this.emit(EVENTS.RENDITION.DISPLAY_ERROR, err)
      })
    }
  }

  /**
   * Report orientation events and display the last seen location
   * @private
   */
  onOrientationChange(orientation: number) {
    /**
     * Emit that the rendition has been rotated
     * @event orientationchange
     * @param {string} orientation
     * @memberof Rendition
     */
    this.emit(EVENTS.RENDITION.ORIENTATION_CHANGE, orientation)
  }

  /**
   * Trigger a resize of the views
   * @param {number} [width]
   * @param {number} [height]
   * @param {string} [epubcfi] (optional)
   */
  resize(width?: number | string, height?: number | string, epubcfi?: string) {
    if (width) {
      this.settings.width = width
    }
    if (height) {
      this.settings.height = height
    }
    this.manager.resize(width, height, epubcfi)
  }

  /**
   * Go to the next "page" in the rendition
   * @return {Promise}
   */
  next() {
    if (this.destroyed) return Promise.resolve()
    let requestId = this.beginLocationRequest()

    return this.q
      .enqueue(this.manager.next.bind(this.manager))
      .then(() => this.reportLocation(requestId))
  }

  /**
   * Go to the previous "page" in the rendition
   * @return {Promise}
   */
  prev() {
    if (this.destroyed) return Promise.resolve()
    let requestId = this.beginLocationRequest()

    return this.q
      .enqueue(this.manager.prev.bind(this.manager))
      .then(() => this.reportLocation(requestId))
  }

  //-- http://www.idpf.org/epub/301/spec/epub-publications.html#meta-properties-rendering
  /**
   * Determine the Layout properties from metadata and settings
   * @private
   * @param  {object} metadata
   * @return {object} properties
   */
  determineLayoutProperties(metadata: PackagingMetadataObject) {
    var properties
    var layout = this.settings.layout || metadata.layout || 'reflowable'
    var spread = this.settings.spread || metadata.spread || 'auto'
    var orientation =
      this.settings.orientation || metadata.orientation || 'auto'
    var flow = this.settings.flow || metadata.flow || 'auto'
    var viewport = metadata.viewport || ''
    var minSpreadWidth =
      this.settings.minSpreadWidth || metadata.minSpreadWidth || 800
    var direction = this.settings.direction || metadata.direction || 'ltr'

    // Image-first publications use "roll" for authored visual plates that
    // require fixed-page sizing and spread placement.
    if (layout === 'roll') {
      layout = 'pre-paginated'
    }
    if (flow === 'scrolled-continuous') {
      flow = 'scrolled-doc'
    }
    if (flow === 'scrolled-doc') {
      spread = 'none'
    }

    if (
      (this.settings.width === 0 || (this.settings.width as number) > 0) &&
      (this.settings.height === 0 || (this.settings.height as number) > 0)
    ) {
      // viewport = "width="+this.settings.width+", height="+this.settings.height+"";
    }

    properties = {
      layout: layout,
      spread: spread,
      orientation: orientation,
      flow: flow,
      viewport: viewport,
      minSpreadWidth: minSpreadWidth,
      direction: direction,
    }

    return properties
  }

  /**
   * Adjust the flow of the rendition to paginated or scrolled
   * (package scrolled-continuous is normalized to scrolled-doc)
   * @param  {string} flow
   */
  flow(flow: string) {
    var _flow = flow
    if (
      flow === 'scrolled' ||
      flow === 'scrolled-doc' ||
      flow === 'scrolled-continuous'
    ) {
      _flow = 'scrolled'
    }

    if (flow === 'auto' || flow === 'paginated') {
      _flow = 'paginated'
    }

    this.settings.flow = flow

    if (this._layout) {
      this._layout.flow(_flow)
    }

    if (this.manager && this._layout) {
      this.manager.applyLayout(this._layout)
    }

    if (this.manager) {
      this.manager.updateFlow(_flow)
    }

    if (this.manager && this.manager.isRendered() && this.location) {
      this.manager.clear()
      this.display(this.location.start.cfi).catch((err) => {
        this.emit(EVENTS.RENDITION.DISPLAY_ERROR, err)
      })
    }
  }

  /**
   * Adjust the layout of the rendition to reflowable or pre-paginated
   * @param  {object} settings
   */
  layout(settings?: LayoutSettings) {
    if (settings) {
      this._layout = new Layout(settings)
      this._layout.spread(settings.spread, this.settings.minSpreadWidth)

      // this.mapping = new Mapping(this._layout.props);

      this._layout.on(EVENTS.LAYOUT.UPDATED, (props, changed) => {
        this.emit(EVENTS.RENDITION.LAYOUT, props, changed)
      })
    }

    if (this.manager && this._layout) {
      this.manager.applyLayout(this._layout)
    }

    return this._layout
  }

  /**
   * Adjust if the rendition uses spreads
   * @param  {string} spread none | auto
   * @param  {int} [min] min width to use spreads at
   */
  spread(spread: string | boolean, min?: number) {
    this.settings.spread = spread

    if (min) {
      this.settings.minSpreadWidth = min
    }

    if (this._layout) {
      this._layout.spread(spread, min)
    }

    if (this.manager && this.manager.isRendered()) {
      this.manager.updateLayout()
    }
  }

  /**
   * Adjust the direction of the rendition
   * @param  {string} dir
   */
  direction(dir?: string) {
    this.settings.direction = dir || 'ltr'

    if (this.manager) {
      this.manager.direction(this.settings.direction)
    }

    if (this.manager && this.manager.isRendered() && this.location) {
      this.manager.clear()
      this.display(this.location.start.cfi).catch((err) => {
        this.emit(EVENTS.RENDITION.DISPLAY_ERROR, err)
      })
    }
  }

  /**
   * Report the current location
   * @fires relocated
   * @fires locationChanged
   */
  reportLocation(requestId?: number) {
    if (this.destroyed) return Promise.resolve()
    return this.q.enqueue(
      function reportedLocation(this: Rendition) {
        return new Promise<Location | void>(
          function (
            this: Rendition,
            resolve: (value?: Location) => void,
            reject: (error: unknown) => void,
          ) {
            requestAnimationFrame(
              function reportedLocationAfterRAF(this: Rendition) {
                if (
                  this.destroyed ||
                  (typeof requestId === 'number' &&
                    requestId !== this._locationRequestId)
                ) {
                  resolve()
                  return
                }

                var emitLocation = function (
                  this: Rendition,
                  result: ManagerLocation[],
                ) {
                  if (
                    this.destroyed ||
                    (typeof requestId === 'number' &&
                      requestId !== this._locationRequestId)
                  ) {
                    resolve()
                    return
                  }
                  let located = this.located(result)

                  if (!located || !located.start || !located.end) {
                    resolve()
                    return
                  }

                  this.location = located

                  /**
                   * @event relocated
                   * @type {displayedLocation}
                   * @memberof Rendition
                   */
                  this.emit(EVENTS.RENDITION.RELOCATED, this.location, {
                    requestId,
                  })
                  resolve(this.location)
                }.bind(this)

                try {
                  var location = this.manager.currentLocation()
                  if (location) {
                    emitLocation(location)
                  } else {
                    resolve()
                  }
                } catch (error) {
                  reject(error)
                }
              }.bind(this),
            )
          }.bind(this),
        )
      }.bind(this),
    )
  }

  beginLocationRequest() {
    this._locationRequestId = (this._locationRequestId || 0) + 1
    return this._locationRequestId
  }

  /**
   * Creates a Rendition#locationRange from location
   * passed by the Manager
   * @returns {displayedLocation}
   * @private
   */
  located(
    location: ManagerLocation[],
  ): Location | { start?: never; end?: never } {
    if (!location.length) {
      return {}
    }
    let start = location[0]!
    let end = location[location.length - 1]!

    let located: Location = {
      start: {
        index: start.index,
        href: start.href,
        cfi: start.mapping!.start,
        displayed: {
          page: start.pages[0] || 1,
          total: start.totalPages,
          slot: start.startSlot,
        },
      },
      end: {
        index: end.index,
        href: end.href,
        cfi: end.mapping!.end,
        displayed: {
          page: end.pages[end.pages.length - 1] || 1,
          total: end.totalPages,
          slot: end.endSlot,
        },
      },
    }

    if (
      end.index === this.book.spine.last()!.index &&
      located.end.displayed.page >= located.end.displayed.total
    ) {
      located.atEnd = true
    }

    if (
      start.index === this.book.spine.first()!.index &&
      located.start.displayed.page === 1
    ) {
      located.atStart = true
    }

    return located
  }

  /**
   * Remove and Clean Up the Rendition
   */
  destroy() {
    if (this.destroyed) return
    this.destroyed = true
    this.beginLocationRequest()
    this._displayRequestId = (this._displayRequestId || 0) + 1
    this.session.destroy()
    this.q.stop()
    this.displaying?.resolve()
    this.displaying = undefined
    this.starting.resolve()
    for (const hook of this.spineContentHooks)
      this.book?.spine?.hooks?.content?.deregister(hook)
    this.spineContentHooks = []
    this.manager?.destroy()
    this.annotations.destroy()
    this.themes.destroy()
    for (const hook of Object.values(this.hooks)) hook.clear()
    this.removeAllListeners()
    this.manager = undefined!
    this.book = undefined!
    this.location = undefined
  }

  /**
   * Pass the events from a view's Contents
   * @private
   * @param  {Contents} view contents
   */
  passEvents(contents: Contents) {
    DOM_EVENTS.forEach((e) => {
      contents.on(e, (ev) => this.triggerViewEvent(ev, contents))
    })

    contents.on(EVENTS.CONTENTS.SELECTED, (e) =>
      this.triggerSelectedEvent(e, contents),
    )
  }

  /**
   * Emit events passed by a view
   * @private
   * @param  {event} e
   */
  triggerViewEvent(e: Event, contents: Contents) {
    this.emit(e.type as (typeof DOM_EVENTS)[number], e, contents)
  }

  /**
   * Emit a selection event's CFI Range passed from a a view
   * @private
   * @param  {string} cfirange
   */
  triggerSelectedEvent(cfirange: string, contents: Contents) {
    /**
     * Emit that a text selection has occurred
     * @event selected
     * @param {string} cfirange
     * @param {Contents} contents
     * @memberof Rendition
     */
    this.emit(EVENTS.RENDITION.SELECTED, cfirange, contents)
  }

  /**
   * Emit a markClicked event with the cfiRange and data from a mark
   * @private
   * @param  {EpubCFI} cfirange
   */
  triggerMarkEvent(
    cfiRange: string,
    data: AnnotationData,
    contents?: Contents,
  ) {
    /**
     * Emit that a mark was clicked
     * @event markClicked
     * @param {EpubCFI} cfirange
     * @param {object} data
     * @param {Contents} contents
     * @memberof Rendition
     */
    this.emit(EVENTS.RENDITION.MARK_CLICKED, cfiRange, data, contents)
  }

  /**
   * Hook to adjust images to fit in columns
   * @param  {Contents} contents
   * @private
   */
  adjustImages(contents: Contents) {
    if (this._layout.name === 'pre-paginated') {
      return new Promise<void>(function (resolve) {
        resolve()
      })
    }

    let computed = contents.window.getComputedStyle(contents.content, null)
    let height =
      (contents.content.offsetHeight -
        (parseFloat(computed.paddingTop) +
          parseFloat(computed.paddingBottom))) *
      0.95
    let horizontalPadding =
      parseFloat(computed.paddingLeft) + parseFloat(computed.paddingRight)

    contents.addStylesheetRules({
      img: {
        'max-width':
          (this._layout.columnWidth
            ? `min(100%, ${this._layout.columnWidth - horizontalPadding}px)`
            : '100%') + '!important',
        'max-height': height + 'px' + '!important',
        'object-fit': 'contain',
        'page-break-inside': 'avoid',
        'break-inside': 'avoid',
        'box-sizing': 'border-box',
      },
      svg: {
        'max-width':
          (this._layout.columnWidth
            ? `min(100%, ${this._layout.columnWidth - horizontalPadding}px)`
            : '100%') + '!important',
        'max-height': height + 'px' + '!important',
        'page-break-inside': 'avoid',
        'break-inside': 'avoid',
      },
    })

    return new Promise<void>(function (resolve, reject) {
      // Wait to apply
      setTimeout(function (this: Rendition) {
        resolve()
      }, 1)
    })
  }

  /**
   * Get the Contents object of each rendered view
   * @returns {Contents[]}
   */
  getContents() {
    return this.manager ? this.manager.getContents() : []
  }

  /**
   * Hook to handle link clicks in rendered content
   * @param  {Contents} contents
   * @private
   */
  handleLinks(contents: Contents) {
    if (contents) {
      contents.on(EVENTS.CONTENTS.LINK_CLICKED, (href, meta) => {
        if (meta && meta.external) {
          this.emit(EVENTS.RENDITION.EXTERNAL_LINK_CLICKED, href)
          return
        }

        let relative = this.book.path.relative(href)
        this.display(relative).catch((err) => {
          this.emit(EVENTS.RENDITION.DISPLAY_ERROR, err)
        })
      })
    }
  }

  /**
   * Hook to handle injecting stylesheet before
   * a Section is serialized
   * @param  {document} doc
   * @param  {Section} section
   * @private
   */
  injectStylesheet(doc: Document, section: Section) {
    const head = ensureHtmlHead(doc)
    if (!head) return
    let style = doc.createElement('link')
    style.setAttribute('type', 'text/css')
    style.setAttribute('rel', 'stylesheet')
    style.setAttribute('href', this.settings.stylesheet!)
    head.appendChild(style)
  }

  /**
   * Hook to handle injecting scripts before
   * a Section is serialized
   * @param  {document} doc
   * @param  {Section} section
   * @private
   */
  injectScript(doc: Document, section: Section) {
    const head = ensureHtmlHead(doc)
    if (!head) return
    let script = doc.createElement('script')
    script.setAttribute('type', 'text/javascript')
    script.setAttribute('src', this.settings.script!)
    script.textContent = ' ' // Needed to prevent self closing tag
    head.appendChild(script)
  }

  /**
   * Hook to handle the document identifier before
   * a Section is serialized
   * @param  {document} doc
   * @param  {Section} section
   * @private
   */
  injectIdentifier(doc: Document, section: Section) {
    const head = ensureHtmlHead(doc)
    if (!head) return
    let ident = this.book.packaging.metadata.identifier
    let meta = doc.createElement('meta')
    meta.setAttribute('name', 'dc.relation.ispartof')
    if (ident) {
      meta.setAttribute('content', ident)
    }
    head.appendChild(meta)
  }
}

export { Rendition }
export default Rendition
