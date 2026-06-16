import { StateLayer } from '@literal-ui/core'
import { useEffect, useRef } from 'react'
import { VscCollapseAll, VscExpandAll } from 'react-icons/vsc'

import { useLibrary, useMobile, useTranslation } from '@flow/reader/hooks'
import {
  compareHref,
  dfs,
  flatTree,
  INavItem,
  reader,
  useReaderSnapshot,
} from '@flow/reader/models'

import { Row } from '../Row'
import { PaneViewProps, PaneView, Pane } from '../base'

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
  const t = useTranslation('toc')
  return (
    <Pane headline={t('library')} preferredSize={240}>
      {books?.map((book) => (
        <button
          key={book.id}
          className="relative w-full truncate py-1 pl-5 pr-3 text-left"
          title={book.name}
          draggable
          onClick={() => reader.addTab(book)}
          onDragStart={(e) => {
            e.dataTransfer.setData('text/plain', book.id)
          }}
        >
          <StateLayer />
          {book.name}
        </button>
      ))}
    </Pane>
  )
}

const TocPane: React.FC = () => {
  const t = useTranslation()
  const { focusedBookTab } = useReaderSnapshot()
  const toc = focusedBookTab?.nav?.toc as INavItem[] | undefined
  const rows = toc?.flatMap((i) => flatTree(i)) ?? []
  const expanded = toc?.some((r) => r.expanded)
  const currentNavItem = focusedBookTab?.currentNavItem
  const currentKey = tocItemIdentity(currentNavItem)
  const lastScrolledKey = useRef<string>()
  const rowRefs = useRef(new Map<string, HTMLDivElement>())

  useEffect(() => {
    if (!currentKey) return

    const row = rowRefs.current.get(currentKey)
    if (!row) return

    const scrollKey = `${currentKey}:${rows.length}`
    if (lastScrolledKey.current === scrollKey) return

    lastScrolledKey.current = scrollKey
    row.scrollIntoView({ block: 'nearest' })
  }, [currentKey, rows.length])

  return (
    <Pane
      headline={t('toc.title')}
      actions={[
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
    >
      {rows.map((item, index) => {
        const identity = tocItemIdentity(item)
        return (
          <div
            key={tocRowKey(item, index)}
            ref={(el) => {
              if (!identity) return

              if (el) {
                rowRefs.current.set(identity, el)
              } else {
                rowRefs.current.delete(identity)
              }
            }}
          >
            <TocRow currentNavItem={currentNavItem as INavItem} item={item} />
          </div>
        )
      })}
    </Pane>
  )
}

interface TocRowProps {
  currentNavItem?: INavItem
  item?: INavItem
}
const TocRow: React.FC<TocRowProps> = ({ currentNavItem, item }) => {
  if (!item) return null
  const { label, subitems, depth, expanded, href } = item
  const tab = reader.focusedBookTab
  const active = tocItemIdentity(item) === tocItemIdentity(currentNavItem)

  return (
    <Row
      title={label.trim()}
      depth={depth}
      active={active}
      expanded={expanded}
      subitems={subitems}
      onClick={() => {
        const [, id] = href.split('#')
        const section = tab?.sections?.find((s) => compareHref(s.href, href))

        if (!section) return

        if (id) {
          tab?.displayFromSelector(`#${id}`, section, false)
        } else {
          tab?.display(section.href, false)
        }
      }}
      // `tab` can not be proxy here
      toggle={() => tab?.toggleNavItem(item)}
    />
  )
}

function tocItemIdentity(item?: Pick<INavItem, 'id' | 'href' | 'label'>) {
  return item && (item.id || item.href || item.label)
}

function tocRowKey(
  item: Pick<INavItem, 'id' | 'href' | 'label'> | undefined,
  index: number,
) {
  return `${tocItemIdentity(item) ?? 'toc-row'}:${index}`
}
