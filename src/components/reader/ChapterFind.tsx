import { ChevronDownIcon, ChevronUpIcon, XIcon } from 'lucide-react'
import type React from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useSnapshot } from 'valtio'

import { useTranslation } from '../../hooks/useTranslation'
import type { BookTab } from '../../models/reader'
import { IconButton } from '../IconButton'
import { Input } from '../ui/input'

import { type ChapterFindState, isFindShortcut } from './chapterFindModel'

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
  const t = useTranslation()
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
      onKeyDownCapture={(e) => {
        if (!isFindShortcut(e.nativeEvent)) return
        e.preventDefault()
        e.stopPropagation()
        inputRef.current?.focus()
        inputRef.current?.select()
      }}
    >
      <Input
        ref={inputRef}
        aria-label={t('reader.find_current_chapter')}
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
        aria-label={t('reader.previous_find_result')}
        Icon={ChevronUpIcon}
        iconClassName="size-5.5"
        className="text-muted-foreground hover:text-foreground size-7 hover:bg-transparent disabled:opacity-40"
        disabled={disabled}
        onClick={onPrevious}
      />
      <IconButton
        aria-label={t('reader.next_find_result')}
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
  const { rendition, viewVersion } = useSnapshot(tab)
  const previousActive = useRef<string | undefined>(undefined)
  const activeCfi = find.results[find.activeIndex]?.cfi

  useEffect(() => {
    const annotations = rendition?.annotations
    previousActive.current = undefined
    if (!active || !find.open || !find.results.length || !annotations) return
    const installed = new Set<string>()

    annotations.batch(() => {
      for (const match of find.results) {
        if (installed.has(match.cfi)) continue
        try {
          annotations.highlight(
            match.cfi,
            undefined,
            () => {},
            undefined,
            {
              fill: 'rgba(234, 179, 8, 0.3)',
              'fill-opacity': 'unset',
            },
            match.range,
          )
          installed.add(match.cfi)
        } catch (_error) {
          // A view may have been removed while the query was running.
        }
      }
    })

    return () => {
      annotations.batch(() => {
        installed.forEach((cfi) => {
          try {
            annotations.remove(cfi, 'highlight')
          } catch (_error) {
            // ignore removed views
          }
        })
      })
    }
  }, [active, find.open, find.results, rendition?.annotations, viewVersion])

  useEffect(() => {
    const annotations = rendition?.annotations
    if (!active || !find.open || !annotations) return
    if (previousActive.current) {
      annotations.updateHighlightStyles(previousActive.current, { fill: 'rgba(234, 179, 8, 0.3)' })
    }
    if (activeCfi) {
      annotations.updateHighlightStyles(activeCfi, { fill: 'rgba(59, 130, 246, 0.46)' }, true)
    }
    previousActive.current = activeCfi
  }, [active, activeCfi, find.open, find.results, rendition?.annotations, viewVersion])

  return null
}
