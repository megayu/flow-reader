import clsx from 'clsx'
import {
  FoldVerticalIcon,
  LocateFixedIcon,
  UnfoldVerticalIcon,
} from 'lucide-react'
import { memo, useEffect, useMemo, useRef, useState } from 'react'

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
  compareHref,
  INavItem,
  reader,
  useReaderSnapshot,
} from '@flow/reader/models/reader'
import { dfs } from '@flow/reader/models/tree'
import { useSetViewMode } from '@flow/reader/state'

import { AppTooltip, readerPageTooltipContentStyle } from '../AppTooltip'
import { BookTooltipContent } from '../BookTooltipContent'
import { Row } from '../Row'
import { Pane, PaneView, PaneViewProps } from '../base/PaneView'
import { StateLayer } from '../base/StateLayer'

export const TocView: React.FC<PaneViewProps> = (props) => {
  return (
    <PaneView {...props}>
      <LibraryPane />
      <TocPane />
    </PaneView>
  )
}

const LibraryPane: React.FC = () => {
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
    if (!currentBookId || currentIndex < 0) return

    scrollToItem({ index: currentIndex, align: 'auto' })
  }, [currentBookId, currentIndex, scrollToItem])

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

const TocPane: React.FC = () => {
  const t = useTranslation()
  const { focusedBookTab } = useReaderSnapshot()
  const toc = focusedBookTab?.nav?.toc as INavItem[] | undefined
  const rows = useMemo(() => flattenToc(toc), [toc])
  const { outerRef, items, scrollToItem, totalSize } = useList(rows)
  const expanded = toc?.some((r) => r.expanded)
  const currentNavItem = focusedBookTab?.currentNavItem
  const currentKey = tocItemIdentity(currentNavItem)
  const currentIndex = useMemo(
    () => rows.findIndex(({ item }) => tocItemIdentity(item) === currentKey),
    [currentKey, rows],
  )
  const lastScrolledKey = useRef<string | undefined>(undefined)
  const [locateRequest, setLocateRequest] = useState(0)

  useEffect(() => {
    if (!currentKey || currentIndex < 0) return

    const scrollKey = `${currentKey}:${rows.length}`
    if (lastScrolledKey.current === scrollKey) return

    lastScrolledKey.current = scrollKey
    scrollToItem({ index: currentIndex, align: 'auto' })
  }, [currentIndex, currentKey, rows.length, scrollToItem])

  useEffect(() => {
    if (!locateRequest || !currentKey || currentIndex < 0) return

    const frame = window.requestAnimationFrame(() => {
      lastScrolledKey.current = `${currentKey}:${rows.length}`
      scrollToItem({ index: currentIndex, align: 'auto' })
    })

    return () => window.cancelAnimationFrame(frame)
  }, [currentIndex, currentKey, locateRequest, rows.length, scrollToItem])

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

            tab.expandNavPath(navItem)
            setLocateRequest((request) => request + 1)
          },
        },
        {
          id: expanded ? 'collapse-all' : 'expand-all',
          title: t(expanded ? 'action.collapse_all' : 'action.expand_all'),
          Icon: expanded ? FoldVerticalIcon : UnfoldVerticalIcon,
          handle() {
            reader.focusedBookTab?.nav?.toc?.forEach((r) =>
              dfs(r as INavItem, (i) => (i.expanded = !expanded)),
            )
          },
        },
      ]}
      ref={outerRef}
    >
      <div className="relative" style={{ height: totalSize }}>
        {items.map(({ index, start, size }) => {
          const row = rows[index]
          const item = row?.item
          const identity = tocItemIdentity(item)
          const active = identity === currentKey

          return (
            <div
              key={tocRowKey(item, index)}
              className="absolute top-0 right-0 left-0"
              style={{
                height: size,
                transform: `translateY(${start}px)`,
              }}
            >
              <TocRow active={active} depth={row?.depth ?? 1} item={item} />
            </div>
          )
        })}
      </div>
    </Pane>
  )
}

interface TocRowProps {
  active: boolean
  depth: number
  item?: INavItem
}
const TocRow: React.FC<TocRowProps> = memo(({ active, depth, item }) => {
  if (!item) return null
  const { label, subitems, expanded, href = '' } = item
  const tab = reader.focusedBookTab
  const hasSubitems = !!subitems?.length
  const toggleItem = () => {
    tab?.toggleNavItem({
      id: item.id,
      href: item.href,
    })
  }

  return (
    <Row
      title={label.trim()}
      tooltipContentStyle={readerPageTooltipContentStyle}
      depth={depth}
      active={active}
      expanded={expanded}
      subitems={subitems}
      onClick={() => {
        if (!href.trim()) {
          if (hasSubitems) toggleItem()
          return
        }

        const [, id] = href.split('#')
        const section = tab?.sections?.find((s) => compareHref(s.href, href))

        if (!section) {
          if (hasSubitems) toggleItem()
          return
        }

        if (id) {
          void tab?.displayFromSelector(`#${id}`, section, false)
        } else {
          void tab?.displaySectionStart(section)
        }
      }}
      // `tab` can not be proxy here
      toggle={toggleItem}
    />
  )
})
TocRow.displayName = 'TocRow'

function tocItemIdentity(item?: Pick<INavItem, 'id' | 'href' | 'label'>) {
  return item && (item.id || item.href || item.label)
}

function tocRowKey(
  item: Pick<INavItem, 'id' | 'href' | 'label'> | undefined,
  index: number,
) {
  return `${tocItemIdentity(item) ?? 'toc-row'}:${index}`
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
