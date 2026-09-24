import type { LayoutProperties } from './layout'
import type Contents from './contents'

import EpubCFI from './epubcfi'
import { nodeBounds } from './utils/core'

type PageMapping = {
  start: number
  end: number
  first: Node
  previous: Node
  result: { start: string; end: string }
}
type MappingState = { root: Node; key: string; current?: PageMapping }

/**
 * Map text locations to CFI ranges
 * @class
 * @param {Layout} layout Layout to apply
 * @param {string} [direction="ltr"] Text direction
 * @param {string} [axis="horizontal"] vertical or horizontal axis
 * @param {boolean} [dev] toggle developer highlighting
 */
class Mapping {
  declare layout: LayoutProperties
  declare horizontal: boolean
  declare direction: string
  declare _dev: boolean
  styleSignature = ''
  private history = new WeakMap<Contents, MappingState>()

  invalidate() {
    this.history = new WeakMap()
  }

  constructor(
    layout: LayoutProperties,
    direction?: string,
    axis?: string,
    dev = false,
  ) {
    this.layout = layout
    this.horizontal = axis === 'horizontal' ? true : false
    this.direction = direction || 'ltr'
    this._dev = dev
  }

  /**
   * Find CFI pairs for a page
   * @param {Contents} contents Contents from view
   * @param {string} cfiBase string of the base for a cfi
   * @param {number} start position to start at
   * @param {number} end position to end at
   */
  page(contents: Contents, cfiBase: string, start: number, end: number) {
    var root = contents && contents.document ? contents.document.body : false
    var result

    if (!root) {
      return
    }

    const key = [
      cfiBase, this.layout.width, this.layout.height, this.layout.pageWidth,
      this.layout.columnWidth, this.layout.gap, this.horizontal, this.direction,
      this.styleSignature, contents.mappingRevision,
    ].join(':')
    let state = this.history.get(contents)
    if (!state || state.root !== root || state.key !== key) {
      state = { root, key }
      this.history.set(contents, state)
    }
    const current = state.current
    if (current?.start === start && current.end === end) {
      result = { ...current.result }
    } else {
      const rtl = this.horizontal && this.direction === 'rtl'
      const later = current && (rtl
        ? current.start <= start && current.end <= end
        : current.start >= start && current.end >= end)
      const earlier = current && (rtl
        ? current.start >= start && current.end >= end
        : current.start <= start && current.end <= end)
      const resume = later
        ? { first: this.findBackwardResume(root, current.first, start, end), previous: root }
        : earlier ? current : undefined
      const ranges = this.findRanges(root, start, end, resume)
      const first = ranges.start!.startContainer
      result = this.rangePairToCfiPair(cfiBase, ranges)
      state.current = { start, end, first, previous: ranges.previous, result: { ...result } }
    }

    if (this._dev === true) {
      let doc = contents.document
      let startRange = new EpubCFI(result.start).toRange(doc)
      let endRange = new EpubCFI(result.end).toRange(doc)

      let selection = doc.defaultView!.getSelection()!
      let r = doc.createRange()
      selection.removeAllRanges()
      r.setStart(startRange!.startContainer, startRange!.startOffset)
      r.setEnd(endRange!.endContainer, endRange!.endOffset)
      selection.addRange(r)
    }

    return result
  }

  /**
   * Walk a node, preforming a function on each node it finds
   * @private
   * @param {Node} root Node to walkToNode
   * @param {function} func walk function
   * @return {*} returns the result of the walk function
   */
  walk(root: Node, func: (node: Text) => Node | undefined, from?: Node, reverse = false) {
    // IE11 has strange issue, if root is text node IE throws exception on
    // calling treeWalker.nextNode(), saying
    // Unexpected call to method or property access instead of returning null value
    if (root && root.nodeType === Node.TEXT_NODE) {
      return
    }
    // safeFilter is required so that it can work in IE as filter is a function for IE
    // and for other browser filter is an object.
    var filter = {
      acceptNode: function (node: Node) {
        if ((node as Text).data.trim().length > 0) {
          return NodeFilter.FILTER_ACCEPT
        } else {
          return NodeFilter.FILTER_REJECT
        }
      },
    }
    var safeFilter = filter.acceptNode as typeof filter.acceptNode & {
      acceptNode: (node: Node) => number
    }
    safeFilter.acceptNode = filter.acceptNode

    var treeWalker = (
      root.ownerDocument!.createTreeWalker as (
        root: Node,
        mask: number,
        filter: NodeFilter,
        expand: boolean,
      ) => TreeWalker
    )(root, NodeFilter.SHOW_TEXT, safeFilter, false)
    var node
    var result
    if (from?.nodeType === Node.TEXT_NODE && root.contains(from)) {
      treeWalker.currentNode = from
      result = func(from as Text)
      if (result) return result
    }
    while ((node = reverse ? treeWalker.previousNode() : treeWalker.nextNode())) {
      result = func(node as Text)
      if (result) break
    }

    return result
  }

  findBackwardResume(root: Node, from: Node, start: number, end: number) {
    return this.walk(root, (node) => {
      const bounds = nodeBounds(node)
      const before = this.horizontal && this.direction === 'rtl'
        ? bounds.left >= end
        : this.horizontal ? bounds.right <= start : bounds.bottom <= start
      return before ? node : undefined
    }, from, true) || root
  }

  findRanges(root: Node, start: number, end: number, earlier?: Pick<PageMapping, 'first' | 'previous'>) {
    let startNode: Node | undefined
    let endNode: Node | undefined
    let startPrevious = earlier?.previous || root
    let endPrevious = earlier?.first || root
    const horizontal = this.horizontal
    const rtl = horizontal && this.direction === 'rtl'

    this.walk(root, (node) => {
      const bounds = nodeBounds(node)
      if (!startNode) {
        const matches = rtl
          ? (bounds.right <= end && bounds.right >= start) || bounds.left < end
          : horizontal
            ? (bounds.left >= start && bounds.left <= end) || bounds.right > start
            : (bounds.top >= start && bounds.top <= end) || bounds.bottom > start
        if (matches) startNode = node
        else startPrevious = node
      }

      const leading = Math.round(rtl || horizontal ? bounds.left : bounds.top)
      const trailing = Math.round(rtl || horizontal ? bounds.right : bounds.bottom)
      if (rtl ? trailing < start : leading > end) {
        endNode = endPrevious
      } else if (rtl ? leading < start : trailing > end) {
        endNode = node
      } else {
        endPrevious = node
      }
      return endNode
    }, earlier?.first)

    const first = startNode || startPrevious
    const last = endNode || endPrevious
    return {
      start: this.findTextStartRange(first, start, end),
      end: this.findTextEndRange(last, start, end),
      previous: startPrevious,
    }
  }

  /**
   * Find Text Start Range
   * @private
   * @param {Node} root root node
   * @param {number} start position to start at
   * @param {number} end position to end at
   * @return {Range}
   */
  findTextStartRange(node: Node, start: number, end: number) {
    var ranges = this.splitTextNodeIntoRanges(node)
    var range
    var pos
    var left, top, right

    for (var i = 0; i < ranges.length; i++) {
      range = ranges[i]!

      pos = range.getBoundingClientRect()

      if (this.horizontal && this.direction === 'ltr') {
        left = pos.left
        if (left >= start) {
          return range
        }
      } else if (this.horizontal && this.direction === 'rtl') {
        right = pos.right
        if (right <= end) {
          return range
        }
      } else {
        top = pos.top
        if (top >= start) {
          return range
        }
      }

      // prev = range;
    }

    return ranges[0]
  }

  /**
   * Find Text End Range
   * @private
   * @param {Node} root root node
   * @param {number} start position to start at
   * @param {number} end position to end at
   * @return {Range}
   */
  findTextEndRange(node: Node, start: number, end: number) {
    var ranges = this.splitTextNodeIntoRanges(node)
    var prev
    var range
    var pos
    var left, right, top, bottom

    for (var i = 0; i < ranges.length; i++) {
      range = ranges[i]!

      pos = range.getBoundingClientRect()

      if (this.horizontal && this.direction === 'ltr') {
        left = pos.left
        right = pos.right

        if (left > end && prev) {
          return prev
        } else if (right > end) {
          return range
        }
      } else if (this.horizontal && this.direction === 'rtl') {
        left = pos.left
        right = pos.right

        if (right < start && prev) {
          return prev
        } else if (left < start) {
          return range
        }
      } else {
        top = pos.top
        bottom = pos.bottom

        if (top > end && prev) {
          return prev
        } else if (bottom > end) {
          return range
        }
      }

      prev = range
    }

    // Ends before limit
    return ranges[ranges.length - 1]
  }

  /**
   * Split up a text node into ranges for each word
   * @private
   * @param {Node} root root node
   * @param {string} [_splitter] what to split on
   * @return {Range[]}
   */
  splitTextNodeIntoRanges(node: Node, _splitter?: string) {
    var ranges: Range[] = []
    var textContent = node.textContent || ''
    var text = textContent.trim()
    var range: Range | false
    var doc = node.ownerDocument!
    var splitter = _splitter || ' '

    var pos = text.indexOf(splitter)

    if (pos === -1 || node.nodeType != Node.TEXT_NODE) {
      range = doc.createRange()
      range.selectNodeContents(node)
      return [range]
    }

    range = doc.createRange()
    range.setStart(node, 0)
    range.setEnd(node, pos)
    ranges.push(range)
    range = false

    while (pos != -1) {
      pos = text.indexOf(splitter, pos + 1)
      if (pos > 0) {
        if (range) {
          range.setEnd(node, pos)
          ranges.push(range)
        }

        range = doc.createRange()
        range.setStart(node, pos + 1)
      }
    }

    if (range) {
      range.setEnd(node, text.length)
      ranges.push(range)
    }

    return ranges
  }

  /**
   * Turn a pair of ranges into a pair of CFIs
   * @private
   * @param {string} cfiBase base string for an EpubCFI
   * @param {object} rangePair { start: Range, end: Range }
   * @return {object} { start: "epubcfi(...)", end: "epubcfi(...)" }
   */
  rangePairToCfiPair(
    cfiBase: string,
    rangePair: { start: Range | undefined; end: Range | undefined },
  ) {
    var startRange = rangePair.start
    var endRange = rangePair.end

    startRange!.collapse(true)
    endRange!.collapse(false)

    let startCfi = new EpubCFI(startRange, cfiBase).toString()
    let endCfi = new EpubCFI(endRange, cfiBase).toString()

    return {
      start: startCfi,
      end: endCfi,
    }
  }

  /**
   * Set the axis for mapping
   * @param {string} axis horizontal | vertical
   * @return {boolean} is it horizontal?
   */
  axis(axis?: string) {
    if (axis) {
      this.horizontal = axis === 'horizontal' ? true : false
    }
    return this.horizontal
  }
}

export default Mapping
