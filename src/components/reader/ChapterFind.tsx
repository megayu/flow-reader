import { ChevronDownIcon, ChevronUpIcon, XIcon } from 'lucide-react'
import type React from 'react'
import { useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useSnapshot } from 'valtio'

import { useTranslation } from '../../hooks/useTranslation'
import type { BookTab } from '../../models/reader'
import { setClickedAnnotation } from '../Annotation'

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

export interface ChapterFindBarProps {
  find: ChapterFindState
  inputRef: React.RefObject<HTMLInputElement | null>
  onChange: (query: string) => void
  onClose: () => void
  onNext: () => void
  onPrevious: () => void
}

export interface ChapterFindOverlayProps {
  anchorRef: React.RefObject<HTMLElement | null>
  children: React.ReactNode
}

export const ChapterFindOverlay: React.FC<ChapterFindOverlayProps> = ({ anchorRef, children }) => {
  const [style, setStyle] = useState<React.CSSProperties>()

  useLayoutEffect(() => {
    const anchor = anchorRef.current
    if (!anchor) return

    let frame = 0
    const update = () => {
      window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(() => {
        const rect = anchor.getBoundingClientRect()

        setStyle({
          position: 'fixed',
          right: Math.max(8, window.innerWidth - rect.right + 8),
          bottom: Math.max(8, window.innerHeight - rect.top + 8),
          zIndex: 50,
        })
      })
    }

    update()

    const observer = new ResizeObserver(update)
    observer.observe(anchor)
    window.addEventListener('resize', update)

    return () => {
      window.cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener('resize', update)
    }
  }, [anchorRef])

  if (!style) return null

  return createPortal(<div style={style}>{children}</div>, document.body)
}

export const ChapterFindBar: React.FC<ChapterFindBarProps> = ({
  find,
  inputRef,
  onChange,
  onClose,
  onNext,
  onPrevious,
}) => {
  const t = useTranslation('shortcuts')
  const count = find.results.length
  const current = count ? find.activeIndex + 1 : 0
  const disabled = !count || find.searching

  useLayoutEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [inputRef])

  return (
    <div
      data-flow-chapter-find-bar
      data-flow-keyboard-capture="true"
      className="text-muted-foreground bg-background flex items-center gap-2 rounded-lg px-3 py-2 shadow-lg"
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <input
        ref={inputRef}
        aria-label={t('chapter_find')}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        className="text-foreground w-40 bg-transparent px-1 py-0.5 text-base outline-none"
        value={find.query}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter') {
            e.preventDefault()
            e.shiftKey ? onPrevious() : onNext()
          }
          if (e.key === 'Escape') {
            e.preventDefault()
            onClose()
          }
        }}
      />
      <div className="text-muted-foreground min-w-14 text-center text-base">
        {find.searching ? '...' : `${current}/${count}`}
      </div>
      <button
        type="button"
        aria-label={t('previous_find_result')}
        className="text-muted-foreground hover:text-foreground p-1 disabled:opacity-40"
        disabled={disabled}
        onClick={onPrevious}
      >
        <ChevronUpIcon className="size-5.5" />
      </button>
      <button
        type="button"
        aria-label={t('next_find_result')}
        className="text-muted-foreground hover:text-foreground p-1 disabled:opacity-40"
        disabled={disabled}
        onClick={onNext}
      >
        <ChevronDownIcon className="size-5.5" />
      </button>
      <button type="button" className="text-muted-foreground hover:text-foreground p-1" onClick={onClose}>
        <XIcon className="size-5.5" />
      </button>
    </div>
  )
}

export interface ChapterFindHighlightsProps {
  active: boolean
  find: ChapterFindState
  tab: BookTab
}
export const ChapterFindHighlights: React.FC<ChapterFindHighlightsProps> = ({ active, find, tab }) => {
  const { rendition, paginationVersion, viewVersion } = useSnapshot(tab)
  const matches = useMemo(() => {
    if (!find.open) return []

    const seen = new Set<string>()
    return find.results.flatMap((result, index) => {
      if (!result.cfi || seen.has(result.cfi)) return []

      seen.add(result.cfi)
      return [
        {
          active: index === find.activeIndex,
          cfi: result.cfi,
        },
      ]
    })
  }, [find.activeIndex, find.open, find.results])

  useEffect(() => {
    if (!active || !matches.length) return

    const addHighlight = (cfi: string, styles: Record<string, string>) => {
      try {
        rendition?.annotations.highlight(
          cfi,
          undefined,
          () => {
            setClickedAnnotation(true)
          },
          undefined,
          styles,
        )
      } catch (_error) {
        // ignore matched text in unsupported nodes
      }
    }

    for (const match of matches) {
      if (!match.active) {
        addHighlight(match.cfi, {
          fill: 'rgba(234, 179, 8, 0.3)',
          'fill-opacity': 'unset',
        })
      }
    }
    const activeMatch = matches.find((match) => match.active)
    if (activeMatch) {
      addHighlight(activeMatch.cfi, {
        fill: 'rgba(59, 130, 246, 0.46)',
        'fill-opacity': 'unset',
      })
    }

    return () => {
      matches.forEach((match) => {
        try {
          rendition?.annotations.remove(match.cfi, 'highlight')
        } catch (_error) {
          // ignore removed views
        }
      })
    }
  }, [active, matches, paginationVersion, rendition?.annotations, viewVersion])

  return null
}

export function isFindShortcut(e: KeyboardEvent) {
  return (e.ctrlKey || e.metaKey) && !e.altKey && (e.key.toLowerCase() === 'f' || e.code === 'KeyF')
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
