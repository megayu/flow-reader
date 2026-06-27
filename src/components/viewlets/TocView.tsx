import clsx from 'clsx'
import {
  FoldVerticalIcon,
  LocateFixedIcon,
  UnfoldVerticalIcon,
} from 'lucide-react'
import { memo, useEffect, useMemo, useRef } from 'react'
import { useSnapshot } from 'valtio'

import {
  compareBookDisplayTitle,
  getBookDisplayTitle,
  getBookTooltip,
} from '@flow/reader/book'
import { useBackground } from '@flow/reader/hooks/theme/useBackground'
import { useLibrary } from '@flow/reader/hooks/useLibrary'
import { LIST_ITEM_SIZE, useList } from '@flow/reader/hooks/useList'
import { useTranslation } from '@flow/reader/hooks/useTranslation'
import {
  BookTab,
  compareHref,
  INavItem,
  reader,
  useReaderSnapshot,
} from '@flow/reader/models/reader'
import { useSetViewMode } from '@flow/reader/state'

import { AppTooltip, readerPageTooltipContentStyle } from '../AppTooltip'
import { BookTooltipContent } from '../BookTooltipContent'
import { Twisty } from '../Row'
import { Pane, PaneView, PaneViewProps } from '../base/PaneView'
import { StateLayer } from '../base/StateLayer'

export const TocView: React.FC<PaneViewProps> = (props) => {
  const active = props.active ?? true

  return (
    <PaneView {...props}>
      {active && (
        <>
          <LibraryPane active={active} />
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
  const { focusedBookTab, groups } = useReaderSnapshot()
  const setViewMode = useSetViewMode()
  const [, , background] = useBackground()
  const sortedBooks = useMemo(
    () => books?.slice().sort(compareBookDisplayTitle) ?? [],
    [books],
  )
  const { outerRef, items, scrollToItem, totalSize } = useList(sortedBooks)
  const openedBookIds = useMemo(
    () =>
      new Set(
        groups.flatMap((group) =>
          group.tabs
            .map((tab) => ('book' in tab ? tab.book?.id : undefined))
            .filter((id): id is string => !!id),
        ),
      ),
    [groups],
  )
  const currentBookId = focusedBookTab?.book.id
  const currentIndex = useMemo(
    () => sortedBooks.findIndex((book) => book.id === currentBookId),
    [currentBookId, sortedBooks],
  )
  const t = useTranslation('toc')

  useEffect(() => {
    if (!active) return
    if (!currentBookId || currentIndex < 0) return

    scrollToItem({ index: currentIndex, align: 'auto' })
  }, [active, currentBookId, currentIndex, scrollToItem])

  return (
    <Pane ref={outerRef} headline={t('library')} preferredSize={240}>
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
                'group/library-row relative flex w-full items-center truncate py-0 pr-3 pl-5 text-left leading-none outline-none',
                opened &&
                  !active &&
                  'text-foreground/85 bg-[var(--flow-bg-control)]',
                active &&
                  clsx(
                    background.rowActiveClassName,
                    'text-foreground ring-1 ring-[var(--flow-accent-border)] ring-inset',
                  ),
              )}
              style={{
                height: LIST_ITEM_SIZE,
              }}
              aria-label={tooltip}
              aria-current={active ? 'true' : undefined}
              draggable
              onClick={() => {
                reader.addTab(book)
                setViewMode('reader')
              }}
              onDragStart={(e) => {
                e.dataTransfer.setData('text/plain', book.id)
              }}
            >
              <StateLayer className="transition-colors group-hover/library-row:bg-[var(--flow-bg-control-hover)]" />
              {(opened || active) && (
                <span
                  className={clsx(
                    'absolute inset-y-1 left-1 w-0.5 rounded-full',
                    active
                      ? 'w-1 bg-[var(--flow-accent)]'
                      : 'bg-[var(--flow-accent-border)]',
                  )}
                />
              )}
              <span className="relative z-10 min-w-0 flex-1 truncate">
                {displayTitle}
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
  const focusedIndex = readerSnapshot.focusedIndex
  const focusedGroup = readerSnapshot.groups[focusedIndex]
  const selectedIndex = focusedGroup?.selectedIndex
  const selectedTabId = focusedGroup?.tabs[selectedIndex ?? -1]?.id

  void selectedTabId
  return reader.focusedBookTab
}

const EmptyTocPane: React.FC = () => {
  const t = useTranslation()

  return <Pane headline={t('toc.title')} />
}

interface BookTocPaneProps {
  active: boolean
  tab: BookTab
}

const BookTocPane: React.FC<BookTocPaneProps> = ({ active, tab }) => {
  const t = useTranslation()
  const [, , background] = useBackground()
  const tabSnapshot = useSnapshot(tab)
  const toc = tab.nav?.toc as INavItem[] | undefined
  const tocVersion = tabSnapshot.tocVersion
  const rows = useMemo(() => {
    void tocVersion
    return flattenToc(toc)
  }, [toc, tocVersion])
  const { outerRef, items, scrollToItem, totalSize } = useList(rows)
  const expanded = toc?.some((r) => r.expanded)
  const currentNavItem = tabSnapshot.currentNavItem
  const currentKey = tocItemIdentity(currentNavItem)
  const currentIndex = useMemo(
    () => rows.findIndex(({ item }) => tocItemIdentity(item) === currentKey),
    [currentKey, rows],
  )
  const lastScrolledKey = useRef<string | undefined>(undefined)

  useEffect(() => {
    if (!active) return
    if (!currentKey || currentIndex < 0) return

    const scrollKey = `${currentKey}:${rows.length}`
    if (lastScrolledKey.current === scrollKey) return

    lastScrolledKey.current = scrollKey
    scrollToItem({ index: currentIndex, align: 'auto' })
  }, [active, currentIndex, currentKey, rows.length, scrollToItem])

  return (
    <Pane
      headline={t('toc.title')}
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
            lastScrolledKey.current = undefined

            if (
              !currentKey ||
              tab.tocVersion !== tocVersion ||
              currentIndex < 0
            )
              return

            window.requestAnimationFrame(() => {
              if (!active) return
              lastScrolledKey.current = `${currentKey}:${rows.length}`
              scrollToItem({ index: currentIndex, align: 'auto' })
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
              }}
            >
              <TocRow
                active={active}
                activeClassName={background.rowActiveClassName}
                depth={row?.depth ?? 1}
                item={item}
                tab={tab}
                untitledLabel={t('untitled')}
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
  item?: INavItem
  tab: BookTab
  untitledLabel: string
}
const TocRow: React.FC<TocRowProps> = memo(
  ({ active, activeClassName, depth, item, tab, untitledLabel }) => {
    if (!item) return null
    const { label, subitems, expanded, href = '' } = item
    const hasSubitems = !!subitems?.length
    const title = label.trim()
    const indent = Math.max(0, depth - 1) * 20
    const toggleItem = () => {
      tab.toggleNavItem({
        id: item.id,
        href: item.href,
      })
    }

    const handleClick = () => {
      if (!href.trim()) {
        if (hasSubitems) toggleItem()
        return
      }

      const [, id] = href.split('#')
      const section = tab.sections?.find((s) => compareHref(s.href, href))

      if (!section) {
        if (hasSubitems) toggleItem()
        return
      }

      if (id) {
        void tab.displayFromSelector(`#${id}`, section, false)
      } else {
        void tab.displaySectionStart(section)
      }
    }

    const row = (
      <button
        type="button"
        aria-label={title}
        className={clsx(
          'list-row group/row relative flex w-full cursor-pointer appearance-none items-center border-0 bg-transparent p-0 text-left',
          active && activeClassName,
        )}
        style={{
          paddingLeft: indent,
          paddingRight: 0,
          height: LIST_ITEM_SIZE,
        }}
        onClick={handleClick}
      >
        <StateLayer className="transition-colors group-hover/row:bg-[var(--flow-bg-control-hover)]" />
        <Twisty
          expanded={!!expanded}
          className={clsx(!hasSubitems && 'invisible')}
          onClick={(e) => {
            e.stopPropagation()
            toggleItem()
          }}
        />
        <div
          className={clsx(
            'relative z-10 flex h-full min-w-0 flex-1 items-center text-base leading-none',
            title ? 'text-muted-foreground' : 'text-muted-foreground/60',
          )}
          style={{
            marginLeft: 0,
          }}
        >
          <span className="block min-w-0 truncate whitespace-nowrap">
            {title || untitledLabel}
          </span>
        </div>
        <div className="relative z-10 ml-auto flex h-full items-center" />
      </button>
    )

    return title ? (
      <AppTooltip contentStyle={readerPageTooltipContentStyle} label={title}>
        {row}
      </AppTooltip>
    ) : (
      row
    )
  },
)
TocRow.displayName = 'TocRow'

function tocItemIdentity(item?: Pick<INavItem, 'id' | 'href' | 'label'>) {
  return item && (item.id || item.href || item.label)
}

function flattenToc(nodes: INavItem[] = []) {
  const rows: Array<{ item: INavItem; depth: number }> = []

  const visit = (node: INavItem, depth: number) => {
    rows.push({ item: node, depth })
    if (!node.expanded) return
    node.subitems?.forEach((item) => visit(item, depth + 1))
  }

  nodes.forEach((node) => visit(node, 1))
  return rows
}
