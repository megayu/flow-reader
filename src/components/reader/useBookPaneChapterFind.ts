import { type Dispatch, type SetStateAction, useCallback, useEffect, useEffectEvent, useRef } from 'react'

import type { Rendition } from '@flow/epub-engine/rendition'

import { type BookTab, readingOrderStartSectionIndex } from '../../models/reader'
import { isReaderShortcutTargetBlocked } from '../../reader/shortcuts'

import {
  type ChapterFindState,
  findLocationKey,
  firstVisibleFindResultIndex,
  isFindResultVisible,
  isFindShortcut,
  nearestVisibleFindResultIndex,
} from './chapterFindModel'
import { useChapterFindController } from './useChapterFindController'
import { CAPTURE_EVENT_OPTIONS, useFrameEvent } from './useFrameEvent'

interface BookPaneChapterFindOptions {
  active: boolean
  activeFrameWindows: readonly Window[]
  onOpen: () => void
  rendition?: Pick<Rendition, 'session'>
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
    const session = rendition?.session
    return readingOrderStartSectionIndex(
      session?.currentSpread,
      session?.paginationModel().spreadSlotOrder,
      tab.currentSection?.index,
    )
  }, [rendition?.session, tab])

  const { close, inputRef, open, setState, state } = useChapterFindController({
    activeFrameWindows,
    findScopeSectionIndex,
    onOpen,
    tab,
  })
  const handleShortcut = useCallback(
    (event: KeyboardEvent) => {
      if (!active) return
      if (!isFindShortcut(event)) return
      // The find bar must not block its own shortcut when focus returns to the book.
      const findBar = inputRef.current?.closest('[data-flow-chapter-find-bar]')
      if (isReaderShortcutTargetBlocked(event, findBar)) return

      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation?.()
      if (zenMode) return
      open()
    },
    [active, inputRef, open, zenMode],
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
  viewVersion: number
  rendition?: Pick<Rendition, 'session'>
  setState: Dispatch<SetStateAction<ChapterFindState>>
  state: ChapterFindState
  tab: BookTab
}

export function useBookPaneChapterFindResults({
  active,
  paginationVersion,
  viewVersion,
  rendition,
  setState,
  state,
  tab,
}: BookPaneChapterFindResultsOptions) {
  const previousLocationKey = useRef<string | undefined>(undefined)
  const findOpen = state.open
  const findQuery = state.query
  const findSectionIndex = state.sectionIndex
  const section = tab.sections?.find((item) => item.index === findSectionIndex)
  const session = rendition?.session
  const layoutKey = section ? session?.sectionLayoutKey(section) : undefined
  const scopeIndex = readingOrderStartSectionIndex(
    session?.currentSpread,
    session?.paginationModel().spreadSlotOrder,
    tab.currentSection?.index,
  )

  useEffect(() => {
    const query = findQuery.trim()
    previousLocationKey.current = undefined

    if (findOpen && scopeIndex !== undefined && scopeIndex !== findSectionIndex) {
      setState((current) => ({ ...current, open: false, results: [], activeIndex: 0, searching: false }))
      return
    }

    if (!active || !findOpen || !query || !section || !session) {
      setState((current) => ({
        ...current,
        results: [],
        activeIndex: 0,
        searching: false,
      }))
      return
    }

    const controller = new AbortController()
    setState((current) => ({ ...current, results: [], searching: true }))

    void session
      .findInDisplayedSection(section, query, controller.signal)
      .then((results) => {
        if (controller.signal.aborted) return

        const visibleIndex = firstVisibleFindResultIndex(results, section.index, session)

        setState((current) =>
          current.query !== findQuery || !current.open
            ? current
            : {
                ...current,
                results,
                activeIndex: visibleIndex > -1 ? visibleIndex : 0,
                searching: false,
              },
        )
      })
      .catch((error) => {
        if (controller.signal.aborted) return
        console.error('Failed to search the current chapter', error)

        setState((current) => ({
          ...current,
          results: [],
          activeIndex: 0,
          searching: false,
        }))
      })

    return () => {
      controller.abort()
    }
  }, [active, findOpen, findQuery, findSectionIndex, layoutKey, session, scopeIndex, section, setState, viewVersion])

  useEffect(() => {
    if (!state.open || !active || !state.results.length || state.sectionIndex === undefined) {
      return
    }

    const locationKey = findLocationKey(tab.paginationSnapshot?.location)
    if (locationKey === previousLocationKey.current) return
    previousLocationKey.current = locationKey

    setState((current) => {
      const visibleIndex = nearestVisibleFindResultIndex(
        current.results,
        current.sectionIndex,
        session,
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
  }, [state.open, active, state.results, state.sectionIndex, paginationVersion, session, setState, tab])

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

      if (!isFindResultVisible(result, state.sectionIndex, session)) {
        void tab.displayReflowableTarget(state.sectionIndex, result.cfi)
      }
    },
    [state.results, state.sectionIndex, session, setState, tab],
  )

  return {
    goToResult,
  }
}
