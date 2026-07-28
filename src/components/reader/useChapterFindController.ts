import { useCallback, useRef, useState } from 'react'

import type { BookTab } from '../../models/reader'

import { type ChapterFindState, initialChapterFind } from './ChapterFind'

function getSelectedText(windows: readonly Window[]) {
  for (const win of windows) {
    try {
      const selection = win.getSelection()
      const text = selection?.toString().replace(/\s+/g, ' ').trim()
      if (text && !selection?.isCollapsed && selection?.anchorNode?.isConnected) {
        return text
      }
    } catch (_error) {
      // The iframe may have been detached while handling a shortcut.
    }
  }
  return ''
}

interface ChapterFindControllerOptions {
  activeFrameWindows: readonly Window[]
  findScopeSectionIndex: () => number | undefined
  onOpen: () => void
  tab: BookTab
}

export function useChapterFindController({
  activeFrameWindows,
  findScopeSectionIndex,
  onOpen,
  tab,
}: ChapterFindControllerOptions) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [state, setState] = useState<ChapterFindState>(initialChapterFind)

  const focusInput = useCallback(() => {
    window.setTimeout(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    })
  }, [])

  const open = useCallback(() => {
    const sectionIndex = findScopeSectionIndex()
    const selectedText = getSelectedText(activeFrameWindows)

    onOpen()
    activeFrameWindows.forEach((frame) => frame.getSelection()?.removeAllRanges())
    tab.annotationRange = undefined
    tab.annotationCfi = undefined
    setState((current) => ({
      ...current,
      open: true,
      query: selectedText || current.query,
      sectionIndex,
      activeIndex: 0,
    }))
    focusInput()
  }, [activeFrameWindows, findScopeSectionIndex, focusInput, onOpen, tab])

  const close = useCallback(() => {
    setState((current) => ({
      ...current,
      open: false,
      results: [],
      activeIndex: 0,
      searching: false,
    }))
  }, [])

  return {
    close,
    inputRef,
    open,
    setState,
    state,
  }
}
