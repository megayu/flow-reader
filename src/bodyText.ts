import { Contents } from '@flow/epubjs'

export const notePopoverClass = 'flow-note-popover'

export const bodyTextAttribute = 'data-flow-body-text'
export const bodyTextSelector = `[${bodyTextAttribute}="true"]`
export const bodyTextCandidateSelector = 'p, blockquote > p, div'
const bodyTextDetectedAttribute = 'data-flow-body-text-detected'

export interface BodyTextDetectionCacheEntry {
  candidateCount: number
  bodyIndexes: number[]
}

export type BodyTextDetectionCache = Map<string, BodyTextDetectionCacheEntry>

export interface BodyTypographyBaseline {
  fontSize?: number
  fontWeight?: number
  lineHeight?: number
}

export function getBodyTypographyBaseline(
  contents: Contents | undefined,
  _bodyTextCache?: BodyTextDetectionCache,
): BodyTypographyBaseline {
  if (!contents) return {}

  const candidates = getBodyTextCandidates(contents.document)
  const bodyIndexes = detectBodyTextIndexes(contents, candidates)
  const firstBodyIndex = bodyIndexes[0]

  const el =
    (firstBodyIndex === undefined ? undefined : candidates[firstBodyIndex]) ??
    contents.document.body
  if (!el) return {}

  const style = contents.window.getComputedStyle(el)
  const fontSize = parseCssPixel(style.fontSize)
  const fontWeight = parseCssFontWeight(style.fontWeight)
  const lineHeight = parseCssLineHeight(style.lineHeight, fontSize)

  return {
    fontSize,
    fontWeight,
    lineHeight,
  }
}

export function ensureBodyTextMarkers(
  contents: Contents,
  bodyTextCache?: BodyTextDetectionCache,
) {
  const document = contents.document
  const body = document?.body
  if (!document || !body) return

  if (body.getAttribute(bodyTextDetectedAttribute) === 'true') {
    return
  }

  const candidates = getBodyTextCandidates(document)
  if (!candidates.length) return

  const cacheKey = getBodyTextCacheKey(contents)
  const cached = cacheKey ? bodyTextCache?.get(cacheKey) : undefined

  clearBodyTextMarkers(candidates)

  if (
    cached &&
    cached.candidateCount === candidates.length &&
    cached.bodyIndexes.length
  ) {
    applyBodyTextIndexes(candidates, cached.bodyIndexes)
    body.setAttribute(bodyTextDetectedAttribute, 'true')
    return
  }

  const bodyIndexes = detectBodyTextIndexes(contents, candidates)
  if (!bodyIndexes.length) return

  applyBodyTextIndexes(candidates, bodyIndexes)
  body.setAttribute(bodyTextDetectedAttribute, 'true')

  if (cacheKey) {
    bodyTextCache?.set(cacheKey, {
      candidateCount: candidates.length,
      bodyIndexes,
    })
  }
}

export function getBodyTextCandidates(document: Document) {
  return [...document.querySelectorAll<HTMLElement>(bodyTextCandidateSelector)]
}

export function detectBodyTextIndexes(
  contents: Contents,
  candidates: HTMLElement[],
) {
  const window = contents.window
  const bodyTextCandidates = candidates.flatMap((el, index) => {
    const text = getBodyTextCandidateText(el)
    if (!text) return []
    if (isFactuallyExcludedElement(el)) return []
    if (isImageOnlyElement(el)) return []
    if (isStructuralDiv(el)) return []

    const style = window.getComputedStyle(el)
    if (isInvisible(style)) return []

    return [
      {
        baseSignature: createBodyTextBaseSignature(el, style),
        index,
        inlineMargin: getInlineMargin(style),
        textLength: text.length,
        signature: createBodyTextSignature(el, style),
      },
    ]
  })

  if (!bodyTextCandidates.length) return []

  const clusters = createBodyTextClusters(bodyTextCandidates)
  const bodyClusters = selectBodyTextClusters(clusters)
  const clusterCounts = new Map(
    clusters.map((cluster) => [cluster.signature, cluster.count]),
  )
  const selectedSignatures = new Set(
    bodyClusters.map((cluster) => cluster.signature),
  )
  const selectedBaseSignatures = new Set(
    bodyTextCandidates.flatMap((candidate) =>
      selectedSignatures.has(candidate.signature)
        ? [candidate.baseSignature]
        : [],
    ),
  )

  return bodyTextCandidates.flatMap((candidate) =>
    selectedSignatures.has(candidate.signature) ||
    (selectedBaseSignatures.has(candidate.baseSignature) &&
      clusterCounts.get(candidate.signature) === 1)
      ? [candidate.index]
      : [],
  )
}

function getBodyTextCacheKey(contents: Contents) {
  const sectionIndex = (contents as any).sectionIndex
  return sectionIndex === undefined || sectionIndex === null
    ? undefined
    : String(sectionIndex)
}

function clearBodyTextMarkers(candidates: HTMLElement[]) {
  candidates.forEach((el) => {
    el.removeAttribute(bodyTextAttribute)
  })
}

function applyBodyTextIndexes(
  candidates: HTMLElement[],
  bodyIndexes: number[],
) {
  bodyIndexes.forEach((index) => {
    candidates[index]?.setAttribute(bodyTextAttribute, 'true')
  })
}

interface BodyTextCandidate {
  baseSignature: string
  index: number
  inlineMargin: number
  textLength: number
  signature: string
}

interface BodyTextCluster {
  signature: string
  indexes: number[]
  count: number
  totalText: number
  avgText: number
  inlineMargin: number
  score: number
}

function isFactuallyExcludedElement(el: HTMLElement) {
  return !!el.closest(
    [
      `.${notePopoverClass}`,
      '[role="doc-footnote"]',
      '[role="doc-endnote"]',
      '[epub\\:type*="footnote"]',
      '[epub\\:type*="endnote"]',
      '[epub\\:type*="rearnote"]',
      '[type*="footnote"]',
      '[type*="endnote"]',
      '[type*="rearnote"]',
      'table',
      'thead',
      'tbody',
      'tfoot',
      'tr',
      'td',
      'th',
      'caption',
      'figure',
      'figcaption',
      'nav',
      'aside',
      'ol',
      'ul',
    ].join(','),
  )
}

function isImageOnlyElement(el: HTMLElement) {
  const meaningfulChildren = [...el.childNodes].filter((node) => {
    if (node.nodeType === 3) {
      return !!normalizeText(node.textContent)
    }

    if (isElementWithTag(node, 'br')) {
      return false
    }

    return true
  })

  return (
    meaningfulChildren.length > 0 &&
    meaningfulChildren.every((node) => {
      return isElementWithTag(node, 'img') || isElementWithTag(node, 'svg')
    })
  )
}

function isStructuralDiv(el: HTMLElement) {
  if (el.tagName.toLowerCase() !== 'div') return false

  return !!el.querySelector(
    [
      'p',
      'div',
      'blockquote',
      'table',
      'figure',
      'img',
      'h1',
      'h2',
      'h3',
      'h4',
      'h5',
      'h6',
      'ol',
      'ul',
    ].join(','),
  )
}

function createBodyTextSignature(el: HTMLElement, style: CSSStyleDeclaration) {
  return [
    el.tagName.toLowerCase(),
    normalizedClassName(el),
    style.fontFamily,
    style.fontSize,
    style.fontWeight,
    style.lineHeight,
    style.color,
    style.backgroundColor,
    style.textAlign,
    style.textIndent,
    style.marginLeft,
    style.marginRight,
    style.marginTop,
    style.marginBottom,
  ].join('|')
}

function createBodyTextBaseSignature(
  el: HTMLElement,
  style: CSSStyleDeclaration,
) {
  return [
    el.tagName.toLowerCase(),
    style.fontFamily,
    style.fontSize,
    style.fontWeight,
    style.lineHeight,
    style.color,
    style.backgroundColor,
    style.textAlign,
  ].join('|')
}

function normalizedClassName(el: HTMLElement) {
  return [...el.classList].sort().join(' ')
}

function getInlineMargin(style: CSSStyleDeclaration) {
  return (
    (parseCssPixel(style.marginLeft) ?? 0) +
    (parseCssPixel(style.marginRight) ?? 0)
  )
}

function getBodyTextCandidateText(el: HTMLElement) {
  const directText = getDirectText(el)
  return collectBodyTextCandidateText(el, {
    excludeClassedDescendants: !!directText,
    root: el,
  })
}

function getDirectText(el: HTMLElement) {
  let text = ''
  for (const node of el.childNodes) {
    if (node.nodeType === 3) text += node.textContent ?? ''
  }
  return normalizeText(text)
}

function collectBodyTextCandidateText(
  node: Node,
  options: { excludeClassedDescendants: boolean; root: HTMLElement },
): string {
  if (node.nodeType === 3) {
    return normalizeText(node.textContent)
  }

  if (node.nodeType !== 1) return ''

  const el = node as HTMLElement
  if (el !== options.root) {
    if (options.excludeClassedDescendants && normalizedClassName(el)) return ''
    if (isElementWithTag(el, 'br')) return ''
    if (isElementWithTag(el, 'img') || isElementWithTag(el, 'svg')) return ''
    if (isFactuallyExcludedElement(el)) return ''
  }

  return [...el.childNodes]
    .map((child) => collectBodyTextCandidateText(child, options))
    .join('')
}

function createBodyTextClusters(candidates: BodyTextCandidate[]) {
  const clusters = new Map<string, BodyTextCluster>()

  candidates.forEach((candidate) => {
    const cluster = clusters.get(candidate.signature) ?? {
      signature: candidate.signature,
      indexes: [],
      count: 0,
      totalText: 0,
      avgText: 0,
      inlineMargin: candidate.inlineMargin,
      score: 0,
    }

    cluster.indexes.push(candidate.index)
    cluster.count += 1
    cluster.totalText += candidate.textLength
    clusters.set(candidate.signature, cluster)
  })

  return [...clusters.values()].map((cluster) => {
    const avgText = cluster.totalText / cluster.count
    return {
      ...cluster,
      avgText,
      score: cluster.totalText + cluster.count * 80,
    }
  })
}

function selectBodyTextClusters(clusters: BodyTextCluster[]) {
  const viable = clusters.filter(
    (cluster) => cluster.count >= 2 || cluster.totalText >= 80,
  )
  const candidates = viable.length ? viable : clusters
  const winner = selectBodyTextWinner(candidates)

  if (!winner) return clusters

  const selected = [winner]
  const rest = candidates
    .filter((cluster) => cluster !== winner)
    .sort((a, b) => b.score - a.score)
  const runnerUp = rest[0]

  if (runnerUp && runnerUp.inlineMargin > winner.inlineMargin) {
    return selected
  }

  for (const cluster of rest) {
    if (selected.length >= 3) break

    const totalTextRatio = cluster.totalText / winner.totalText
    const countRatio = cluster.count / winner.count
    const avgTextRatio = cluster.avgText / winner.avgText
    if (
      shouldIncludeBodyTextCluster(
        cluster,
        winner,
        totalTextRatio,
        countRatio,
        avgTextRatio,
      )
    ) {
      selected.push(cluster)
    }
  }

  return selected
}

function shouldIncludeBodyTextCluster(
  cluster: BodyTextCluster,
  winner: BodyTextCluster,
  totalTextRatio: number,
  countRatio: number,
  avgTextRatio: number,
) {
  if (totalTextRatio >= 0.35) return true

  if (cluster.totalText < 100 || totalTextRatio < 0.2) return false

  return countRatio >= 0.35 && avgTextRatio >= 0.5
}

function selectBodyTextWinner(clusters: BodyTextCluster[]) {
  if (!clusters.length) return
  if (clusters.length === 1) return clusters[0]

  const byTotalText = [...clusters].sort((a, b) => b.totalText - a.totalText)
  const totalTextWinner = byTotalText[0]!
  const totalTextRunnerUp = byTotalText[1]!
  if (
    totalTextWinner.totalText >= totalTextRunnerUp.totalText * 2 &&
    totalTextWinner.count >= 2
  ) {
    return totalTextWinner
  }

  const byCount = [...clusters].sort((a, b) => b.count - a.count)
  const countWinner = byCount[0]!
  const countRunnerUp = byCount[1]!
  if (
    countWinner.count >= countRunnerUp.count * 2 &&
    countWinner.totalText >= 200
  ) {
    return countWinner
  }

  const byScore = [...clusters].sort((a, b) => b.score - a.score)
  const scoreWinner = byScore[0]!
  const scoreRunnerUp = byScore[1]!
  if (scoreWinner.score >= scoreRunnerUp.score * 1.35) {
    return scoreWinner
  }
}

function isElementWithTag(node: Node, tagName: string) {
  return (
    node.nodeType === 1 && (node as Element).tagName?.toLowerCase() === tagName
  )
}

function isInvisible(style: CSSStyleDeclaration) {
  return style.display === 'none' || style.visibility === 'hidden'
}

function normalizeText(value: string | null | undefined) {
  return value?.replace(/\s+/g, '') ?? ''
}

function parseCssPixel(value: string) {
  const number = parseFloat(value)
  return Number.isFinite(number) ? number : undefined
}

function parseCssFontWeight(value: string) {
  if (value === 'normal') return 400
  if (value === 'bold') return 700

  const number = parseFloat(value)
  if (!Number.isFinite(number)) return undefined

  return Math.min(900, Math.max(100, Math.round(number / 100) * 100))
}

function parseCssLineHeight(value: string, fontSize?: number) {
  if (value === 'normal') return 1.2

  const lineHeight = parseCssPixel(value)
  if (!lineHeight || !fontSize) return undefined

  return Math.round((lineHeight / fontSize) * 10) / 10
}
