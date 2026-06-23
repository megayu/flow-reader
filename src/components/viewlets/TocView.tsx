import clsx from 'clsx'
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { MdMyLocation } from 'react-icons/md'
import { VscCollapseAll, VscExpandAll } from 'react-icons/vsc'

import {
  compareBookDisplayTitle,
  getBookDisplayTitle,
  getBookTooltip,
} from '@flow/reader/book'
import { useBackground } from '@flow/reader/hooks/theme/useBackground'
import { useLibrary } from '@flow/reader/hooks/useLibrary'
import { useList } from '@flow/reader/hooks/useList'
import { useMobile } from '@flow/reader/hooks/useMobile'
import { useTranslation } from '@flow/reader/hooks/useTranslation'
import {
  compareHref,
  INavItem,
  reader,
  useReaderSnapshot,
} from '@flow/reader/models/reader'
import { dfs } from '@flow/reader/models/tree'
import { useSetViewMode } from '@flow/reader/state'

import { Row } from '../Row'
import { Pane, PaneView, PaneViewProps } from '../base/PaneView'
import { StateLayer } from '../base/StateLayer'

export const TocView: React.FC<PaneViewProps> = (props) => {
  const mobile = useMobile()
  return (
    <PaneView {...props}>
      {mobile || <LibraryPane />}
      <TocPane />
    </PaneView>
  )
}

const LibraryPane: React.FC = () => {
  const books = useLibrary()
  const { focusedBookTab, groups } = useReaderSnapshot()
  const setViewMode = useSetViewMode()
  const [, , background] = useBackground()
  const paneRef = useRef<HTMLDivElement>(null)
  const rowRefs = useRef(new Map<string, HTMLButtonElement>())
  const sortedBooks = useMemo(
    () => books?.slice().sort(compareBookDisplayTitle),
    [books],
  )
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
  const t = useTranslation('toc')

  useEffect(() => {
    if (!currentBookId) return
    const pane = paneRef.current
    if (!pane || pane.offsetParent === null) return

    rowRefs.current.get(currentBookId)?.scrollIntoView({ block: 'nearest' })
  }, [currentBookId, sortedBooks?.length])

  return (
    <Pane ref={paneRef} headline={t('library')} preferredSize={240}>
      {sortedBooks?.map((book) => {
        const displayTitle = getBookDisplayTitle(book)
        const tooltip = getBookTooltip(book)
        const opened = openedBookIds.has(book.id)
        const active = book.id === currentBookId

        return (
          <button
            key={book.id}
            ref={(el) => {
              if (el) {
                rowRefs.current.set(book.id, el)
              } else {
                rowRefs.current.delete(book.id)
              }
            }}
            className={clsx(
              'relative w-full truncate py-1 pr-3 pl-5 text-left',
              opened && !active && background.rowActiveClassName,
              active &&
                clsx(
                  background.rowActiveClassName,
                  'ring-ring ring-1 ring-inset',
                ),
            )}
            title={tooltip}
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
            <StateLayer />
            {opened && !active && (
              <span className="bg-primary/60 absolute inset-y-1 left-1 w-0.5 rounded-full" />
            )}
            {displayTitle}
          </button>
        )
      })}
    </Pane>
  )
}

const TocPane: React.FC = () => {
  const t = useTranslation()
  const { focusedBookTab } = useReaderSnapshot()
  const toc = focusedBookTab?.nav?.toc as INavItem[] | undefined
  const rows = useMemo(() => flattenToc(toc), [toc])
  const { outerRef, innerRef, items, scrollToItem } = useList(rows)
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
          Icon: MdMyLocation,
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
          Icon: expanded ? VscCollapseAll : VscExpandAll,
          handle() {
            reader.focusedBookTab?.nav?.toc?.forEach((r) =>
              dfs(r as INavItem, (i) => (i.expanded = !expanded)),
            )
          },
        },
      ]}
      ref={outerRef}
    >
      <div ref={innerRef}>
        {items.map(({ index }) => {
          const row = rows[index]
          const item = row?.item
          const identity = tocItemIdentity(item)
          const active = identity === currentKey

          return (
            <TocRow
              key={tocRowKey(item, index)}
              active={active}
              depth={row?.depth ?? 1}
              item={item}
            />
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
