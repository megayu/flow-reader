/** Find non-overlapping matches in lowercased text; return original UTF-16 ranges. */
export function* findTextMatches(original: string, lowercaseQuery: string) {
  if (!lowercaseQuery) return
  // Lowercase the whole string to preserve contextual casing (e.g. final sigma).
  const folded = original.toLowerCase()
  let originalCursor = 0
  let foldedCursor = 0
  const originalBoundary = (boundary: number, end: boolean) => {
    if (folded.length === original.length) return boundary
    // Match boundaries arrive in order, so even expanded casing is mapped in
    // one forward pass without allocating a per-character offset table.
    while (foldedCursor < boundary) {
      const width = original.codePointAt(originalCursor)! > 0xffff ? 2 : 1
      const foldedWidth = original
        .slice(originalCursor, originalCursor + width)
        .toLowerCase().length
      if (foldedCursor + foldedWidth > boundary) {
        return originalCursor + (end ? width : 0)
      }
      originalCursor += width
      foldedCursor += foldedWidth
    }
    return originalCursor
  }
  let offset = 0
  let start
  while ((start = folded.indexOf(lowercaseQuery, offset)) !== -1) {
    offset = start + lowercaseQuery.length
    yield {
      start: originalBoundary(start, false),
      end: originalBoundary(offset, true),
    }
  }
}
