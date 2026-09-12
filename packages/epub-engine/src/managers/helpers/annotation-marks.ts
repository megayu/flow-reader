import type { NumericSvg } from './annotation-pane'

type Rect = Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>
type UnderlineOptions = {
  writingMode?: string
  gap?: number
}

import { Highlight } from './annotation-pane'

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg'

class WavyUnderline extends Highlight {
  render() {
    while (this.element!.firstChild!) {
      this.element!.removeChild(this.element!.firstChild!)
    }

    let docFrag = this.element!.ownerDocument.createDocumentFragment()
    let filtered = this.rects!
    let stroke = this.attributes.stroke || 'black'
    let strokeOpacity = this.attributes['stroke-opacity'] || '0.9'
    let strokeWidth = numberAttribute(this.attributes, 'stroke-width', 1.8)
    let amplitude = numberAttribute(this.attributes, 'data-wave-amplitude', 2)
    let period = numberAttribute(this.attributes, 'data-wave-period', 7)
    let gap = numberAttribute(this.attributes, 'data-wave-gap', 1.5)

    for (let i = 0, len = filtered.length; i < len; i++) {
      let r = filtered[i]!
      let x = r.left
      let y = r.bottom + gap
      let geometry = underlineGeometry(
        {
          left: x,
          top: r.top,
          width: r.width,
          height: r.height,
        },
        {
          gap,
          writingMode: this.attributes['data-writing-mode'] as
            | string
            | undefined,
        },
      )

      let rect = createSvgElement(this.element!.ownerDocument, 'rect')
      rect.setAttribute('x', x)
      rect.setAttribute('y', r.top)
      rect.setAttribute('height', r.height)
      rect.setAttribute('width', r.width)
      rect.setAttribute('fill', 'none')
      rect.setAttribute('stroke', 'none')

      let path = createSvgElement(this.element!.ownerDocument, 'path')
      path.setAttribute(
        'd',
        geometry.orientation === 'vertical'
          ? wavyVerticalPath(
              geometry.x,
              geometry.start,
              geometry.length,
              amplitude,
              period,
            )
          : wavyUnderlinePath(x, r.width, y, amplitude, period),
      )
      path.setAttribute('fill', 'none')
      path.setAttribute('stroke', stroke)
      path.setAttribute('stroke-opacity', strokeOpacity)
      path.setAttribute('stroke-width', strokeWidth)
      path.setAttribute('stroke-linecap', 'round')
      path.setAttribute('stroke-linejoin', 'round')

      docFrag.appendChild(rect)
      docFrag.appendChild(path)
    }

    this.element!.appendChild(docFrag)
  }
}

class VerticalUnderline extends Highlight {
  render() {
    while (this.element!.firstChild!) {
      this.element!.removeChild(this.element!.firstChild!)
    }

    let docFrag = this.element!.ownerDocument.createDocumentFragment()
    let filtered = this.rects!
    let stroke = this.attributes.stroke || 'black'
    let strokeOpacity = this.attributes['stroke-opacity'] || '0.3'
    let strokeWidth = numberAttribute(this.attributes, 'stroke-width', 1)
    let gap = numberAttribute(this.attributes, 'data-underline-gap', 1.5)

    for (let i = 0, len = filtered.length; i < len; i++) {
      let r = filtered[i]!
      let rect = {
        left: r.left,
        top: r.top,
        width: r.width,
        height: r.height,
      }
      let geometry = underlineGeometry(rect, {
        gap,
        writingMode: 'vertical-rl',
      })
      let hitRect = createSvgElement(this.element!.ownerDocument, 'rect')
      hitRect.setAttribute('x', rect.left)
      hitRect.setAttribute('y', rect.top)
      hitRect.setAttribute('height', rect.height)
      hitRect.setAttribute('width', rect.width)
      hitRect.setAttribute('fill', 'none')
      hitRect.setAttribute('stroke', 'none')

      let line = createSvgElement(this.element!.ownerDocument, 'line')
      line.setAttribute('x1', geometry.x!)
      line.setAttribute('x2', geometry.x!)
      line.setAttribute('y1', geometry.start)
      line.setAttribute('y2', geometry.start + geometry.length)
      line.setAttribute('stroke', stroke)
      line.setAttribute('stroke-opacity', strokeOpacity)
      line.setAttribute('stroke-width', strokeWidth)
      line.setAttribute('stroke-linecap', 'round')

      docFrag.appendChild(hitRect)
      docFrag.appendChild(line)
    }

    this.element!.appendChild(docFrag)
  }
}

function createSvgElement(document: Document, tagName: string) {
  return document.createElementNS(SVG_NAMESPACE, tagName) as NumericSvg
}

function numberAttribute(
  attributes: Record<string, string | number>,
  name: string,
  fallback: number,
) {
  let value = Number(attributes[name])
  return Number.isFinite(value) ? value : fallback
}

function wavyUnderlinePath(
  x: number,
  width: number,
  y: number,
  amplitude: number,
  period: number,
) {
  let halfPeriod = Math.max(period / 2, 1)
  let remaining = Math.max(width, 0)
  let cursor = 0
  let direction = -1
  let path = `M${x} ${y}`

  while (remaining > 0) {
    let segment = Math.min(halfPeriod, remaining)
    let controlX = x + cursor + segment / 2
    let endX = x + cursor + segment

    path += ` Q${controlX} ${y + direction * amplitude} ${endX} ${y}`
    cursor += segment
    remaining -= segment
    direction *= -1
  }

  return path
}

function wavyVerticalPath(
  x: number,
  y: number,
  height: number,
  amplitude: number,
  period: number,
) {
  let halfPeriod = Math.max(period / 2, 1)
  let remaining = Math.max(height, 0)
  let cursor = 0
  let direction = -1
  let path = `M${x} ${y}`

  while (remaining > 0) {
    let segment = Math.min(halfPeriod, remaining)
    let controlY = y + cursor + segment / 2
    let endY = y + cursor + segment

    path += ` Q${x + direction * amplitude} ${controlY} ${x} ${endY}`
    cursor += segment
    remaining -= segment
    direction *= -1
  }

  return path
}

function underlineGeometry(rect: Rect, options: UnderlineOptions = {}) {
  if (options.writingMode === 'vertical-rl') {
    return {
      orientation: 'vertical' as const,
      side: 'left',
      x: rect.left - (options.gap || 0),
      start: rect.top,
      length: rect.height,
    }
  }

  return {
    orientation: 'horizontal' as const,
    side: 'bottom',
    y: rect.top + rect.height + (options.gap || 0),
    start: rect.left,
    length: rect.width,
  }
}

export { WavyUnderline, VerticalUnderline, underlineGeometry }
