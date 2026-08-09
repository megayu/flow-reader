import { ChevronDownIcon, ChevronUpIcon, XIcon } from 'lucide-react'
import type React from 'react'
import { useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useSnapshot } from 'valtio'

import { useTranslation } from '../../hooks/useTranslation'
import type { BookTab } from '../../models/reader'
import { IconButton } from '../IconButton'
import { Input } from '../ui/input'

import type { ChapterFindState } from './chapterFindModel'

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
  const t = useTranslation('reader')
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
      <Input
        ref={inputRef}
        aria-label={t('find_current_chapter')}
        className="text-foreground h-auto w-40 rounded-none border-0 bg-transparent px-1 py-0.5 text-base shadow-none focus-visible:border-transparent focus-visible:ring-0 dark:bg-transparent"
        escapeBehavior="none"
        focusBehavior="select-all"
        value={find.query}
        onValueChange={onChange}
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
      <IconButton
        aria-label={t('previous_find_result')}
        Icon={ChevronUpIcon}
        iconClassName="size-5.5"
        className="text-muted-foreground hover:text-foreground size-7 hover:bg-transparent disabled:opacity-40"
        disabled={disabled}
        onClick={onPrevious}
      />
      <IconButton
        aria-label={t('next_find_result')}
        Icon={ChevronDownIcon}
        iconClassName="size-5.5"
        className="text-muted-foreground hover:text-foreground size-7 hover:bg-transparent disabled:opacity-40"
        disabled={disabled}
        onClick={onNext}
      />
      <IconButton
        Icon={XIcon}
        iconClassName="size-5.5"
        className="text-muted-foreground hover:text-foreground size-7 hover:bg-transparent"
        onClick={onClose}
      />
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
        rendition?.annotations.highlight(cfi, undefined, () => {}, undefined, styles)
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
