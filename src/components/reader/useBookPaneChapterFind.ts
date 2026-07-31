import { type Dispatch, type SetStateAction, useCallback, useEffect, useEffectEvent, useRef } from 'react'

import { type BookTab, readingOrderStartSectionIndex } from '../../models/reader'
import { isReaderShortcutTargetBlocked } from '../../reader/shortcuts'

import {
  type ChapterFindResult,
  type ChapterFindState,
  findLocationKey,
  firstVisibleFindResultIndex,
  isFindResultVisible,
  isFindShortcut,
  nearestVisibleFindResultIndex,
  type ReflowableManager,
} from './chapterFindModel'
import { useChapterFindController } from './useChapterFindController'
import { CAPTURE_EVENT_OPTIONS, useFrameEvent } from './useFrameEvent'

interface BookPaneChapterFindOptions {
  active: boolean
  activeFrameWindows: readonly Window[]
  onOpen: () => void
  rendition?: {
    manager?: ReflowableManager
  }
  tab: BookTab
  zenMode: boolean
}

export function useBookPaneChapterFind({
  active,
  activeFrameWindows,
  onOpen,
  rendition,
  tab,
  zenMode,
}: BookPaneChapterFindOptions) {
  const findScopeSectionIndex = useCallback(() => {
    const manager = rendition?.manager
    return readingOrderStartSectionIndex(
      manager?.currentReflowableSpread,
      manager?.paginationModel?.().spreadSlotOrder,
      tab.currentSection?.index,
    )
  }, [rendition?.manager, tab])

  const { close, inputRef, open, setState, state } = useChapterFindController({
    activeFrameWindows,
    findScopeSectionIndex,
    onOpen,
    tab,
  })
  const handleShortcut = useCallback(
    (event: KeyboardEvent) => {
      if (!isFindShortcut(event)) return
      if (isReaderShortcutTargetBlocked(event)) return

      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation?.()
      if (zenMode) return
      open()
    },
    [open, zenMode],
  )
  const handleShortcutEvent = useEffectEvent(handleShortcut)

  useEffect(() => {
    if (!active) return

    const onKeyDown = (event: KeyboardEvent) => {
      handleShortcutEvent(event)
    }

    document.addEventListener('keydown', onKeyDown, true)

    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [active])
  useFrameEvent(activeFrameWindows, 'keydown', handleShortcut, CAPTURE_EVENT_OPTIONS)

  return {
    close,
    inputRef,
    open,
    setState,
    state,
  }
}

interface BookPaneChapterFindResultsOptions {
  active: boolean
  paginationVersion: number
  rendition?: {
    manager?: ReflowableManager
  }
  setState: Dispatch<SetStateAction<ChapterFindState>>
  state: ChapterFindState
  tab: BookTab
}

export function useBookPaneChapterFindResults({
  active,
  paginationVersion,
  rendition,
  setState,
  state,
  tab,
}: BookPaneChapterFindResultsOptions) {
  const previousLocationKey = useRef<string | undefined>(undefined)
  const findOpen = state.open
  const findQuery = state.query
  const findSectionIndex = state.sectionIndex

  useEffect(() => {
    let cancelled = false
    const query = findQuery.trim()

    if (!active || !findOpen || !query || findSectionIndex === undefined) {
      setState((current) => ({
        ...current,
        results: [],
        activeIndex: 0,
        searching: false,
      }))
      return
    }

    const sectionIndex = findSectionIndex
    const section = tab.sections?.find((item) => item.index === sectionIndex)
    if (!section) {
      setState((current) => ({
        ...current,
        results: [],
        activeIndex: 0,
        searching: false,
      }))
      return
    }
    const currentSection = section

    setState((current) => ({ ...current, searching: true }))

    async function searchSection() {
      try {
        const matches = (
          currentSection.find(query) as Array<{
            cfi?: string
            excerpt?: string
          }>
        ).flatMap((match) => (match.cfi ? [match] : []))

        const results = await Promise.all(
          matches.map(async (match): Promise<ChapterFindResult> => {
            const cfi = match.cfi!

            return {
              cfi,
              excerpt: match.excerpt ?? '',
              pageIndex: await tab.pageIndexForCfi(sectionIndex, cfi),
            }
          }),
        )

        if (cancelled) return

        const visibleIndex = firstVisibleFindResultIndex(results, sectionIndex, rendition?.manager)

        setState((current) => ({
          ...current,
          results,
          activeIndex: visibleIndex > -1 ? visibleIndex : 0,
          searching: false,
        }))
      } catch (error) {
        console.error('Failed to search the current chapter', error)
        if (cancelled) return

        setState((current) => ({
          ...current,
          results: [],
          activeIndex: 0,
          searching: false,
        }))
      }
    }

    void searchSection()

    return () => {
      cancelled = true
    }
  }, [active, findOpen, findQuery, findSectionIndex, rendition?.manager, setState, tab])

  useEffect(() => {
    if (!state.open || !active || !state.results.length || state.sectionIndex === undefined) {
      return
    }

    const locationKey = findLocationKey(tab.paginationSnapshot?.location)
    if (locationKey === previousLocationKey.current) return
    previousLocationKey.current = locationKey

    const manager = rendition?.manager
    setState((current) => {
      const visibleIndex = nearestVisibleFindResultIndex(
        current.results,
        current.sectionIndex,
        manager,
        current.activeIndex,
      )
      if (visibleIndex < 0 || current.activeIndex === visibleIndex) {
        return current
      }

      return {
        ...current,
        activeIndex: visibleIndex,
      }
    })
  }, [state.open, active, state.results, state.sectionIndex, paginationVersion, rendition?.manager, setState, tab])

  const goToResult = useCallback(
    (index: number) => {
      if (state.sectionIndex === undefined || !state.results.length) {
        return
      }

      const count = state.results.length
      const nextIndex = ((index % count) + count) % count
      const result = state.results[nextIndex]
      if (!result) return

      setState((current) => ({
        ...current,
        activeIndex: nextIndex,
      }))

      if (!isFindResultVisible(result, state.sectionIndex, rendition?.manager)) {
        void tab.displayReflowableTarget(state.sectionIndex, result.cfi)
      }
    },
    [state.results, state.sectionIndex, rendition?.manager, setState, tab],
  )

  return {
    goToResult,
  }
}
