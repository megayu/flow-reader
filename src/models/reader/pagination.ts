import type { Location } from '@flow/epubjs'
import type Navigation from '@flow/epubjs/navigation'

import type {
  BookRecord,
  ReadingSpreadPageRecord,
  ReadingSpreadRecord,
} from '../../storage'

import type { INavItem, ISection } from './model'

function displayLocationPercentage(location?: Location['end']) {
  const percentage = location?.percentage
  if (typeof percentage !== 'number' || !Number.isFinite(percentage)) return
  if (percentage < 0 || percentage > 1) return
  return percentage
}

function estimatePercentageFromSpine(
  location: Location['end'],
  sectionCount: number,
) {
  if (!sectionCount) return 0

  const sectionIndex = Math.max(0, Math.min(location.index, sectionCount - 1))
  const totalPages = Math.max(1, location.displayed.total || 1)
  const page = Math.max(1, Math.min(location.displayed.page || 1, totalPages))
  const sectionProgress = page / totalPages

  return Math.max(
    0,
    Math.min(1, (sectionIndex + sectionProgress) / sectionCount),
  )
}

export function calculateReadingPercentage({
  location,
  sections,
  totalLength,
  sectionAsPage = false,
}: {
  location: Location
  sections: ISection[]
  totalLength?: number
  sectionAsPage?: boolean
}) {
  if (location.atEnd) return 1

  const end = location.end ?? location.start
  if (sectionAsPage) {
    return estimatePercentageFromSpine(end, sections.length)
  }

  if (location.atStart) return 0

  const sectionIndex = sections.findIndex((s) => s.href === end.href)
  const activeSection = sectionIndex >= 0 ? sections[sectionIndex] : undefined

  if (activeSection && totalLength && activeSection.length) {
    const previousSectionsLength = sections
      .slice(0, sectionIndex)
      .reduce((acc, s) => acc + s.length, 0)
    const previousSectionsPercentage = previousSectionsLength / totalLength
    const currentSectionPercentage = activeSection.length / totalLength
    const displayedPercentage =
      end.displayed.total > 0 ? end.displayed.page / end.displayed.total : 0

    return Math.max(
      0,
      Math.min(
        1,
        previousSectionsPercentage +
          currentSectionPercentage * displayedPercentage,
      ),
    )
  }

  const estimated = estimatePercentageFromSpine(end, sections.length)
  if (estimated > 0) return estimated

  return displayLocationPercentage(end) ?? 0
}

export function fallbackReadingPercentage(location: Location) {
  if (location.atEnd) return 1
  if (location.atStart) return 0

  return displayLocationPercentage(location.end ?? location.start)
}

export interface PaginationSnapshot {
  location: Location
  percentage?: number
  spreadDivisor: number
  writingMode?: string
  pageProgressionDirection?: 'ltr' | 'rtl'
  spreadSlotOrder?: 'left-first' | 'right-first'
  layoutVersion: number
  paginationVersion: number
  headerPath: HeaderPathItem[]
  visibleSectionIndexes: number[]
}

interface ReadingOrderSpread {
  left?: { section?: { index?: number } }
  right?: { section?: { index?: number } }
}

export function readingOrderStartSectionIndex(
  spread: ReadingOrderSpread | undefined,
  spreadSlotOrder: PaginationSnapshot['spreadSlotOrder'],
  fallback?: number,
) {
  const primary =
    spreadSlotOrder === 'right-first' ? spread?.right : spread?.left
  const secondary =
    spreadSlotOrder === 'right-first' ? spread?.left : spread?.right

  return primary?.section?.index ?? secondary?.section?.index ?? fallback
}

export interface HeaderPathItem {
  id?: string
  href?: string
  label: string
}

export interface RelocatedEventMeta {
  requestId?: number
}

export interface LocationRequestIntent {
  anchorTarget?: string
  layoutKey?: string
  updateAnchor: boolean
}

export interface SectionNavEntry {
  href: string
  hash?: string
  item: INavItem
  order: number
  sectionIndex: number
}

export interface SectionNavAnchorEntry extends SectionNavEntry {
  cfi: string
}

export interface SectionNavIndex {
  nav: Navigation
  sections: ISection[]
  exactBySectionHref: Map<string, INavItem>
  firstNavItemById: Map<string, INavItem>
  entriesBySectionIndex: Map<number, SectionNavEntry[]>
  anchorEntriesBySectionIndex: Map<number, SectionNavAnchorEntry[]>
  anchorPromisesBySectionIndex: Map<number, Promise<SectionNavAnchorEntry[]>>
  entries: SectionNavEntry[]
}

function snapshotReflowablePage(
  page: any,
): ReadingSpreadPageRecord | undefined {
  if (
    !page?.section ||
    typeof page.section.index !== 'number' ||
    typeof page.pageIndex !== 'number'
  ) {
    return
  }

  return {
    sectionIndex: page.section.index,
    pageIndex: page.pageIndex,
  }
}

function locationEndsAtDisplayedPageEnd(location?: Location) {
  const displayed = location?.end?.displayed
  return (
    typeof displayed?.page === 'number' &&
    typeof displayed.total === 'number' &&
    displayed.total > 0 &&
    displayed.page >= displayed.total
  )
}

export function snapshotReflowableSpread(
  manager: any,
  layoutStyleSignature?: string,
  location?: Location,
): ReadingSpreadRecord | undefined {
  const spread = manager?.currentReflowableSpread
  if (!manager?.canUseLogicalReflowableSpread?.() || !spread) return

  const left = snapshotReflowablePage(spread.left)
  const right = snapshotReflowablePage(spread.right)
  const endsAtSectionEnd =
    Boolean(spread.endsAtSectionEnd) || locationEndsAtDisplayedPageEnd(location)
  const rightFirst =
    manager.paginationModel?.().spreadSlotOrder === 'right-first'
  const terminalSlot = endsAtSectionEnd
    ? rightFirst
      ? left
        ? 'left'
        : 'right'
      : right
        ? 'right'
        : 'left'
    : undefined
  const anchor =
    terminalSlot ??
    (spread.anchor === 'right' && right
      ? 'right'
      : spread.anchor === 'left' && left
        ? 'left'
        : left
          ? 'left'
          : 'right')
  const page = anchor === 'right' ? (right ?? left) : (left ?? right)
  if (!page) return

  return {
    ...page,
    version: 1,
    anchor,
    exact: !endsAtSectionEnd,
    ...(left ? { left } : {}),
    ...(right ? { right } : {}),
    ...(endsAtSectionEnd ? { endsAtSectionEnd: true } : {}),
    ...(layoutStyleSignature ? { layoutStyleSignature } : {}),
  }
}

function hydrateReflowablePage(
  page: ReadingSpreadPageRecord | undefined,
  sections: ISection[] | undefined,
) {
  if (!page || !sections) return
  const section = sections.find(
    (candidate) => candidate.index === page.sectionIndex,
  )
  if (!section) return

  return {
    section,
    pageIndex: page.pageIndex,
  }
}

export function hydrateReflowableSpread(
  spread: ReadingSpreadRecord | undefined,
  sections: ISection[] | undefined,
  layoutStyleSignature?: string,
) {
  if (!spread || spread.version !== 1 || !sections) return
  if (
    spread.layoutStyleSignature &&
    spread.layoutStyleSignature !== layoutStyleSignature
  ) {
    return
  }

  if (spread.left || spread.right) {
    const left = hydrateReflowablePage(spread.left, sections)
    const right = hydrateReflowablePage(spread.right, sections)
    const anchor = spread.anchor === 'right' ? 'right' : 'left'
    const anchorPage = anchor === 'right' ? right : left
    if (!anchorPage) return

    return {
      exact: spread.exact ?? true,
      anchor,
      ...(left ? { left } : {}),
      ...(right ? { right } : {}),
      ...(spread.endsAtSectionEnd ? { endsAtSectionEnd: true } : {}),
    }
  }

  const page = hydrateReflowablePage(spread, sections)
  if (!page) return

  return spread.anchor === 'right'
    ? {
        exact: true,
        anchor: 'right',
        right: page,
      }
    : {
        left: page,
        anchor: 'left',
      }
}

export function readingSpreadSectionIndexes(spread: ReadingSpreadRecord) {
  const pages =
    spread.left || spread.right ? [spread.left, spread.right] : [spread]

  return pages
    .filter((page): page is ReadingSpreadPageRecord => Boolean(page))
    .map((page) => page.sectionIndex)
}

export function mergeConfigurationWithSpread(
  configuration: BookRecord['configuration'],
  spread: ReadingSpreadRecord | undefined,
) {
  const next = { ...(configuration ?? {}) }

  if (spread) {
    next.spread = spread
  } else {
    delete next.spread
  }

  return next
}
