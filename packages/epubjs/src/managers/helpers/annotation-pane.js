const SVG_NAMESPACE = 'http://www.w3.org/2000/svg'
const PROXIED_EVENTS = ['mouseup', 'mousedown', 'click', 'touchstart']

function svgElement(document, name) {
  return document.createElementNS(SVG_NAMESPACE, name)
}

function plainRect(rect) {
  let left = Number(rect.left)
  let top = Number(rect.top)
  let right = Number(rect.right ?? left + Number(rect.width))
  let bottom = Number(rect.bottom ?? top + Number(rect.height))

  return {
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
  }
}

function nextSibling(node, root, forward) {
  while (node !== root) {
    let sibling = forward ? node.nextSibling : node.previousSibling
    if (sibling) return sibling
    node = node.parentNode
  }
}

function textNodeAtBoundary(container, offset, root, forward) {
  if (container.nodeType === 3) return container

  let node =
    container.childNodes[offset - (forward ? 0 : 1)] ||
    nextSibling(container, root, forward)
  while (node && node.nodeType !== 3) {
    node =
      (forward ? node.firstChild : node.lastChild) ||
      nextSibling(node, root, forward)
  }
  return node
}

function textFragments(range) {
  let root = range.commonAncestorContainer
  let document = root.nodeType === 9 ? root : root.ownerDocument
  if (!document) return []

  let first = textNodeAtBoundary(
    range.startContainer,
    range.startOffset,
    root,
    true,
  )
  let last = textNodeAtBoundary(
    range.endContainer,
    range.endOffset,
    root,
    false,
  )
  if (!first || !last) return []

  let fragments = []
  let walker = document.createTreeWalker(root, 4)
  walker.currentNode = first
  let node = first
  while (node) {
    let start = node === range.startContainer ? range.startOffset : 0
    let end = node === range.endContainer ? range.endOffset : node.length
    if (end > start) fragments.push({ node, start, end })
    if (node === last) break
    node = walker.nextNode()
  }
  if (node !== last) return []

  let firstIndex = 0
  while (firstIndex < fragments.length) {
    let fragment = fragments[firstIndex]
    let leading = fragment.node.data.slice(fragment.start, fragment.end).search(/\S/)
    if (leading >= 0) {
      fragment.start += leading
      break
    }
    firstIndex += 1
  }
  fragments = fragments.slice(firstIndex)

  while (fragments.length) {
    let fragment = fragments[fragments.length - 1]
    let text = fragment.node.data.slice(fragment.start, fragment.end)
    let trailing = text.search(/\s*$/)
    if (trailing > 0) {
      fragment.end = fragment.start + trailing
      break
    }
    fragments.pop()
  }

  return fragments
}

function textClientRects(fragments, range) {
  let rects = []
  for (let { node, start, end } of fragments) {
    range.setStart(node, start)
    range.setEnd(node, end)
    for (let rect of range.getClientRects()) rects.push(plainRect(rect))
  }
  return rects
}

function blockGeometry(rect, vertical) {
  let start = vertical ? rect.left : rect.top
  let end = vertical ? rect.right : rect.bottom

  return {
    start,
    end,
    center: (start + end) / 2,
    size: end - start,
    inlineStart: vertical ? rect.top : rect.left,
    inlineEnd: vertical ? rect.bottom : rect.right,
  }
}

function mergeIntervals(intervals) {
  let sorted = intervals
    .filter(([start, end]) => end > start)
    .sort((first, second) => first[0] - second[0])
  let merged = []

  for (let interval of sorted) {
    let previous = merged[merged.length - 1]
    if (!previous || interval[0] > previous[1]) merged.push(interval.slice())
    else previous[1] = Math.max(previous[1], interval[1])
  }

  return merged
}

function intersectIntervals(first, second) {
  let intersections = []
  let i = 0
  let j = 0

  while (i < first.length && j < second.length) {
    let start = Math.max(first[i][0], second[j][0])
    let end = Math.min(first[i][1], second[j][1])
    if (end > start) intersections.push([start, end])
    if (first[i][1] <= second[j][1]) i += 1
    else j += 1
  }

  return intersections
}

function axesRect(blockStart, blockEnd, inlineStart, inlineEnd, vertical) {
  let left = vertical ? blockStart : inlineStart
  let top = vertical ? inlineStart : blockStart
  let right = vertical ? blockEnd : inlineEnd
  let bottom = vertical ? inlineEnd : blockEnd
  return { left, top, right, bottom, width: right - left, height: bottom - top }
}

function mergeAdjacentFragments(rects, vertical) {
  let sorted = rects
    .slice()
    .sort((first, second) => {
      let a = blockGeometry(first, vertical)
      let b = blockGeometry(second, vertical)
      return a.center - b.center || a.inlineStart - b.inlineStart
    })
  let merged = []

  for (let rect of sorted) {
    let geometry = blockGeometry(rect, vertical)
    let previous = merged[merged.length - 1]
    if (previous) {
      let prior = blockGeometry(previous, vertical)
      let sameBand =
        Math.abs(prior.start - geometry.start) < 0.01 &&
        Math.abs(prior.end - geometry.end) < 0.01
      if (sameBand && geometry.inlineStart <= prior.inlineEnd) {
        let blockStart = Math.min(prior.start, geometry.start)
        let blockEnd = Math.max(prior.end, geometry.end)
        let inlineStart = Math.min(prior.inlineStart, geometry.inlineStart)
        let inlineEnd = Math.max(prior.inlineEnd, geometry.inlineEnd)
        merged[merged.length - 1] = axesRect(
          blockStart,
          blockEnd,
          inlineStart,
          inlineEnd,
          vertical,
        )
        continue
      }
    }
    merged.push(rect)
  }

  return merged
}

function normalizeLineFragments(line, vertical) {
  let bands = new Map()

  for (let fragment of line.fragments) {
    let band = bands.get(fragment.mark)
    if (!band) {
      band = {
        blockStart: fragment.geometry.start,
        blockEnd: fragment.geometry.end,
        inlineIntervals: [],
      }
      bands.set(fragment.mark, band)
    }
    band.blockStart = Math.min(band.blockStart, fragment.geometry.start)
    band.blockEnd = Math.max(band.blockEnd, fragment.geometry.end)
    band.inlineIntervals.push([
      fragment.geometry.inlineStart,
      fragment.geometry.inlineEnd,
    ])
  }

  let normalized = []
  for (let [mark, band] of bands) {
    for (let [inlineStart, inlineEnd] of mergeIntervals(band.inlineIntervals)) {
      let rect = axesRect(
        band.blockStart,
        band.blockEnd,
        inlineStart,
        inlineEnd,
        vertical,
      )
      normalized.push({ mark, rect, geometry: blockGeometry(rect, vertical) })
    }
  }

  return normalized
}

function boundaryIntervals(line, boundary, side) {
  return mergeIntervals(
    line.fragments
      .filter(({ geometry }) =>
        side === 'after'
          ? geometry.end > boundary
          : geometry.start < boundary,
      )
      .map(({ geometry }) => [geometry.inlineStart, geometry.inlineEnd]),
  )
}

function splitFragment(fragment, line, vertical) {
  if (!line.before && !line.after) return [fragment.rect]

  let geometry = fragment.geometry
  let boundaries = [geometry.inlineStart, geometry.inlineEnd]
  for (let clipping of [line.before, line.after]) {
    if (!clipping) continue
    for (let [start, end] of clipping.intervals) {
      start = Math.max(start, geometry.inlineStart)
      end = Math.min(end, geometry.inlineEnd)
      if (end > start) boundaries.push(start, end)
    }
  }
  boundaries = [...new Set(boundaries)].sort((first, second) => first - second)

  let rects = []
  for (let i = 0; i < boundaries.length - 1; i++) {
    let inlineStart = boundaries[i]
    let inlineEnd = boundaries[i + 1]
    let midpoint = (inlineStart + inlineEnd) / 2
    let start = geometry.start
    let end = geometry.end
    if (containsInterval(line.before?.intervals, midpoint)) {
      start = Math.max(start, line.before.boundary)
    }
    if (containsInterval(line.after?.intervals, midpoint)) {
      end = Math.min(end, line.after.boundary)
    }
    if (end > start) {
      rects.push(axesRect(start, end, inlineStart, inlineEnd, vertical))
    }
  }

  return rects
}

function containsInterval(intervals, point) {
  return intervals?.some(([start, end]) => start <= point && end >= point)
}

export function normalizeAnnotationRects(entries, writingMode = 'horizontal-tb') {
  let vertical = writingMode.indexOf('vertical') === 0
  let fragments = entries
    .map(({ mark, rect }) => ({ mark, rect: plainRect(rect) }))
    .filter(
      ({ rect }) =>
        Number.isFinite(rect.left) &&
        Number.isFinite(rect.top) &&
        rect.width > 0 &&
        rect.height > 0,
    )
    .map((item) => ({
      ...item,
      geometry: blockGeometry(item.rect, vertical),
    }))
    .sort(
      (first, second) =>
        first.geometry.center - second.geometry.center ||
        first.geometry.inlineStart - second.geometry.inlineStart,
    )
  let lines = []

  for (let fragment of fragments) {
    let line = lines[lines.length - 1]
    let nestedBlock =
      line &&
      ((fragment.geometry.start >= line.minStart &&
        fragment.geometry.end <= line.maxEnd) ||
        (line.minStart >= fragment.geometry.start &&
          line.maxEnd <= fragment.geometry.end))
    let sameLine =
      line &&
      (Math.abs(line.center - fragment.geometry.center) <=
        Math.max(1, Math.min(line.size, fragment.geometry.size) / 4) ||
        nestedBlock)

    if (!sameLine) {
      lines.push({
        fragments: [fragment],
        center: fragment.geometry.center,
        size: fragment.geometry.size,
        minStart: fragment.geometry.start,
        maxEnd: fragment.geometry.end,
      })
      continue
    }

    line.fragments.push(fragment)
    line.center +=
      (fragment.geometry.center - line.center) / line.fragments.length
    line.size = Math.min(line.size, fragment.geometry.size)
    line.minStart = Math.min(line.minStart, fragment.geometry.start)
    line.maxEnd = Math.max(line.maxEnd, fragment.geometry.end)
  }

  for (let line of lines) {
    line.fragments = normalizeLineFragments(line, vertical)
  }

  for (let i = 0; i < lines.length - 1; i++) {
    let current = lines[i]
    let next = lines[i + 1]
    let overlapStart = Math.max(current.minStart, next.minStart)
    let overlapEnd = Math.min(current.maxEnd, next.maxEnd)
    if (overlapEnd <= overlapStart) continue
    let boundary = (overlapStart + overlapEnd) / 2
    let intervals = intersectIntervals(
      boundaryIntervals(current, boundary, 'after'),
      boundaryIntervals(next, boundary, 'before'),
    )
    if (!intervals.length) continue
    current.after = { boundary, intervals }
    next.before = { boundary, intervals }
  }

  let result = new Map()
  for (let line of lines) {
    for (let fragment of line.fragments) {
      let rects = result.get(fragment.mark) || []
      rects.push(...splitFragment(fragment, line, vertical))
      result.set(fragment.mark, rects)
    }
  }

  for (let [mark, rects] of result) {
    result.set(mark, mergeAdjacentFragments(rects, vertical))
  }

  return result
}

function cloneEvent(event, view) {
  if (view && view.MouseEvent && Number.isFinite(event.clientX)) {
    return new view.MouseEvent(event.type, {
      bubbles: false,
      cancelable: event.cancelable,
      clientX: event.clientX,
      clientY: event.clientY,
      screenX: event.screenX,
      screenY: event.screenY,
      button: event.button,
      buttons: event.buttons,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      shiftKey: event.shiftKey,
      metaKey: event.metaKey,
    })
  }

  let EventConstructor = (view && view.Event) || Event
  return new EventConstructor(event.type, {
    bubbles: false,
    cancelable: event.cancelable,
  })
}

function sameRects(first, second) {
  return (
    first &&
    first.length === second.length &&
    first.every(
      (rect, index) =>
        rect.left === second[index].left &&
        rect.top === second[index].top &&
        rect.right === second[index].right &&
        rect.bottom === second[index].bottom,
    )
  )
}

export class Pane {
  constructor(target, container = document.body, writingMode = 'horizontal-tb') {
    this.target = target
    this.container = container
    this.marks = []
    this.marksDirty = false
    this.overlapGroups = new Map()
    this.writingMode = writingMode
    this.batchDepth = 0
    this.element = svgElement(container.ownerDocument, 'svg')
    this.overlapLayer = svgElement(container.ownerDocument, 'g')
    this.element.appendChild(this.overlapLayer)
    this.element.style.position = 'absolute'
    this.element.setAttribute('pointer-events', 'none')
    this.container.appendChild(this.element)
    this.eventTarget = target.contentDocument || target
    this.eventHandlers = PROXIED_EVENTS.map((type) => {
      let handler = (event) => this.dispatch(event)
      this.eventTarget.addEventListener(type, handler, false)
      return [type, handler]
    })
    this.render()
  }

  beginBatch() {
    this.batchDepth += 1
  }

  endBatch() {
    if (this.batchDepth === 0) return
    this.batchDepth -= 1
    if (this.batchDepth !== 0) return
    this.compactMarks()
    for (let mark of this.marks) {
      if (!mark.rawRects) mark.measure()
    }
    this.updateMarks()
  }

  addMark(mark) {
    this.compactMarks()
    let group = svgElement(this.element.ownerDocument, 'g')
    let overlapGroup = mark.attributes?.['data-overlap-group']
    let container = this.element
    if (overlapGroup) {
      container = this.overlapGroups.get(overlapGroup)
      if (!container) {
        // Composite opaque child marks first, then apply opacity once to their union.
        container = svgElement(this.element.ownerDocument, 'g')
        container.setAttribute('data-overlap-group', overlapGroup)
        let opacity = mark.attributes?.['data-overlap-opacity']
        if (opacity !== undefined) container.setAttribute('opacity', opacity)
        this.overlapGroups.set(overlapGroup, container)
        this.overlapLayer.appendChild(container)
      }
    }
    container.appendChild(group)
    mark.bind(group)
    this.marks.push(mark)
    if (this.batchDepth === 0) {
      mark.measure()
      this.updateMarks()
    }
    return mark
  }

  removeMark(mark) {
    if (mark.element?.ownerSVGElement !== this.element) return
    let index = this.batchDepth === 0 ? this.marks.indexOf(mark) : -1
    let element = mark.unbind()
    let container = element?.parentNode
    if (element) element.remove()
    if (container && container !== this.element && !container.childNodes.length) {
      this.overlapGroups.delete(container.getAttribute('data-overlap-group'))
      container.remove()
    }
    if (this.batchDepth === 0) {
      this.marks.splice(index, 1)
      this.updateMarks()
    } else {
      // Unbound marks are compacted together before the batch redraw.
      this.marksDirty = true
    }
  }

  compactMarks() {
    if (!this.marksDirty) return
    this.marks = this.marks.filter((mark) => mark.element)
    this.marksDirty = false
  }

  render() {
    this.compactMarks()
    let container = this.container.getBoundingClientRect()
    let target = this.target.getBoundingClientRect()
    let paneHeight = this.target.scrollHeight
    let paneWidth = this.target.scrollWidth
    for (let mark of this.marks) {
      mark.measure()
    }

    this.element.style.setProperty('top', `${target.top - container.top}px`, 'important')
    this.element.style.setProperty('left', `${target.left - container.left}px`, 'important')
    this.element.style.setProperty('height', `${paneHeight}px`, 'important')
    this.element.style.setProperty('width', `${paneWidth}px`, 'important')
    this.updateMarks()
  }

  updateMarks() {
    this.compactMarks()
    let entries = []
    for (let mark of this.marks) {
      for (let rect of mark.rawRects || []) entries.push({ mark, rect })
    }
    let normalized = normalizeAnnotationRects(entries, this.writingMode)
    for (let mark of this.marks) {
      let rects = normalized.get(mark) || []
      if (sameRects(mark.rects, rects)) continue
      mark.rects = rects
      mark.render()
    }
  }

  dispatch(event) {
    this.compactMarks()
    let point = event.touches && event.touches[0] ? event.touches[0] : event
    for (let i = this.marks.length - 1; i >= 0; i--) {
      let mark = this.marks[i]
      if (!mark.containsPoint(point.clientX, point.clientY)) continue
      mark.dispatchEvent(cloneEvent(event, this.eventTarget.defaultView))
      return
    }
  }

  destroy() {
    for (let [type, handler] of this.eventHandlers) {
      this.eventTarget.removeEventListener(type, handler, false)
    }
    this.eventHandlers = []
    this.marks = []
    this.overlapGroups.clear()
    this.element.remove()
  }
}

export class Mark {
  constructor() {
    this.element = null
    this.rawRects = undefined
    this.rects = undefined
    this.measurementRange = undefined
  }

  bind(element) {
    this.element = element
  }

  unbind() {
    let element = this.element
    this.element = null
    return element
  }

  measure() {
    if (
      this.range.startContainer === this.range.endContainer &&
      this.range.startContainer.nodeType === 3 &&
      this.range.endOffset > this.range.startOffset &&
      !/\s/.test(this.range.startContainer.data[this.range.startOffset]) &&
      !/\s/.test(this.range.startContainer.data[this.range.endOffset - 1])
    ) {
      this.rawRects = Array.from(this.range.getClientRects(), plainRect)
      return
    }

    let fragments = textFragments(this.range)
    if (!fragments.length) {
      this.rawRects = []
      return
    }

    let fragment = fragments[0]
    this.measurementRange ??= fragment.node.ownerDocument.createRange()
    this.rawRects = textClientRects(fragments, this.measurementRange)
  }

  containsPoint(x, y) {
    return (this.rects || []).some(
      (rect) =>
        rect.top <= y && rect.left <= x && rect.bottom > y && rect.right > x,
    )
  }

  dispatchEvent(event) {
    if (this.element) this.element.dispatchEvent(event)
  }

  render() {}
}

export class Highlight extends Mark {
  constructor(range, className, data, attributes) {
    super()
    this.range = range
    this.className = className
    this.data = data || {}
    this.attributes = attributes || {}
  }

  bind(element) {
    super.bind(element)
    Object.assign(this.element.dataset, this.data)
    for (let [name, value] of Object.entries(this.attributes)) {
      this.element.setAttribute(name, value)
    }
    if (this.className) this.element.classList.add(this.className)
  }

  render() {
    this.element.replaceChildren()
    let fragment = this.element.ownerDocument.createDocumentFragment()
    for (let rect of this.rects) {
      let element = svgElement(this.element.ownerDocument, 'rect')
      element.setAttribute('x', rect.left)
      element.setAttribute('y', rect.top)
      element.setAttribute('width', rect.width)
      element.setAttribute('height', rect.height)
      fragment.appendChild(element)
    }
    this.element.appendChild(fragment)
  }
}

export class Underline extends Highlight {
  render() {
    this.element.replaceChildren()
    let fragment = this.element.ownerDocument.createDocumentFragment()
    for (let rect of this.rects) {
      let hitRect = svgElement(this.element.ownerDocument, 'rect')
      hitRect.setAttribute('x', rect.left)
      hitRect.setAttribute('y', rect.top)
      hitRect.setAttribute('width', rect.width)
      hitRect.setAttribute('height', rect.height)
      hitRect.setAttribute('fill', 'none')
      let line = svgElement(this.element.ownerDocument, 'line')
      line.setAttribute('x1', rect.left)
      line.setAttribute('x2', rect.right)
      line.setAttribute('y1', rect.bottom - 1)
      line.setAttribute('y2', rect.bottom - 1)
      line.setAttribute('stroke-width', 1)
      line.setAttribute('stroke', this.attributes.stroke || 'black')
      line.setAttribute('stroke-linecap', 'square')
      fragment.appendChild(hitRect)
      fragment.appendChild(line)
    }
    this.element.appendChild(fragment)
  }
}
