import clsx from 'clsx'
import {
  BookOpenIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronsDownIcon,
  ChevronsUpIcon,
  ChevronUpIcon,
  PanelTopIcon,
} from 'lucide-react'
import React, {
  type ComponentProps,
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useSnapshot } from 'valtio'

import type { Contents } from '@flow/epubjs'
import { type RenditionManagerView, RenditionSpread } from '@flow/epubjs/rendition'
import { SettingsPanel } from '@/settings/SettingsPanel'
import {
  useSetSettingsDialogOpen,
  useSettingsReady,
  useSetViewMode,
  useSetZenMode,
  useSetZenTypographyOverrides,
  useViewModeValue,
  useZenModeValue,
} from '@/state'

import { getBookDisplayTitle, getBookTooltip } from '../book'
import { handleFiles } from '../file'
import { useBackground } from '../hooks/theme/useBackground'
import { useColorScheme } from '../hooks/theme/useColorScheme'
import { useAction } from '../hooks/useAction'
import { useEventListener } from '../hooks/useEventListener'
import { useTranslation } from '../hooks/useTranslation'
import { useTypography } from '../hooks/useTypography'
import { BookTab, getBookTabFrameWindows, reader, useReaderSnapshot } from '../models/reader'
import { createReaderKeyDownHandler, hasKeyboardCapturingLayer, isEditableTarget } from '../reader/shortcuts'
import { getShortcutChords } from '../shortcuts'
import { type BookRecord, db, type EpubImportProgress, type EpubImportResult } from '../storage'
import { createTypographyLayoutSignature, createTypographyStyleSignature, updateCustomStyle } from '../styles'

import { Annotations } from './Annotation'
import { BookTooltipContent } from './BookTooltipContent'
import { DropZone } from './base/DropZone'
import { ChapterFindBar, ChapterFindHighlights, ChapterFindOverlay } from './reader/ChapterFind'
import { NotePopover, type NotePopoverState } from './reader/NotePopover'
import { ReaderImagePreview } from './reader/ReaderImagePreview'
import { useBookPaneChapterFind, useBookPaneChapterFindResults } from './reader/useBookPaneChapterFind'
import { useBookPaneFrameContent } from './reader/useBookPaneFrameContent'
import { useBookPaneWheelNavigation } from './reader/useBookPaneWheelNavigation'
import { useBookRenditionLifecycle } from './reader/useBookRenditionLifecycle'
import { CAPTURE_EVENT_OPTIONS, useFrameEvent } from './reader/useFrameEvent'
import { useReaderPageGeometry } from './reader/useReaderPageGeometry'
import { ShortcutChord } from './ShortcutChord'
import { Tab } from './Tab'
import { TextSelectionMenu } from './TextSelectionMenu'

const pageComponents = [SettingsPanel]

function preventContextMenu(e: Event) {
  e.preventDefault()
}

function getFocusedBookTab() {
  return reader.focusedBookTab
}

interface ReaderGridViewProps {
  content?: React.ReactNode
  onEpubImportProgress?: (progress: EpubImportProgress) => void
  onEpubImportResult?: (result: EpubImportResult) => Set<string> | void | Promise<Set<string> | void>
}

export function ReaderGridView({ content, onEpubImportProgress, onEpubImportResult }: ReaderGridViewProps) {
  const { focusedIndex, groups } = useReaderSnapshot()
  const [action, setAction] = useAction()
  const setViewMode = useSetViewMode()
  const viewMode = useViewModeValue()
  const zenMode = useZenModeValue()
  const setZenMode = useSetZenMode()
  const setSettingsOpen = useSetSettingsDialogOpen()
  const setZenTypographyOverrides = useSetZenTypographyOverrides()
  const enterReaderMode = useCallback(() => {
    if (viewMode !== 'reader') setViewMode('reader')
  }, [setViewMode, viewMode])

  useEventListener(
    'keydown',
    createReaderKeyDownHandler(
      getFocusedBookTab,
      viewMode,
      enterReaderMode,
      zenMode,
      setZenMode,
      setZenTypographyOverrides,
      {
        action,
        setAction,
        setViewMode,
        setSettingsOpen,
      },
    ),
  )
  useEventListener('contextmenu', preventContextMenu)

  if (!groups.length) return null
  const preferredIndex = focusedIndex > -1 ? focusedIndex : 0
  const index = groups[preferredIndex] ? preferredIndex : 0
  const group = groups[index]
  if (!group) return null

  return (
    <div className="ReaderGridView relative flex h-full min-h-0">
      <ReaderGroup
        key={group.id}
        index={index}
        content={content}
        onEpubImportProgress={onEpubImportProgress}
        onEpubImportResult={onEpubImportResult}
        onEnterReaderMode={enterReaderMode}
      />
    </div>
  )
}

interface ReaderGroupProps {
  index: number
  content?: React.ReactNode
  onEpubImportProgress?: (progress: EpubImportProgress) => void
  onEpubImportResult?: (result: EpubImportResult) => Set<string> | void | Promise<Set<string> | void>
  onEnterReaderMode: () => void
}

interface TabPointerDrag {
  dragging: boolean
  pointerId: number
  sourceIndex: number
  startX: number
  startY: number
  targetIndex?: number
}

function ReaderGroup({
  index,
  content,
  onEpubImportProgress,
  onEpubImportResult,
  onEnterReaderMode,
}: ReaderGroupProps) {
  const group = reader.groups[index]!
  const { paneTabs, tabs, selectedIndex } = useSnapshot(group)
  const selectedTabId = tabs[selectedIndex]?.id
  const [backgroundClassName] = useBackground()
  const zenMode = useZenModeValue()
  const tabWheelDelta = useRef(0)
  const tabPointerDrag = useRef<TabPointerDrag | undefined>(undefined)
  const suppressTabClick = useRef(false)
  const [hoveredTabIndex, setHoveredTabIndex] = useState<number | undefined>()
  const [tabDragPreview, setTabDragPreview] = useState<{
    sourceIndex: number
    targetIndex?: number
  }>()

  const handleMouseDown = useCallback(() => {
    reader.selectGroup(index)
  }, [index])

  const handleTabWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault()
      e.stopPropagation()

      const delta = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX
      if (!delta) return

      tabWheelDelta.current += delta

      if (Math.abs(tabWheelDelta.current) < 30) return

      reader.selectGroup(index)
      group.selectAdjacentTab(tabWheelDelta.current > 0 ? 1 : -1, true)
      onEnterReaderMode()
      tabWheelDelta.current = 0
    },
    [group, index, onEnterReaderMode],
  )

  const clearTabPointerDrag = useCallback(() => {
    tabPointerDrag.current = undefined
    setTabDragPreview(undefined)
  }, [])

  const handleTabPointerDown = useCallback((event: React.PointerEvent<HTMLUListElement>) => {
    if (event.button !== 0) return
    if (!(event.target instanceof Element)) return
    if (event.target.closest('button')) return

    const tabElement = event.target.closest<HTMLElement>('[data-flow-reader-tab-index]')
    const sourceIndex = Number(tabElement?.dataset.flowReaderTabIndex ?? Number.NaN)
    if (!Number.isInteger(sourceIndex)) return

    tabPointerDrag.current = {
      dragging: false,
      pointerId: event.pointerId,
      sourceIndex,
      startX: event.clientX,
      startY: event.clientY,
    }
  }, [])

  const handleTabPointerMove = useCallback((event: React.PointerEvent<HTMLUListElement>) => {
    const drag = tabPointerDrag.current
    if (!drag || drag.pointerId !== event.pointerId) return

    const list = event.currentTarget
    const listRect = list.getBoundingClientRect()
    const inside =
      event.clientX >= listRect.left &&
      event.clientX <= listRect.right &&
      event.clientY >= listRect.top &&
      event.clientY <= listRect.bottom
    const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY)

    if (!drag.dragging) {
      if (!inside || distance < 5) return
      drag.dragging = true
      list.setPointerCapture(event.pointerId)
    }

    event.preventDefault()
    let targetIndex: number | undefined
    if (inside) {
      const tabElements = Array.from(list.querySelectorAll<HTMLElement>('[data-flow-reader-tab-index]'))
      targetIndex = Math.max(0, tabElements.length - 1)
      for (const tabElement of tabElements) {
        const index = Number(tabElement.dataset.flowReaderTabIndex)
        const rect = tabElement.getBoundingClientRect()
        if (event.clientX < rect.left + rect.width / 2) {
          targetIndex = index
          break
        }
      }
    }

    if (drag.targetIndex === targetIndex) return
    drag.targetIndex = targetIndex
    setTabDragPreview({ sourceIndex: drag.sourceIndex, targetIndex })
  }, [])

  const handleTabPointerUp = useCallback(
    (event: React.PointerEvent<HTMLUListElement>) => {
      const drag = tabPointerDrag.current
      if (!drag || drag.pointerId !== event.pointerId) return

      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }

      if (drag.dragging) {
        suppressTabClick.current = true
        window.setTimeout(() => {
          suppressTabClick.current = false
        }, 0)

        const rect = event.currentTarget.getBoundingClientRect()
        const releasedInside =
          event.clientX >= rect.left &&
          event.clientX <= rect.right &&
          event.clientY >= rect.top &&
          event.clientY <= rect.bottom
        if (releasedInside && drag.targetIndex !== undefined) {
          group.moveTab(drag.sourceIndex, drag.targetIndex)
        }
      }

      clearTabPointerDrag()
    },
    [clearTabPointerDrag, group],
  )

  const handleTabPointerCancel = useCallback(
    (event: React.PointerEvent<HTMLUListElement>) => {
      if (tabPointerDrag.current?.pointerId !== event.pointerId) return
      clearTabPointerDrag()
    },
    [clearTabPointerDrag],
  )

  const handleTabSelect = useCallback(
    (tabIndex: number) => {
      if (suppressTabClick.current) return
      group.selectTab(tabIndex)
      onEnterReaderMode()
    },
    [group, onEnterReaderMode],
  )

  return (
    <div
      className="ReaderGroup flex h-full min-h-0 flex-1 flex-col overflow-hidden focus:outline-none"
      onMouseDown={handleMouseDown}
    >
      <Tab.List
        className={clsx('flex', zenMode && 'hidden!')}
        onWheel={handleTabWheel}
        onPointerDown={handleTabPointerDown}
        onPointerMove={handleTabPointerMove}
        onPointerUp={handleTabPointerUp}
        onPointerCancel={handleTabPointerCancel}
      >
        {tabs.map((tab, i) => {
          const selected = i === selectedIndex
          const focused = selected
          return (
            <ReaderTabItem
              groupIndex={index}
              index={i}
              key={tab.id}
              focused={focused}
              selected={selected}
              showSeparator={
                !selected &&
                i + 1 < tabs.length &&
                i + 1 !== selectedIndex &&
                hoveredTabIndex !== i &&
                hoveredTabIndex !== i + 1
              }
              tab={tab}
              onHoverChange={setHoveredTabIndex}
              onSelect={handleTabSelect}
              dragging={tabDragPreview?.sourceIndex === i}
              dropIndicator={
                tabDragPreview?.targetIndex === i && tabDragPreview.sourceIndex !== i
                  ? tabDragPreview.sourceIndex < i
                    ? 'after'
                    : 'before'
                  : undefined
              }
            />
          )
        })}
      </Tab.List>

      <div className="relative min-h-0 flex-1">
        <DropZone
          className={clsx('h-full min-h-0', Boolean(content) && 'pointer-events-none opacity-0')}
          onDrop={async (e) => {
            // read `e.dataTransfer` first to avoid get empty value after `await`
            const files = e.dataTransfer.files
            let tabs = []

            if (files.length) {
              tabs = await handleFiles(files, {
                onImportProgress: onEpubImportProgress,
                onImportResult: onEpubImportResult,
              })
            } else {
              const text = e.dataTransfer.getData('text/plain')
              const tabParam = pageComponents.find((p) => p.displayName === text) ?? (await db.books.get(text))
              if (tabParam) tabs.push(tabParam)
            }

            if (tabs.length) {
              tabs.forEach((t) => reader.addTab(t, index))
              onEnterReaderMode()
            }
          }}
        >
          {paneTabs.map((paneTab, paneIndex) => {
            const tab = group.paneTabs[paneIndex]!
            const active = paneTab.id === selectedTabId

            return (
              <PaneContainer active={active} key={paneTab.id}>
                {tab instanceof BookTab ? (
                  <BookPane active={active} tab={tab} onMouseDown={handleMouseDown} />
                ) : (
                  <tab.Component />
                )}
              </PaneContainer>
            )
          })}
        </DropZone>
        {content && (
          <div className={clsx('absolute inset-0 z-10 min-h-0 overflow-hidden', backgroundClassName)}>{content}</div>
        )}
      </div>
    </div>
  )
}

function getReaderTabLabel(tab: BookTab | { title: string }, t: (key: string) => string) {
  return tab instanceof BookTab ? getBookDisplayTitle(tab.book) : t(`${tab.title}.title`)
}

interface ReaderTabItemProps {
  dragging: boolean
  dropIndicator?: 'before' | 'after'
  focused: boolean
  groupIndex: number
  index: number
  onHoverChange: React.Dispatch<React.SetStateAction<number | undefined>>
  onSelect: (index: number) => void
  selected: boolean
  showSeparator: boolean
  tab: BookTab | { id: string; title: string }
}

const ReaderTabItem = React.memo(function ReaderTabItem({
  dragging,
  dropIndicator,
  focused,
  groupIndex,
  index,
  onHoverChange,
  onSelect,
  selected,
  showSeparator,
  tab,
}: ReaderTabItemProps) {
  const t = useTranslation()
  const label = getReaderTabLabel(tab, t)
  const handleMouseEnter = useCallback(() => {
    onHoverChange(index)
  }, [index, onHoverChange])
  const handleMouseLeave = useCallback(() => {
    onHoverChange((current) => (current === index ? undefined : current))
  }, [index, onHoverChange])
  const handleClick = useCallback(() => {
    onSelect(index)
  }, [index, onSelect])
  const handleDelete = useCallback(() => {
    reader.removeTab(index, groupIndex)
  }, [groupIndex, index])

  return (
    <Tab
      className={clsx(dragging && 'opacity-50')}
      data-flow-reader-tab-index={index}
      draggable={false}
      dropIndicator={dropIndicator}
      selected={selected}
      focused={focused}
      showSeparator={showSeparator}
      title={getReaderTabTooltip(tab, t)}
      tooltipContent={getReaderTabTooltipContent(tab)}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onClick={handleClick}
      onDelete={handleDelete}
      Icon={getReaderTabIcon(tab)}
    >
      {label}
    </Tab>
  )
})

function getReaderTabTooltip(tab: BookTab | { title: string }, t: (key: string) => string) {
  return tab instanceof BookTab ? getBookTooltip(tab.book) : getReaderTabLabel(tab, t)
}

function getReaderTabTooltipContent(tab: BookTab | { title: string }) {
  if (!(tab instanceof BookTab)) return

  const book = tab.book as unknown as BookRecord
  return <BookTooltipContent book={book} />
}

type TemporaryBookOpenIconProps = React.ComponentProps<typeof BookOpenIcon> & {
  ref?: React.Ref<SVGSVGElement>
}

const TemporaryBookOpenIcon = function TemporaryBookOpenIcon({ ref, ...props }: TemporaryBookOpenIconProps) {
  return <BookOpenIcon {...props} ref={ref} strokeDasharray="1 2.5" />
} as typeof BookOpenIcon

function getReaderTabIcon(tab: BookTab | { title: string }) {
  if (!(tab instanceof BookTab)) return PanelTopIcon

  return tab.book.scope === 'external' ? TemporaryBookOpenIcon : BookOpenIcon
}

interface PaneContainerProps {
  active: boolean
  children?: React.ReactNode
}
const PaneContainer: React.FC<PaneContainerProps> = React.memo(function PaneContainer({ active, children }) {
  return (
    <div
      aria-hidden={!active}
      data-flow-reader-pane
      className={clsx(
        'absolute inset-0 h-full overflow-hidden',
        active ? 'visible z-10 opacity-100' : 'pointer-events-none invisible z-0 opacity-0',
      )}
    >
      {children}
    </div>
  )
})

interface BookPaneProps {
  active: boolean
  tab: BookTab
  onMouseDown: () => void
}

const BookPane: React.FC<BookPaneProps> = React.memo(function BookPane({ active, tab, onMouseDown }) {
  const ref = useRef<HTMLDivElement>(null)
  const [notePopover, setNotePopover] = useState<NotePopoverState>()
  const typography = useTypography(tab)
  const pageAppearance = typography.pageAppearance
  const typographyStyleSignature = useMemo(() => createTypographyStyleSignature(typography), [typography])
  const settingsReady = useSettingsReady()
  const { dark } = useColorScheme()
  const [background] = useBackground()

  const { isScrolledDocument, rendition, rendered, turning, paginationVersion, viewVersion } = useSnapshot(tab)
  const currentSpread = isScrolledDocument ? RenditionSpread.None : (typography.spread ?? RenditionSpread.Auto)
  const typographyLayoutSignature = useMemo(
    () =>
      createTypographyLayoutSignature({
        ...typography,
        spread: currentSpread,
      }),
    [currentSpread, typography],
  )
  const frameWindows = useMemo(() => [...getBookTabFrameWindows(tab)], [tab, viewVersion])
  const activeFrameWindows = useMemo(() => (active ? frameWindows : []), [active, frameWindows])

  useLayoutEffect(() => {
    return () => {
      tab.setActive(false)
    }
  }, [tab])

  const viewMode = useViewModeValue()
  const setViewMode = useSetViewMode()
  const zenMode = useZenModeValue()
  const setZenMode = useSetZenMode()
  const setZenTypographyOverrides = useSetZenTypographyOverrides()
  const enterReaderMode = useCallback(() => {
    if (viewMode !== 'reader') setViewMode('reader')
  }, [setViewMode, viewMode])
  const [action, setAction] = useAction()
  const setSettingsOpen = useSetSettingsDialogOpen()

  const closeNotePopover = useCallback(() => setNotePopover(undefined), [])
  const {
    close: closeChapterFind,
    inputRef: chapterFindInputRef,
    open: openChapterFind,
    setState: setChapterFind,
    state: chapterFind,
  } = useBookPaneChapterFind({
    active,
    activeFrameWindows,
    onOpen: closeNotePopover,
    rendition,
    tab,
    zenMode,
  })

  useEffect(() => {
    if (!zenMode) return

    closeChapterFind()
    setNotePopover(undefined)
    if (tab.annotationRange) tab.annotationRange = undefined
    if (tab.annotationCfi) tab.annotationCfi = undefined
  }, [closeChapterFind, tab, zenMode])

  const handleReturnMouseButton = useCallback(
    (e: MouseEvent) => {
      if (zenMode) return
      if (e.button !== 3) return
      if (reader.focusedBookTab !== tab) return
      if (!tab.locationToReturn) return
      if (isEditableTarget(e.target) || hasKeyboardCapturingLayer(e.target)) {
        return
      }

      e.preventDefault()
      e.stopPropagation()
      e.stopImmediatePropagation?.()
      tab.returnToPreviousLocation()
    },
    [tab, zenMode],
  )
  const handleReturnMouseButtonEvent = useEffectEvent(handleReturnMouseButton)

  useEffect(() => {
    if (!active) return

    const onMouseButton = (event: MouseEvent) => {
      handleReturnMouseButtonEvent(event)
    }

    document.addEventListener('mousedown', onMouseButton, true)
    document.addEventListener('auxclick', onMouseButton, true)

    return () => {
      document.removeEventListener('mousedown', onMouseButton, true)
      document.removeEventListener('auxclick', onMouseButton, true)
    }
  }, [active])
  useFrameEvent(activeFrameWindows, 'mousedown', handleReturnMouseButton, CAPTURE_EVENT_OPTIONS)
  useFrameEvent(activeFrameWindows, 'auxclick', handleReturnMouseButton, CAPTURE_EVENT_OPTIONS)

  const applyCustomStyle = useCallback(
    (contents?: Contents, view?: RenditionManagerView) => {
      if (contents) {
        updateCustomStyle(contents, typography, tab.bodyTextCache, view, rendition?.manager?.layout?.name)
        return
      }

      rendition?.getContents().forEach((contents) => {
        updateCustomStyle(contents, typography, tab.bodyTextCache, undefined, rendition.manager?.layout?.name)
      })
    },
    [rendition, tab.bodyTextCache, typography],
  )

  useBookRenditionLifecycle({
    active,
    settingsReady,
    tab,
    rendition,
    currentSpread,
    typographyLayoutSignature,
    typographyStyleSignature,
    applyCustomStyle,
    containerRef: ref,
  })

  useReaderPageGeometry({
    active,
    containerRef: ref,
    paginationVersion,
    rendered,
    rendition,
  })

  const { goToResult: goToFindResult } = useBookPaneChapterFindResults({
    active,
    paginationVersion,
    rendition,
    setState: setChapterFind,
    state: chapterFind,
    tab,
  })

  useEffect(() => {
    if (dark === undefined) return
    // set `!important` when in dark mode
    rendition?.themes.override('color', dark ? '#bfc8ca' : '#3f484a', dark)
  }, [rendition, dark])

  const { closeImagePreview, imagePreview } = useBookPaneFrameContent({
    active,
    activeFrameWindows,
    closeChapterFind,
    containerRef: ref,
    frameWindows,
    onMouseDown,
    rendition,
    setNotePopover,
    tab,
    typography,
    zenMode,
  })

  useBookPaneWheelNavigation({
    active,
    isScrolledDocument,
    rendered,
    rendition,
    tab,
  })

  const handleFrameKeyDown = useMemo(
    () =>
      createReaderKeyDownHandler(tab, viewMode, enterReaderMode, zenMode, setZenMode, setZenTypographyOverrides, {
        action,
        setAction,
        setViewMode,
        setSettingsOpen,
      }),
    [
      action,
      enterReaderMode,
      setAction,
      setZenMode,
      setZenTypographyOverrides,
      setSettingsOpen,
      setViewMode,
      tab,
      viewMode,
      zenMode,
    ],
  )
  useFrameEvent(activeFrameWindows, 'keydown', handleFrameKeyDown)

  return (
    <div className="flex h-full flex-col" data-flow-page-appearance={pageAppearance}>
      <ReaderImagePreview
        openKey={!zenMode ? imagePreview?.key : undefined}
        src={!zenMode ? imagePreview?.src : undefined}
        onClose={closeImagePreview}
      />
      {!zenMode && <ReaderPaneHeader tab={tab} />}
      {!zenMode && chapterFind.open && active && (
        <ChapterFindOverlay anchorRef={ref}>
          <ChapterFindBar
            find={chapterFind}
            inputRef={chapterFindInputRef}
            onChange={(query) =>
              setChapterFind((state) => ({
                ...state,
                query,
                activeIndex: 0,
              }))
            }
            onClose={closeChapterFind}
            onNext={() => goToFindResult(chapterFind.activeIndex + 1)}
            onPrevious={() => goToFindResult(chapterFind.activeIndex - 1)}
          />
        </ChapterFindOverlay>
      )}
      <div
        ref={ref}
        data-flow-reader-content
        className="relative h-0 flex-1"
        // `color-scheme: dark` will make iframe background white
        style={{ colorScheme: 'auto' }}
      >
        {pageAppearance && <ReaderPageDecoration />}
        <div
          data-flow-reader-loading-cover
          className={clsx(
            'absolute inset-0',
            // do not cover `sash`
            'z-20',
            rendered && !turning && 'hidden',
            background,
          )}
        />
        {!zenMode && active && <TextSelectionMenu tab={tab} onChapterFind={openChapterFind} />}
        <Annotations active={active} tab={tab} />
        {!zenMode && <NotePopover popover={notePopover} onClose={() => setNotePopover(undefined)} />}
        {!zenMode && <ChapterFindHighlights active={active} find={chapterFind} tab={tab} />}
        {!zenMode && active && <ReaderEdgeNavigation tab={tab} />}
      </div>
      <ReaderPaneFooter tab={tab} />
    </div>
  )
})

const ReaderPageDecoration: React.FC = () => {
  return (
    <div aria-hidden="true" data-flow-reader-page-decoration className="pointer-events-none absolute inset-0 z-10">
      <div data-flow-reader-page-frame="start" />
      <div data-flow-reader-page-frame="end" />
      <div data-flow-reader-page-seam />
    </div>
  )
}

interface ReaderEdgeNavigationProps {
  tab: BookTab
}

const ReaderEdgeNavigation: React.FC<ReaderEdgeNavigationProps> = ({ tab }) => {
  const t = useTranslation('shortcuts')
  const items = [
    {
      label: t('previous_chapter'),
      Icon: ChevronsUpIcon,
      onClick: () => void tab.prevSection(),
    },
    {
      label: t('previous_page'),
      Icon: ChevronUpIcon,
      onClick: () => void tab.prev(),
    },
    {
      label: t('next_page'),
      Icon: ChevronDownIcon,
      onClick: () => void tab.next(),
    },
    {
      label: t('next_chapter'),
      Icon: ChevronsDownIcon,
      onClick: () => void tab.nextSection(),
    },
  ] as const

  return (
    <div
      data-flow-reader-edge-nav
      className="group absolute top-1/2 right-0 z-30 flex w-6 -translate-y-1/2"
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <div
        data-flow-reader-edge-nav-panel
        className="text-foreground ring-foreground/10 pointer-events-none flex w-full flex-col overflow-hidden rounded-l-lg bg-black/10 opacity-0 shadow-sm ring-1 shadow-black/10 backdrop-blur-md backdrop-saturate-150 ring-inset group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100 dark:bg-white/10"
      >
        {items.map(({ label, Icon, onClick }) => (
          <button
            key={label}
            type="button"
            aria-label={label}
            className="text-muted-foreground hover:text-foreground focus-visible:ring-ring flex h-9 w-full cursor-pointer items-center justify-center border-0 bg-transparent outline-none hover:bg-(--flow-bg-control-hover) focus-visible:ring-2 focus-visible:ring-inset"
            onClick={onClick}
          >
            <Icon className="size-4.5" />
          </button>
        ))}
      </div>
    </div>
  )
}

interface ReaderPaneHeaderProps {
  tab: BookTab
}
const ReaderPaneHeader: React.FC<ReaderPaneHeaderProps> = ({ tab }) => {
  const { paginationSnapshot } = useSnapshot(tab)
  const navPath = paginationSnapshot?.headerPath ?? []

  return (
    <Bar data-flow-reader-header>
      <div className="scroll-h flex">
        {navPath.map((item, i) => (
          <span key={item.id ?? item.href ?? item.label} className="flex shrink-0 items-center">
            {item.label}
            {i !== navPath.length - 1 && <ChevronRightIcon className="size-5" />}
          </span>
        ))}
      </div>
    </Bar>
  )
}

interface FooterProps {
  tab: BookTab
}
const ReaderPaneFooter: React.FC<FooterProps> = ({ tab }) => {
  const { locationsToReturn, paginationSnapshot } = useSnapshot(tab)
  const t = useTranslation('reader')
  const locationToReturn = locationsToReturn[locationsToReturn.length - 1]
  const location = paginationSnapshot?.location
  const divisor = paginationSnapshot?.spreadDivisor ?? 1
  const spread = divisor > 1
  const percentage =
    typeof paginationSnapshot?.percentage === 'number' ? `${(paginationSnapshot.percentage * 100).toFixed(2)}%` : ''
  const startDisplayed = location?.start.displayed
  const endDisplayed = location?.end.displayed
  const rightFirst = paginationSnapshot?.spreadSlotOrder === 'right-first'
  const rightDisplayed =
    startDisplayed?.slot === 'right' ? startDisplayed : endDisplayed?.slot === 'right' ? endDisplayed : undefined
  const leftDisplayed =
    startDisplayed?.slot === 'left' ? startDisplayed : endDisplayed?.slot === 'left' ? endDisplayed : undefined
  const singleVisiblePageOnRight = spread && !!startDisplayed && startDisplayed.slot === 'right'
  const hasTwoVisiblePages =
    !!location &&
    (location.start.href !== location.end.href || location.start.displayed.page !== location.end.displayed.page)
  const returnStartShortcut = getShortcutChords('returnStart')[0]
  const returnPreviousShortcut = getShortcutChords('returnPrevious')[0]
  const dismissReturnShortcut = getShortcutChords('dismissReturn')[0]

  return (
    <div data-flow-reader-footer>
      {locationToReturn ? (
        <Bar>
          <div className="flex min-w-0 items-center gap-2">
            <button
              type="button"
              className={returnActionClass}
              aria-label={t('return_to_start')}
              onClick={() => {
                tab.returnToFirstLocation()
              }}
            >
              <span>{t('return_to_start')}</span>
              {returnStartShortcut && <ShortcutChord compact shortcut={returnStartShortcut} />}
            </button>
            <button
              type="button"
              className={clsx(returnActionClass, 'truncate')}
              aria-label={t('return_to_previous')}
              onClick={() => {
                tab.returnToPreviousLocation()
              }}
            >
              <span>{t('return_to_previous')}</span>
              {returnPreviousShortcut && <ShortcutChord compact shortcut={returnPreviousShortcut} />}
            </button>
          </div>
          <button
            type="button"
            className={returnActionClass}
            aria-label={t('dismiss_return')}
            onClick={() => {
              tab.hidePrevLocation()
            }}
          >
            <span>{t('dismiss_return')}</span>
            {dismissReturnShortcut && <ShortcutChord compact shortcut={dismissReturnShortcut} />}
          </button>
        </Bar>
      ) : spread ? (
        <div className="text-muted-foreground grid h-6 grid-cols-2 items-center px-2 text-center text-base">
          {rightFirst ? (
            <>
              <div>{leftDisplayed && formatFooterPage(leftDisplayed, percentage)}</div>
              <div>{rightDisplayed && formatFooterPage(rightDisplayed, leftDisplayed ? '' : percentage)}</div>
            </>
          ) : (
            <>
              <div>
                {!singleVisiblePageOnRight &&
                  startDisplayed &&
                  formatFooterPage(startDisplayed, hasTwoVisiblePages ? '' : percentage)}
              </div>
              <div>
                {singleVisiblePageOnRight
                  ? formatFooterPage(startDisplayed, percentage)
                  : hasTwoVisiblePages && endDisplayed && formatFooterPage(endDisplayed, percentage)}
              </div>
            </>
          )}
        </div>
      ) : (
        <div className="text-muted-foreground flex h-6 items-center justify-center px-2 text-base">
          {startDisplayed && formatFooterPage(startDisplayed, percentage)}
        </div>
      )}
    </div>
  )
}

const returnActionClass = 'inline-flex items-center gap-1.5 rounded px-1 hover:bg-muted hover:text-foreground'

function formatFooterPage(displayed: { page: number; total: number }, percentage?: string) {
  return `${displayed.page} · ${displayed.total}${percentage ? ` (${percentage})` : ''}`
}

interface LineProps extends ComponentProps<'div'> {}
const Bar: React.FC<LineProps> = ({ className, ...props }) => {
  return (
    <div
      className={clsx('text-muted-foreground flex h-6 items-center justify-between gap-2 px-2 text-base', className)}
      {...props}
    ></div>
  )
}
