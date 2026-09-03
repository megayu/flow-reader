import type { Location } from '@flow/epubjs'

import { imageSourcesMatch } from './image'
import type { BookTab, ISection } from './model'

export class BookNavigationController {
  private readonly pendingOperations = new Set<Promise<void>>()
  private displayQueue = Promise.resolve()

  get pending() {
    return this.pendingOperations.size ? this.waitForPending() : undefined
  }

  private async track(operation: Promise<void>) {
    this.pendingOperations.add(operation)
    try {
      await operation
    } finally {
      this.pendingOperations.delete(operation)
    }
  }

  enqueueDisplay(run: () => Promise<void>) {
    const operation = this.displayQueue.catch(() => undefined).then(run)
    this.displayQueue = operation.then(
      () => undefined,
      () => undefined,
    )
    return this.track(operation)
  }

  async waitForPending() {
    while (this.pendingOperations.size) {
      const operations = [...this.pendingOperations]
      try {
        await Promise.all(operations)
      } catch {
        // The caller owns navigation errors; waiters only serialize later work.
      }
    }
  }

  async run(tab: BookTab, action: () => Promise<void>) {
    if (tab.turning) return

    // `turning` owns the transient navigation cover; `rendered` continues to
    // describe whether a committed page exists after navigation settles.
    tab.turning = true
    const navigation = (async () => {
      try {
        await action()
      } finally {
        tab.turning = false
      }
    })()

    await this.track(navigation)
  }

  async prev(tab: BookTab) {
    if (tab.turning) await this.waitForPending()
    const pendingLayout = tab.waitForPendingLayout()
    if (pendingLayout) await pendingLayout

    return this.run(tab, async () => {
      tab.preferredSectionIndex = undefined
      tab.navigationDirection = -1
      tab.allowLocationJump = false
      tab.relayoutAnchorSectionIndexes = undefined
      const previousRequestId = tab.currentRenditionLocationRequestId()
      const navigation = tab.rendition?.prev()
      const requestId = tab.trackRenditionLocationRequest(previousRequestId, {
        updateAnchor: true,
        userNavigation: true,
      })
      await navigation
      tab.commitPendingRenditionLocation(requestId)
    })
  }

  async next(tab: BookTab) {
    if (tab.turning) await this.waitForPending()
    const pendingLayout = tab.waitForPendingLayout()
    if (pendingLayout) await pendingLayout

    return this.run(tab, async () => {
      tab.preferredSectionIndex = undefined
      tab.navigationDirection = 1
      tab.allowLocationJump = false
      tab.relayoutAnchorSectionIndexes = undefined
      const previousRequestId = tab.currentRenditionLocationRequestId()
      const navigation = tab.rendition?.next()
      const requestId = tab.trackRenditionLocationRequest(previousRequestId, {
        updateAnchor: true,
        userNavigation: true,
      })
      await navigation
      tab.commitPendingRenditionLocation(requestId)
    })
  }

  private sectionPositionFromLocation(tab: BookTab, location?: Pick<Location['start'], 'index' | 'href'>) {
    if (!tab.sections || !location) return -1

    return tab.sections.findIndex((section) => section.index === location.index || section.href === location.href)
  }

  private async displayCurrentSectionStartBeforePreviousSection(tab: BookTab) {
    const manager = tab.rendition?.manager
    const spread = manager?.currentReflowableSpread

    if (manager?.canUseLogicalReflowableSpread?.() && spread) {
      const page = manager.reflowableSpreadEarlierPage?.(spread) ?? spread.left ?? spread.right
      if (page?.section && page.pageIndex > 0) {
        const section = tab.sections?.find((candidate) => candidate.index === page.section.index)
        if (!section) return false

        await tab.displaySectionStart(section)
        return true
      }

      return false
    }

    const start = tab.location?.start
    const pageNumber = start?.displayed?.page
    if (!start || typeof pageNumber !== 'number' || pageNumber <= 1) {
      return false
    }

    const currentPosition = this.sectionPositionFromLocation(tab, start)
    const section = tab.sections?.[currentPosition]
    if (!section) return false

    await tab.displaySectionStart(section)
    return true
  }

  private async navigateNavItem(tab: BookTab, direction: -1 | 1) {
    const point = direction > 0 ? tab.location?.end : tab.location?.start
    const navIndex = tab.getSectionNavIndex()
    const entries = navIndex?.entries
    if (!entries?.length) return false

    const anchor = await tab.navAnchorForLocationPoint(point)
    const pointSection = tab.sectionFromLocationPoint(point)
    const singleSectionEntry = pointSection
      ? navIndex?.entriesBySectionIndex.get(pointSection.index)?.length === 1
        ? navIndex.entriesBySectionIndex.get(pointSection.index)?.[0]
        : undefined
      : undefined
    const anchorItem = anchor?.item ?? singleSectionEntry?.item
    if (!anchorItem) return false

    const index = entries.findIndex((entry) => entry.item === anchorItem)
    const target = index < 0 ? undefined : entries[index + direction]
    if (!target) return false

    const section = tab.sections?.find((section) => section.index === target.sectionIndex)
    if (!section) return false

    await tab.displayTarget(section, target.hash ? `#${target.hash}` : undefined, { alignTargetAsSpreadStart: true })
    return true
  }

  async navigateSection(tab: BookTab, direction: -1 | 1) {
    if (!tab.sections?.length || !tab.location) return
    if (tab.turning) await this.waitForPending()
    const pendingLayout = tab.waitForPendingLayout()
    if (pendingLayout) await pendingLayout

    return this.run(tab, async () => {
      if (await this.navigateNavItem(tab, direction)) return

      if (direction < 0 && (await this.displayCurrentSectionStartBeforePreviousSection(tab))) {
        return
      }

      const location = direction > 0 ? tab.location?.end : tab.location?.start
      const currentPosition = this.sectionPositionFromLocation(tab, location)
      if (currentPosition === -1) return

      const target = tab.sections?.[currentPosition + direction]
      if (!target) return

      await tab.displaySectionStart(target)
    })
  }
}

export async function pageIndexForCfi(tab: BookTab, sectionIndex: number, cfi: string) {
  const section = tab.sections?.find((item) => item.index === sectionIndex)
  const manager = tab.rendition?.manager
  if (!section || !manager?.reflowablePageForTarget) return 0

  const page = await manager.reflowablePageForTarget(section, cfi)
  return page?.pageIndex ?? 0
}

export async function displayFromSelector(
  tab: BookTab,
  selector: string,
  section: ISection,
  returnable = true,
  alignTargetAsSpreadStart = false,
) {
  try {
    await tab.ensureSectionInfo(section)
    const element = selector.startsWith('#')
      ? section.document.getElementById(selector.slice(1))
      : section.document.querySelector(selector)
    if (element) {
      const locationTarget = section.cfiFromElement(element)
      await tab.displayTarget(section, selector.startsWith('#') ? selector : locationTarget, {
        alignTargetAsSpreadStart,
        locationTarget,
        returnable,
      })
    } else {
      await tab.displaySectionStart(section, returnable)
    }
  } catch (_error) {
    tab.display(section.href, returnable)
  }
}

export async function displayImage(tab: BookTab, section: ISection, src: string, index: number, returnable = true) {
  try {
    await tab.ensureSectionInfo(section)
    const images = [...(section.document?.querySelectorAll('img') ?? [])] as HTMLImageElement[]
    const element = images.find((image) => imageSourcesMatch(image.src, src)) ?? images[index]

    if (element) {
      const cfi = section.cfiFromElement(element)
      await tab.displayTarget(section, cfi, { returnable })
      return
    }

    await tab.displaySectionStart(section, returnable)
  } catch (_error) {
    tab.display(section.href, returnable)
  }
}
