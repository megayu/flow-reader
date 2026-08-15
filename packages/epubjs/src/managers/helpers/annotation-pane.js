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

function mergeLineFragments(rects, vertical) {
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
    let sameLine =
      line &&
      Math.abs(line.center - fragment.geometry.center) <=
        Math.max(1, Math.min(line.size, fragment.geometry.size) / 2)

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

  for (let i = 0; i < lines.length - 1; i++) {
    let current = lines[i]
    let next = lines[i + 1]
    if (current.maxEnd <= next.minStart) continue
    let boundary = (current.center + next.center) / 2
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
    result.set(mark, mergeLineFragments(rects, vertical))
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
    this.writingMode = writingMode
    this.batchDepth = 0
    this.element = svgElement(container.ownerDocument, 'svg')
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
    for (let mark of this.marks) {
      if (!mark.rawRects) mark.measure()
    }
    this.updateMarks()
  }

  addMark(mark) {
    let group = svgElement(this.element.ownerDocument, 'g')
    this.element.appendChild(group)
    mark.bind(group)
    this.marks.push(mark)
    if (this.batchDepth === 0) {
      mark.measure()
      this.updateMarks()
    }
    return mark
  }

  removeMark(mark) {
    let index = this.marks.indexOf(mark)
    if (index === -1) return
    let element = mark.unbind()
    if (element) element.remove()
    this.marks.splice(index, 1)
    if (this.batchDepth === 0) this.updateMarks()
  }

  render() {
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
    this.element.remove()
  }
}

export class Mark {
  constructor() {
    this.element = null
    this.rawRects = undefined
    this.rects = undefined
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
    this.rawRects = Array.from(this.range.getClientRects(), plainRect)
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
