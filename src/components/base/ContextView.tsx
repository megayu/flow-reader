// https://github.com/microsoft/vscode/blob/36fdf6b697cba431beb6e391b5a8c5f3606975a1/src/vs/base/browser/ui/contextview/contextview.ts

export const enum LayoutAnchorPosition {
  Before,
  After,
}

export enum LayoutAnchorMode {
  AVOID,
  ALIGN,
}

interface ILayoutAnchor {
  offset: number
  size: number
  mode?: LayoutAnchorMode
  /** preferred anchor position */
  position: LayoutAnchorPosition
}

/**
 * {@link ./ContextView.excalidraw}
 *
 * Lays out a one dimensional view next to an anchor in a viewport.
 *
 * @returns The view offset within the viewport.
 */
export function layout(
  viewportSize: number,
  viewSize: number,
  anchor: ILayoutAnchor,
) {
  const layoutAfterAnchorBoundary =
    anchor.mode === LayoutAnchorMode.ALIGN
      ? anchor.offset
      : anchor.offset + anchor.size
  const layoutBeforeAnchorBoundary =
    anchor.mode === LayoutAnchorMode.ALIGN
      ? anchor.offset + anchor.size
      : anchor.offset

  if (anchor.position === LayoutAnchorPosition.Before) {
    if (viewSize <= viewportSize - layoutAfterAnchorBoundary) {
      return layoutAfterAnchorBoundary // happy case, lay it out after the anchor
    }

    if (viewSize <= layoutBeforeAnchorBoundary) {
      return layoutBeforeAnchorBoundary - viewSize // ok case, lay it out before the anchor
    }

    return Math.max(viewportSize - viewSize, 0) // sad case, lay it over the anchor
  } else {
    if (viewSize <= layoutBeforeAnchorBoundary) {
      return layoutBeforeAnchorBoundary - viewSize // happy case, lay it out before the anchor
    }

    if (viewSize <= viewportSize - layoutAfterAnchorBoundary) {
      return layoutAfterAnchorBoundary // ok case, lay it out after the anchor
    }

    return 0 // sad case, lay it over the anchor
  }
}

interface RectLike {
  left: number
  top: number
  width: number
  height: number
}

interface LayoutBesideRectOptions {
  preferredSide: 'left' | 'right'
  gap: number
  margin: number
  avoidRects?: readonly RectLike[]
}

function rectsOverlap(a: RectLike, b: RectLike) {
  return !(
    a.left + a.width <= b.left ||
    a.left >= b.left + b.width ||
    a.top + a.height <= b.top ||
    a.top >= b.top + b.height
  )
}

export function layoutBesideRect(
  viewport: RectLike,
  anchor: RectLike,
  view: { width: number; height: number },
  options: LayoutBesideRectOptions,
) {
  const minLeft = viewport.left + options.margin
  const maxLeft = viewport.left + viewport.width - options.margin - view.width
  const minTop = viewport.top + options.margin
  const maxTop = viewport.top + viewport.height - options.margin - view.height
  const top = Math.min(
    Math.max(anchor.top + anchor.height / 2 - view.height / 2, minTop),
    Math.max(minTop, maxTop),
  )
  const sides = [
    options.preferredSide,
    options.preferredSide === 'left' ? 'right' : 'left',
  ] as const
  const candidates = sides.map((side) => {
    const left =
      side === 'left'
        ? anchor.left - options.gap - view.width
        : anchor.left + anchor.width + options.gap
    const rect = { left, top, width: view.width, height: view.height }

    return {
      left,
      top,
      side,
      fits: left >= minLeft && left <= maxLeft,
      avoids: !(options.avoidRects ?? []).some((avoid) =>
        rectsOverlap(rect, avoid),
      ),
    }
  })
  const candidate =
    candidates.find(({ fits, avoids }) => fits && avoids) ??
    candidates.find(({ fits }) => fits) ??
    candidates[0]!

  return {
    left: Math.min(
      Math.max(candidate.left, minLeft),
      Math.max(minLeft, maxLeft),
    ),
    top: candidate.top,
    side: candidate.side,
  }
}
