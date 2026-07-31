export interface ReflowableManager {
  reflowablePageCountCache?: Record<string, number>
  currentReflowableSpread?: ReflowableSpread
  paginationModel?: () => {
    spreadSlotOrder?: 'left-first' | 'right-first'
  }
}

export interface ReflowablePageAddress {
  section?: {
    index: number
  }
  pageIndex: number
}

export interface ReflowableSpread {
  left?: ReflowablePageAddress
  right?: ReflowablePageAddress
}

export interface ChapterFindResult {
  cfi: string
  excerpt: string
  pageIndex: number
}

export interface ChapterFindState {
  open: boolean
  query: string
  sectionIndex?: number
  results: ChapterFindResult[]
  activeIndex: number
  searching: boolean
}

export const initialChapterFind: ChapterFindState = {
  open: false,
  query: '',
  results: [],
  activeIndex: 0,
  searching: false,
}

export function isFindShortcut(event: KeyboardEvent) {
  return (event.ctrlKey || event.metaKey) && !event.altKey && (event.key.toLowerCase() === 'f' || event.code === 'KeyF')
}

export function visibleFindPageIndexes(sectionIndex: number, manager: ReflowableManager | undefined) {
  const spread = manager?.currentReflowableSpread
  const pages = new Set<number>()

  if (spread?.left?.section?.index === sectionIndex) {
    pages.add(spread.left.pageIndex)
  }
  if (spread?.right?.section?.index === sectionIndex) {
    pages.add(spread.right.pageIndex)
  }

  return pages
}

export function firstVisibleFindResultIndex(
  results: ChapterFindResult[],
  sectionIndex: number,
  manager: ReflowableManager | undefined,
) {
  const pages = visibleFindPageIndexes(sectionIndex, manager)
  if (!pages.size) return -1

  return results.findIndex((result) => pages.has(result.pageIndex))
}

export function nearestVisibleFindResultIndex(
  results: ChapterFindResult[],
  sectionIndex: number | undefined,
  manager: ReflowableManager | undefined,
  activeIndex: number,
) {
  if (sectionIndex === undefined) return -1

  const pages = visibleFindPageIndexes(sectionIndex, manager)
  if (!pages.size) return -1

  let nearestIndex = -1
  let nearestDistance = Number.POSITIVE_INFINITY
  results.forEach((result, index) => {
    if (!pages.has(result.pageIndex)) return

    const distance = Math.abs(index - activeIndex)
    if (distance >= nearestDistance) return

    nearestIndex = index
    nearestDistance = distance
  })

  return nearestIndex
}

export function isFindResultVisible(
  result: ChapterFindResult,
  sectionIndex: number,
  manager: ReflowableManager | undefined,
) {
  return visibleFindPageIndexes(sectionIndex, manager).has(result.pageIndex)
}

export function findLocationKey(location: unknown) {
  const loc = location as
    | {
        start?: {
          href?: string
          displayed?: {
            page?: number
            total?: number
            slot?: string
          }
        }
        end?: {
          href?: string
          displayed?: {
            page?: number
            total?: number
            slot?: string
          }
        }
      }
    | undefined

  return [
    loc?.start?.href,
    loc?.start?.displayed?.page,
    loc?.start?.displayed?.total,
    loc?.start?.displayed?.slot,
    loc?.end?.href,
    loc?.end?.displayed?.page,
    loc?.end?.displayed?.total,
    loc?.end?.displayed?.slot,
  ].join('|')
}
