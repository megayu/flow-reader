import type Rendition from './rendition'
import type IframeView from './managers/views/iframe'
import type { Highlight } from './managers/helpers/annotation-pane'

export type AnnotationData = Record<string, unknown>
export type AnnotationCallback = (event: Event) => void
export type AnnotationStyles = Record<string, string | number>
interface AnnotationOptions {
  type: string
  cfiRange: string
  data?: AnnotationData
  sectionIndex: number
  cb?: AnnotationCallback
  className?: string
  styles?: AnnotationStyles
}

import EventEmitter from './utils/event-emitter'

import EpubCFI from './epubcfi'
import { EVENTS } from './utils/constants'

/**
 * Handles managing adding & removing Annotations
 * @param {Rendition} rendition
 * @class
 */
class Annotations {
  private declare rendition: Rendition
  declare _annotations: Record<string, Annotation>
  declare _annotationsBySectionIndex: Record<number, string[]>
  declare _batchDepth: number
  declare _removedBySection: Map<number, Set<string>>
  declare injectHook: (view: IframeView) => void
  declare clearHook: (view: IframeView) => void

  constructor(rendition: Rendition) {
    this.rendition = rendition
    this._annotations = {}
    this._annotationsBySectionIndex = {}
    this._batchDepth = 0
    this._removedBySection = new Map()

    this.injectHook = this.inject.bind(this)
    this.clearHook = this.clear.bind(this)
    this.rendition.hooks.render.register(this.injectHook)
    this.rendition.hooks.unloaded.register(this.clearHook)
  }

  /**
   * Add an annotation to store
   * @param {string} type Type of annotation to add: "highlight" or "underline"
   * @param {EpubCFI} cfiRange EpubCFI range to attach annotation to
   * @param {object} data Data to assign to annotation
   * @param {function} [cb] Callback after annotation is added
   * @param {string} className CSS class to assign to annotation
   * @param {object} styles CSS styles to assign to annotation
   * @returns {Annotation} annotation
   */
  add(
    type: string,
    cfiRange: string,
    data?: AnnotationData,
    cb?: AnnotationCallback,
    className?: string,
    styles?: AnnotationStyles,
    range?: Range | null,
  ) {
    let hash = encodeURI(cfiRange + type)
    let cfi = new EpubCFI(cfiRange)
    let sectionIndex = cfi.spinePos
    let annotation = new Annotation({
      type,
      cfiRange,
      data,
      sectionIndex,
      cb,
      className,
      styles,
    })

    this._flushSection(sectionIndex)
    this._annotations[hash] = annotation

    if (sectionIndex in this._annotationsBySectionIndex) {
      this._annotationsBySectionIndex[sectionIndex]!.push(hash)
    } else {
      this._annotationsBySectionIndex[sectionIndex] = [hash]
    }

    let views = this.rendition.session.getViews()

    views.forEach((view) => {
      if (annotation.sectionIndex === view.index) {
        annotation.attach(view, range)
      }
    })

    return annotation
  }

  /**
   * Remove an annotation from store
   * @param {EpubCFI} cfiRange EpubCFI range the annotation is attached to
   * @param {string} type Type of annotation to add: "highlight", "underline", "mark"
   */
  remove(cfiRange: string, type: string) {
    let hash = encodeURI(cfiRange + type)

    if (hash in this._annotations) {
      let annotation = this._annotations[hash]!

      if (type && annotation.type !== type) {
        return
      }

      let views = this.rendition.session.getViews()
      this._removeFromAnnotationBySectionIndex(annotation.sectionIndex, hash)
      views.forEach((view) => {
        if (annotation.sectionIndex === view.index) {
          annotation.detach(view)
        }
      })

      delete this._annotations[hash]
    }
  }

  /**
   * Remove an annotations by Section Index
   * @private
   */
  _removeFromAnnotationBySectionIndex(sectionIndex: number, hash: string) {
    if (this._batchDepth) {
      let removed = this._removedBySection.get(sectionIndex)
      if (!removed) {
        removed = new Set()
        this._removedBySection.set(sectionIndex, removed)
      }
      removed.add(hash)
      return
    }
    this._annotationsBySectionIndex[sectionIndex] = this._annotationsAt(
      sectionIndex,
    )!.filter((h) => h !== hash)
  }

  /**
   * Get annotations by Section Index
   * @private
   */
  _annotationsAt(index: number) {
    this._flushSection(index)
    return this._annotationsBySectionIndex[index]
  }

  _flushSection(index: number) {
    let removed = this._removedBySection.get(index)
    if (!removed) return
    this._removedBySection.delete(index)
    this._annotationsBySectionIndex[index] = this._annotationsBySectionIndex[
      index
    ]!.filter((hash) => !removed.has(hash))
  }

  /**
   * Add a highlight to the store
   * @param {EpubCFI} cfiRange EpubCFI range to attach annotation to
   * @param {object} data Data to assign to annotation
   * @param {function} cb Callback after annotation is clicked
   * @param {string} className CSS class to assign to annotation
   * @param {object} styles CSS styles to assign to annotation
   */
  highlight(
    cfiRange: string,
    data?: AnnotationData,
    cb?: AnnotationCallback,
    className?: string,
    styles?: AnnotationStyles,
    range?: Range | null,
  ) {
    return this.add('highlight', cfiRange, data, cb, className, styles, range)
  }

  updateHighlightStyles(
    cfiRange: string,
    styles: AnnotationStyles,
    bringToFront = false,
  ) {
    const annotation = this._annotations[encodeURI(cfiRange + 'highlight')]
    if (!annotation) return
    annotation.styles = Object.assign({}, annotation.styles, styles)
    this.rendition.session.getViews().forEach((view) => {
      const mark = view.highlights?.[cfiRange]?.mark
      if (!mark?.element) return
      Object.assign(mark.attributes, styles)
      for (const [name, value] of Object.entries(styles))
        mark.element.setAttribute(name, value)
      if (bringToFront) mark.element.parentNode!.appendChild(mark.element)
    })
  }

  /**
   * Add a underline to the store
   * @param {EpubCFI} cfiRange EpubCFI range to attach annotation to
   * @param {object} data Data to assign to annotation
   * @param {function} cb Callback after annotation is clicked
   * @param {string} className CSS class to assign to annotation
   * @param {object} styles CSS styles to assign to annotation
   */
  underline(
    cfiRange: string,
    data?: AnnotationData,
    cb?: AnnotationCallback,
    className?: string,
    styles?: AnnotationStyles,
  ) {
    return this.add('underline', cfiRange, data, cb, className, styles)
  }

  /**
   * Apply synchronous annotation mutations and redraw each visible view once.
   * @param {function} callback
   */
  batch<Result>(callback: () => Result) {
    let views = this.rendition.session.getViews()
    views.forEach((view) => view.beginAnnotationBatch?.())
    this._batchDepth += 1
    try {
      return callback()
    } finally {
      this._batchDepth -= 1
      if (!this._batchDepth) {
        this._removedBySection.forEach((_removed, index) =>
          this._flushSection(index),
        )
      }
      views.forEach((view) => view.endAnnotationBatch?.())
    }
  }

  /**
   * Hook for injecting annotation into a view
   * @param {View} view
   * @private
   */
  inject(view: IframeView) {
    let sectionIndex = view.index
    if (sectionIndex in this._annotationsBySectionIndex) {
      let annotations = this._annotationsAt(sectionIndex)
      view.beginAnnotationBatch?.()
      try {
        annotations!.forEach((hash) => {
          let annotation = this._annotations[hash]!
          annotation.attach(view)
        })
      } finally {
        view.endAnnotationBatch?.()
      }
    }
  }

  /**
   * Hook for removing annotation from a view
   * @param {View} view
   * @private
   */
  clear(view: IframeView) {
    let sectionIndex = view.index
    if (sectionIndex in this._annotationsBySectionIndex) {
      let annotations = this._annotationsAt(sectionIndex)
      view.beginAnnotationBatch?.()
      try {
        annotations!.forEach((hash) => {
          let annotation = this._annotations[hash]!
          annotation.detach(view)
        })
      } finally {
        view.endAnnotationBatch?.()
      }
    }
  }
  destroy() {
    this.rendition.hooks.render.deregister(this.injectHook)
    this.rendition.hooks.unloaded.deregister(this.clearHook)
    this._annotations = {}
    this._annotationsBySectionIndex = {}
    this._removedBySection.clear()
    this.rendition = undefined!
  }
}

/**
 * Annotation object
 * @class
 * @param {object} options
 * @param {string} options.type Type of annotation to add: "highlight" or "underline"
 * @param {EpubCFI} options.cfiRange EpubCFI range to attach annotation to
 * @param {object} options.data Data to assign to annotation
 * @param {int} options.sectionIndex Index in the Spine of the Section annotation belongs to
 * @param {function} [options.cb] Callback after annotation is clicked
 * @param {string} className CSS class to assign to annotation
 * @param {object} styles CSS styles to assign to annotation
 * @returns {Annotation} annotation
 */
class Annotation extends EventEmitter<{
  attach: [Highlight | undefined]
  detach: [void]
}> {
  declare type: string
  declare cfiRange: string
  declare data: AnnotationData | undefined
  declare sectionIndex: number
  declare mark: Highlight | undefined
  declare cb: AnnotationCallback | undefined
  declare className: string | undefined
  declare styles: AnnotationStyles | undefined

  constructor({
    type,
    cfiRange,
    data,
    sectionIndex,
    cb,
    className,
    styles,
  }: AnnotationOptions) {
    super()

    this.type = type
    this.cfiRange = cfiRange
    this.data = data
    this.sectionIndex = sectionIndex
    this.mark = undefined
    this.cb = cb
    this.className = className
    this.styles = styles
  }

  /**
   * Update stored data
   * @param {object} data
   */
  update(data: AnnotationData) {
    this.data = data
  }

  /**
   * Add to a view
   * @param {View} view
   */
  attach(view: IframeView, range?: Range | null) {
    let { cfiRange, data, type, cb, className, styles } = this
    let result

    if (type === 'highlight') {
      result = view.highlight(cfiRange, data, cb, className, styles, range)
    } else if (type === 'underline') {
      result = view.underline(cfiRange, data, cb, className, styles)
    }

    this.mark = result
    this.emit(EVENTS.ANNOTATION.ATTACH, result)
    return result
  }

  /**
   * Remove from a view
   * @param {View} view
   */
  detach(view: IframeView) {
    let { cfiRange, type } = this
    let result

    if (view) {
      if (type === 'highlight') {
        result = view.unhighlight(cfiRange)
      } else if (type === 'underline') {
        result = view.ununderline(cfiRange)
      }
    }

    this.mark = undefined
    this.emit(EVENTS.ANNOTATION.DETACH, result)
    return result
  }
}

export default Annotations
