import type { INavItem } from '@/models/reader'

const STICKY_MAX_ROWS = 7
const STICKY_VIEWPORT_RATIO = 0.4

export interface TocLayoutRow {
  item: INavItem
  depth: number
  parentIndex: number
  endIndex: number
}

export function flattenToc(nodes: INavItem[] = []): TocLayoutRow[] {
  const rows: TocLayoutRow[] = []
  const stack = nodes.map((item) => ({ item, parentIndex: -1, depth: 1 })).reverse()
  while (stack.length) {
    const entry = stack.pop()!
    const index = rows.length
    rows.push({ ...entry, endIndex: index })
    if (!entry.item.expanded) continue
    const children = entry.item.subitems ?? []
    for (let childIndex = children.length - 1; childIndex >= 0; childIndex--) {
      stack.push({ item: children[childIndex]!, parentIndex: index, depth: entry.depth + 1 })
    }
  }
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index]!
    if (row.parentIndex >= 0) {
      const parent = rows[row.parentIndex]!
      parent.endIndex = Math.max(parent.endIndex, row.endIndex)
    }
  }
  return rows
}

export function tocStickyRowLimit(viewportHeight: number, rowHeight: number) {
  return Math.min(STICKY_MAX_ROWS, Math.floor((viewportHeight * STICKY_VIEWPORT_RATIO) / rowHeight))
}

export function getTocStickyRows(
  rows: readonly TocLayoutRow[],
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
) {
  const sticky: Array<{ index: number; top: number }> = []
  const limit = tocStickyRowLimit(viewportHeight, rowHeight)
  let previousIndex = -1
  for (let slot = 0; slot < limit; slot++) {
    const top = slot * rowHeight
    let index = Math.min(rows.length - 1, Math.floor((scrollTop + top) / rowHeight))
    if (index < 0) break
    // Probe below each pinned row: the overlay may have already covered a branch boundary.
    while (rows[index]!.parentIndex !== previousIndex && rows[index]!.parentIndex >= 0) {
      index = rows[index]!.parentIndex
    }
    const row = rows[index]!
    if (row.parentIndex !== previousIndex || row.endIndex === index || index * rowHeight >= scrollTop + top) break
    const position = Math.min(top, (row.endIndex + 1) * rowHeight - scrollTop - rowHeight)
    sticky.push({ index, top: position })
    if (position < top) break
    previousIndex = index
  }
  return sticky
}
