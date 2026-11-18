import type DefaultViewManager from '../default'
import type IframeView from '../views/iframe'
import type Section from '../../section'

import { EVENTS } from '../../utils/constants'

function isUnavailableSectionError(error: unknown) {
  let status = error && (error as { status?: number }).status
  let message = String((error && (error as { message?: string }).message) || '')

  return status === 404 || /file not found|not found/i.test(message)
}

/** Owns measured page counts and the temporary views needed to measure a section. */
export default class SectionMeasurements {
  declare manager: DefaultViewManager | undefined
  declare pageCounts: Record<string, number>

  constructor(manager: DefaultViewManager) {
    this.manager = manager
    this.pageCounts = {}
  }

  clear() {
    this.pageCounts = {}
  }

  layoutKey(section: Section) {
    const manager = this.manager
    if (!manager!.layout) {
      return section.index + ':unknown'
    }

    return [
      section.index,
      manager!.layout.width,
      manager!.layout.height,
      manager!.layout.pageWidth,
      manager!.layout.columnWidth,
      manager!.layout.gap,
      manager!.settings.axis,
      manager!.settings.direction || 'ltr',
      manager!.writingMode || manager!.settings.writingMode || 'horizontal-tb',
      manager!.viewSettings && manager!.viewSettings.layoutStyleSignature
        ? manager!.viewSettings.layoutStyleSignature
        : '',
    ].join(':')
  }

  cacheView(view: IframeView) {
    const manager = this.manager
    if (!manager || manager.destroyed || !view || !view.section) {
      return 0
    }

    let pageCount = manager.viewPageCount(view)
    this.pageCounts[this.layoutKey(view.section)] = pageCount
    return pageCount
  }

  invalidate(section: Section) {
    if (!this.manager || !section) {
      return
    }

    delete this.pageCounts[this.layoutKey(section)]
  }

  async count(section: Section | null | undefined) {
    const manager = this.manager
    if (!section) {
      return 0
    }

    if (!manager || manager.destroyed) return 0
    let existing = manager.views && manager.views.find(section)
    if (existing) {
      return this.cacheView(existing)
    }

    let key = this.layoutKey(section)
    if (this.pageCounts[key]) {
      return this.pageCounts[key]
    }

    const pageCount = await this.withView(
      section,
      (view) => this.cacheView(view),
      (error) => {
        if (!isUnavailableSectionError(error)) throw error
        section.resourceAvailable = false
        console.warn('Skipping unavailable reflowable section', section.href, error)
        return 0
      },
    )
    return pageCount ?? 0
  }

  async withView<Result>(
    section: Section,
    callback: (view: IframeView) => Result,
    onMeasurementError?: (error: unknown) => Awaited<Result>,
  ): Promise<Result | undefined> {
    const manager = this.manager
    if (!manager || manager.destroyed) return
    let existing = manager.views && manager.views.find(section)
    if (existing) {
      return callback(existing)
    }

    let scrollLeft = manager.container ? manager.container.scrollLeft : 0
    let view = manager.createView(section)
    view.element.style.visibility = 'hidden'
    view.iframe && (view.iframe.style.visibility = 'hidden')

    view.on(EVENTS.VIEWS.AXIS, (axis) => {
      manager.updateAxis(axis)
    })

    // Measurement can cross writing modes. The visible view still owns the
    // manager's writing mode, so listen only for axis changes here.
    manager.views.append(view)

    try {
      await view.display(manager.request)
      if (manager.destroyed) return
      return await callback(view)
    } catch (error) {
      if (!onMeasurementError) throw error
      return onMeasurementError(error)
    } finally {
      manager.views.remove(view)
      if (!manager.destroyed) manager.scrollTo(scrollLeft, 0, true)
    }
  }

  destroy() {
    this.clear()
    this.manager = undefined
  }
}
