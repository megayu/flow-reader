export interface LibraryGridWindowInput {
  cardHeight: number
  columnCount: number
  gridTop: number
  overscanRows: number
  rowGap: number
  scrollTop: number
  totalCount: number
  viewportHeight: number
}

export interface LibraryGridWindow {
  endIndex: number
  paddingBottom: number
  paddingTop: number
  startIndex: number
  totalGridHeight: number
}

export const libraryGridVirtualizationThreshold = 75

const finiteNonNegative = (value: number) => (Number.isFinite(value) ? Math.max(0, value) : 0)

export function getLibraryGridColumnCount(gridWidth: number, cardWidth: number, columnGap: number) {
  const width = finiteNonNegative(gridWidth)
  const itemWidth = Math.max(1, finiteNonNegative(cardWidth))
  const gap = finiteNonNegative(columnGap)
  return Math.max(1, Math.floor((width + gap) / (itemWidth + gap)))
}

export function getLibraryGridWindow({
  cardHeight,
  columnCount,
  gridTop,
  overscanRows,
  rowGap,
  scrollTop,
  totalCount,
  viewportHeight,
}: LibraryGridWindowInput): LibraryGridWindow {
  const count = Math.max(0, Math.floor(finiteNonNegative(totalCount)))
  const columns = Math.max(1, Math.floor(finiteNonNegative(columnCount)))
  const height = Math.max(1, finiteNonNegative(cardHeight))
  const gap = finiteNonNegative(rowGap)
  const overscan = Math.max(0, Math.floor(finiteNonNegative(overscanRows)))
  const totalRows = Math.ceil(count / columns)

  if (!totalRows) {
    return {
      endIndex: 0,
      paddingBottom: 0,
      paddingTop: 0,
      startIndex: 0,
      totalGridHeight: 0,
    }
  }

  const rowStride = height + gap
  const totalGridHeight = totalRows * height + Math.max(0, totalRows - 1) * gap
  const relativeViewportTop = Math.min(
    totalGridHeight,
    Math.max(0, finiteNonNegative(scrollTop) - finiteNonNegative(gridTop)),
  )
  const relativeViewportBottom = Math.min(
    totalGridHeight,
    Math.max(0, finiteNonNegative(scrollTop) + finiteNonNegative(viewportHeight) - finiteNonNegative(gridTop)),
  )
  const firstVisibleRow = Math.min(totalRows - 1, Math.floor(relativeViewportTop / rowStride))
  const visibleEndRow = Math.min(
    totalRows,
    Math.max(firstVisibleRow + 1, Math.ceil(relativeViewportBottom / rowStride)),
  )
  const startRow = Math.max(0, firstVisibleRow - overscan)
  const endRow = Math.min(totalRows, visibleEndRow + overscan)
  const renderedRows = endRow - startRow
  const renderedHeight = renderedRows * height + Math.max(0, renderedRows - 1) * gap
  const paddingTop = startRow * rowStride
  const paddingBottom = Math.max(0, totalGridHeight - paddingTop - renderedHeight)

  return {
    endIndex: Math.min(count, endRow * columns),
    paddingBottom,
    paddingTop,
    startIndex: Math.min(count, startRow * columns),
    totalGridHeight,
  }
}
