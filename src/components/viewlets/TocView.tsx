import clsx from 'clsx'
import { FoldVerticalIcon, LocateFixedIcon, UnfoldVerticalIcon } from 'lucide-react'
import { memo, useCallback, useEffect, useMemo, useRef } from 'react'
import { useSnapshot } from 'valtio'

import { compareBookDisplayTitle, getBookDisplayTitle, getBookTooltip } from '@/book'
import { useLibrary } from '@/hooks/useLibrary'
import { LIST_ITEM_SIZE, useList } from '@/hooks/useList'
import { useTranslation } from '@/hooks/useTranslation'
import { type BookTab, completeTabOpen, type INavItem, reader, useReaderSnapshot } from '@/models/reader'
import { sameHref } from '@/noteLinks'
import { getTocDescendantCounts } from '@/reader/tocCounts'
import { flattenToc, getTocStickyRows, tocStickyRowLimit } from '@/reader/tocLayout'
import { useAppStore, useSetViewMode, useShowLibraryInTocValue } from '@/state'
import { backgroundClassNames } from '@/styles/theme'

import { AppTooltip } from '../AppTooltip'
import { readerPageTooltipContentStyle } from '../appTooltipStyles'
import { BookTooltipContent } from '../BookTooltipContent'
import { Pane, PaneView, type PaneViewProps } from '../base/PaneView'
import { StateLayer } from '../base/StateLayer'
import { EMPTY_ROW_LABEL, Row } from '../Row'

export const TocView: React.FC<PaneViewProps> = (props) => {
  const active = props.active ?? true
  const showLibrary = useShowLibraryInTocValue()

  return (
    <PaneView {...props}>
      {active && (
        <>
          {showLibrary && <LibraryPane active={active} />}
          <TocPane active={active} />
        </>
      )}
    </PaneView>
  )
}

interface ActivePaneProps {
  active: boolean
}

const LibraryPane: React.FC<ActivePaneProps> = ({ active }) => {
  const books = useLibrary()
  const { focusedBookTab, tabs } = useReaderSnapshot()
  const setViewMode = useSetViewMode()
  const sortedBooks = useMemo(() => books?.slice().sort(compareBookDisplayTitle) ?? [], [books])
  const { outerRef, items, scrollbar, scrollToItem, totalSize } = useList(sortedBooks)
  const openedBookIds = useMemo(() => new Set(tabs.map((tab) => tab.book.id)), [tabs])
  const currentBookId = focusedBookTab?.book.id
  const currentIndex = useMemo(
    () => sortedBooks.findIndex((book) => book.id === currentBookId),
    [currentBookId, sortedBooks],
  )
  const t = useTranslation()

  useEffect(() => {
    if (!active) return
    if (!currentBookId || currentIndex < 0) return

    scrollToItem({ index: currentIndex, align: 'auto' })
  }, [active, currentBookId, currentIndex, scrollToItem])

  return (
    <Pane
      ref={outerRef}
      headline={t('library.title')}
      minSize={120}
      overlayScroll
      preferredSize={220}
      scrollbar={{ ...scrollbar, scrollRef: outerRef }}
      stateKey="libraryToc"
    >
      <div className="relative" style={{ height: totalSize }}>
        {items.map(({ index, start, size }) => {
          const book = sortedBooks[index]
          if (!book) return null

          const displayTitle = getBookDisplayTitle(book)
          const tooltip = getBookTooltip(book)
          const opened = openedBookIds.has(book.id)
          const active = book.id === currentBookId

          const bookButton = (
            <button
              type="button"
              className={clsx(
                'group/library-row focus:ring-ring relative flex w-full items-center truncate py-0 pr-3 pl-5 text-left leading-none outline-none focus:ring-1 focus:ring-inset',
                opened && !active && 'text-foreground/85 bg-(--flow-bg-control)',
                active && clsx(backgroundClassNames.rowActiveClassName, 'text-foreground'),
              )}
              style={{
                height: LIST_ITEM_SIZE,
              }}
              aria-label={tooltip}
              aria-current={active ? 'true' : undefined}
              draggable
              onClick={() => {
                completeTabOpen(reader.openBookFromLibrary(book.id), () => setViewMode('reader'))
              }}
              onDragStart={(e) => {
                e.dataTransfer.setData('text/plain', book.id)
              }}
            >
              <StateLayer
                className={clsx(
                  'transition-colors',
                  active
                    ? 'group-hover/library-row:bg-(--flow-bg-active-hover)'
                    : 'group-hover/library-row:bg-(--flow-bg-control-hover)',
                )}
              />
              {(opened || active) && (
                <span
                  className={clsx(
                    'absolute inset-y-1 left-1 w-0.5 rounded-full',
                    active ? 'w-1 bg-(--flow-accent)' : 'bg-(--flow-accent-border)',
                  )}
                />
              )}
              <span className="relative z-10 flex h-full min-w-0 flex-1 items-center">
                <span className="block min-w-0 truncate" style={{ lineHeight: `${LIST_ITEM_SIZE}px` }}>
                  {displayTitle}
                </span>
              </span>
            </button>
          )

          return (
            <div
              key={book.id}
              className="absolute top-0 right-0 left-0"
              style={{
                height: size,
                transform: `translateY(${start}px)`,
              }}
            >
              <AppTooltip
                content={<BookTooltipContent book={book} />}
                contentStyle={readerPageTooltipContentStyle}
                label={tooltip}
              >
                {bookButton}
              </AppTooltip>
            </div>
          )
        })}
      </div>
    </Pane>
  )
}

const TocPane: React.FC<ActivePaneProps> = ({ active }) => {
  const focusedBookTab = useFocusedBookTabReference()

  if (!focusedBookTab) return <EmptyTocPane />

  return <BookTocPane active={active} tab={focusedBookTab} />
}

function useFocusedBookTabReference() {
  const readerSnapshot = useSnapshot(reader)
  const selectedTabId = readerSnapshot.tabs[readerSnapshot.selectedIndex]?.id

  void selectedTabId
  return reader.focusedBookTab
}

const EmptyTocPane: React.FC = () => {
  const t = useTranslation()

  return <Pane headline={t('toc.title')} overlayScroll stateKey="readerToc" />
}

interface BookTocPaneProps {
  active: boolean
  tab: BookTab
}

const BookTocPane: React.FC<BookTocPaneProps> = ({ active, tab }) => {
  const t = useTranslation()
  const tabSnapshot = useSnapshot(tab)
  const toc = tab.nav?.toc as INavItem[] | undefined
  const showChapterCount = useAppStore((state) => state.settings.showTocChapterCount === true)
  const chapterCounts = showChapterCount && toc ? getTocDescendantCounts(toc) : undefined
  const tocVersion = tabSnapshot.tocVersion
  const rows = useMemo(() => {
    void tocVersion
    return flattenToc(toc)
  }, [toc, tocVersion])
  const { outerRef, items, scrollbar, scrollToItem, totalSize } = useList(rows)
  const stickyRows = getTocStickyRows(rows, scrollbar.scrollTop, scrollbar.viewportHeight, LIST_ITEM_SIZE)
  const stickyIndices = new Set(stickyRows.map(({ index }) => index))
  const lastSticky = stickyRows.at(-1)
  const stickyHeight = lastSticky ? lastSticky.top + LIST_ITEM_SIZE : 0
  const expanded = toc?.some((r) => r.expanded)
  const currentNavItem = tabSnapshot.currentNavItem
  const currentKey = tocItemIdentity(currentNavItem)
  const currentIndex = useMemo(
    () => rows.findIndex(({ item }) => tocItemIdentity(item) === currentKey),
    [currentKey, rows],
  )
  const lastScrolledKey = useRef<string | undefined>(undefined)
  const explicitNavigation = useRef<{ tab: BookTab; pending: boolean; settledKey?: string } | undefined>(undefined)
  const scrollToTocItem = useCallback(
    (index: number, align: 'auto' | 'start' = 'auto') => {
      const depth = rows[index]?.depth ?? 1
      const limit = tocStickyRowLimit(outerRef.current?.clientHeight ?? 0, LIST_ITEM_SIZE)
      scrollToItem({ index, align, paddingTop: Math.min(depth - 1, limit) * LIST_ITEM_SIZE })
    },
    [outerRef, rows, scrollToItem],
  )
  const activateStickyRow = useCallback(
    (item: INavItem, navigate: () => Promise<unknown>) => {
      const index = rows.findIndex((row) => row.item === item)
      if (index < 0) return
      scrollToTocItem(index, 'start')
      const request: NonNullable<typeof explicitNavigation.current> = { tab, pending: true }
      explicitNavigation.current = request
      void navigate().finally(() => {
        if (explicitNavigation.current !== request) return
        request.pending = false
        request.settledKey = tocItemIdentity(tab.currentNavItem)
        lastScrolledKey.current = `${tab.id}:${request.settledKey}:${rows.length}`
      })
    },
    [rows, scrollToTocItem, tab],
  )
  const collapseStickyRow = useCallback(
    (item: INavItem) => {
      const index = rows.findIndex((row) => row.item === item)
      const row = rows[index]
      if (!row) return
      scrollToTocItem(index, 'start')
      explicitNavigation.current = undefined
      // Consume the collapse-induced auto-reveal so it cannot replace the parent's scroll anchor.
      const remainingRows = rows.length - (row.endIndex - index)
      tab.toggleNavItem(item)
      lastScrolledKey.current = `${tab.id}:${tocItemIdentity(tab.currentNavItem)}:${remainingRows}`
    },
    [rows, scrollToTocItem, tab],
  )

  useEffect(() => {
    if (!active) return
    if (!currentKey || currentIndex < 0) return

    const scrollKey = `${tab.id}:${currentKey}:${rows.length}`
    const navigation = explicitNavigation.current
    if (navigation?.tab === tab && (navigation.pending || navigation.settledKey === currentKey)) {
      lastScrolledKey.current = scrollKey
      if (!navigation.pending) explicitNavigation.current = undefined
      return
    }
    explicitNavigation.current = undefined
    if (lastScrolledKey.current === scrollKey) return

    lastScrolledKey.current = scrollKey
    scrollToTocItem(currentIndex)
  }, [active, currentIndex, currentKey, rows.length, scrollToTocItem, tab])

  return (
    <Pane
      headline={t('toc.title')}
      minSize={160}
      overlayScroll
      scrollbar={{ ...scrollbar, scrollRef: outerRef }}
      stateKey="readerToc"
      actions={[
        {
          id: 'locate-current',
          title: t('action.locate_current'),
          Icon: LocateFixedIcon,
          handle() {
            const tab = reader.focusedBookTab
            const navItem = tab?.currentNavItem
            if (!navItem) return

            const tocVersion = tab.tocVersion
            tab.expandNavPath(navItem)
            explicitNavigation.current = undefined
            lastScrolledKey.current = undefined

            if (!currentKey || tab.tocVersion !== tocVersion || currentIndex < 0) return

            window.requestAnimationFrame(() => {
              if (!active) return
              lastScrolledKey.current = `${tab.id}:${currentKey}:${rows.length}`
              scrollToTocItem(currentIndex)
            })
          },
        },
        {
          id: expanded ? 'collapse-all' : 'expand-all',
          title: t(expanded ? 'action.collapse_all' : 'action.expand_all'),
          Icon: expanded ? FoldVerticalIcon : UnfoldVerticalIcon,
          handle() {
            reader.focusedBookTab?.setNavExpanded(!expanded)
          },
        },
      ]}
      ref={outerRef}
    >
      <div className="sticky top-0 z-10 h-0">
        <div className="relative overflow-hidden shadow-[0_1px_0_var(--flow-border)]" style={{ height: stickyHeight }}>
          {stickyRows.map(({ index, top }, slot) => {
            const row = rows[index]!
            return (
              <div
                key={index}
                className="absolute right-0 left-0 bg-(--flow-bg-sidebar)"
                style={{ top, zIndex: stickyRows.length - slot }}
              >
                <div className="bg-foreground/[0.035]">
                  <TocRow
                    active={tocItemIdentity(row.item) === currentKey}
                    activeClassName={backgroundClassNames.rowActiveClassName}
                    depth={row.depth}
                    chapterCount={chapterCounts?.get(row.item)}
                    item={row.item}
                    itemExpanded={!!row.item.expanded}
                    itemLabel={row.item.label}
                    tab={tab}
                    emptyLabel={EMPTY_ROW_LABEL}
                    onActivate={activateStickyRow}
                    onToggle={collapseStickyRow}
                  />
                </div>
              </div>
            )
          })}
        </div>
      </div>
      <div className="relative" style={{ height: totalSize }}>
        {items.map(({ index, start, size }, slotIndex) => {
          const row = rows[index]
          const item = row?.item
          const identity = tocItemIdentity(item)
          const active = identity === currentKey

          return (
            <div
              key={`toc-slot:${slotIndex}`}
              className="absolute top-0 right-0 left-0"
              style={{
                height: size,
                transform: `translateY(${start}px)`,
                visibility: stickyIndices.has(index) ? 'hidden' : undefined,
              }}
            >
              <TocRow
                active={active}
                activeClassName={backgroundClassNames.rowActiveClassName}
                depth={row?.depth ?? 1}
                chapterCount={item ? chapterCounts?.get(item) : undefined}
                item={item}
                itemExpanded={!!item?.expanded}
                itemLabel={item?.label ?? ''}
                tab={tab}
                emptyLabel={EMPTY_ROW_LABEL}
              />
            </div>
          )
        })}
      </div>
    </Pane>
  )
}

interface TocRowProps {
  active: boolean
  activeClassName: string
  depth: number
  chapterCount?: number
  item?: INavItem
  itemExpanded: boolean
  itemLabel: string
  tab: BookTab
  emptyLabel: string
  onActivate?: (item: INavItem, navigate: () => Promise<unknown>) => void
  onToggle?: (item: INavItem) => void
}
const TocRow: React.FC<TocRowProps> = memo(
  ({
    active,
    activeClassName,
    depth,
    chapterCount,
    item,
    itemExpanded,
    itemLabel,
    tab,
    emptyLabel,
    onActivate,
    onToggle,
  }) => {
    if (!item) return null
    const { subitems, href = '' } = item
    const hasSubitems = !!subitems?.length
    const title = itemLabel.trim()
    const toggleItem = () => {
      if (onToggle) {
        onToggle(item)
        return
      }
      tab.toggleNavItem({
        id: item.id,
        href: item.href,
      })
    }

    const handleClick = () => {
      const [, id] = href.split('#')
      const section = href.trim() ? tab.sections?.find((s) => sameHref(s.href, href)) : undefined

      if (!section) {
        if (hasSubitems) toggleItem()
        return
      }

      const navigate = () =>
        id ? tab.displayFromSelector(`#${id}`, section, true, true) : tab.displaySectionStart(section, true)
      if (onActivate) onActivate(item, navigate)
      else void navigate()
    }

    return (
      <Row
        as="button"
        active={active}
        activeClassName={activeClassName}
        aria-label={title}
        className="w-full appearance-none border-0 bg-transparent p-0"
        depth={depth}
        emptyLabel={emptyLabel}
        expanded={itemExpanded}
        label={title}
        badge={!!chapterCount}
        badgeCount={chapterCount}
        onClick={handleClick}
        subitems={subitems}
        title={title || undefined}
        toggle={toggleItem}
        tooltipContentStyle={readerPageTooltipContentStyle}
      />
    )
  },
)
TocRow.displayName = 'TocRow'

function tocItemIdentity(item?: Pick<INavItem, 'id' | 'href' | 'label'>) {
  return item && (item.id || item.href || item.label)
}
