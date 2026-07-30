import { FoldVerticalIcon, LocateFixedIcon, UnfoldVerticalIcon, XIcon } from 'lucide-react'
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import Highlighter from 'react-highlight-words'

import { useListSize } from '@/hooks/useList'
import { useTranslation } from '@/hooks/useTranslation'
import { type IMatch, reader, useReaderSnapshot } from '@/models/reader'

import { readerPageTooltipContentStyle } from '../AppTooltip'
import { OverlayScroll, PaneView, type PaneViewProps } from '../base/PaneView'
import { IconButton } from '../IconButton'
import { Row } from '../Row'
import { Input } from '../ui/input'

// When inputting with IME and storing state in `valtio`,
// unexpected rendering with `e.target.value === ''` occurs,
// which leads to `<input>` and IME flash to empty,
// while this will not happen when using `React.useState`,
// so we should create an intermediate `keyword` state to fix this.
function useIntermediateKeyword() {
  const { focusedBookTab } = useReaderSnapshot()
  const modelKeyword = focusedBookTab?.keyword ?? ''
  const [keyword, setLocalKeyword] = useState(modelKeyword)

  useEffect(() => {
    setLocalKeyword((current) => (current === modelKeyword ? current : modelKeyword))
  }, [modelKeyword])

  const setKeyword = useCallback((nextKeyword: string) => {
    setLocalKeyword(nextKeyword)
    reader.focusedBookTab?.setKeyword(nextKeyword)
  }, [])

  return [keyword, setKeyword] as const
}

export const SearchView: React.FC<PaneViewProps> = (props) => {
  const active = props.active ?? true

  return <PaneView {...props}>{active && <SearchPane />}</PaneView>
}

const SearchPane: React.FC = () => {
  const { focusedBookTab } = useReaderSnapshot()
  const t = useTranslation()
  const inputRef = useRef<HTMLInputElement | null>(null)
  const resultListRef = useRef<ResultListHandle | null>(null)

  const [keyword, setKeyword] = useIntermediateKeyword()

  const results = focusedBookTab?.results
  const activeResultID = focusedBookTab?.activeResultID
  const expanded = results?.some((r) => r.expanded)
  const toggleResults = () => {
    reader.focusedBookTab?.results?.forEach((r) => (r.expanded = !expanded))
  }

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      inputRef.current?.focus()
    })

    return () => window.clearTimeout(timeout)
  }, [])

  return (
    <div className="scroll-parent h-full flex-1">
      <div className="px-px py-px">
        <div className="bg-background flex h-8 items-center rounded-lg transition-shadow focus-within:shadow-[inset_0_0_0_1px_var(--ring)]">
          <Input
            ref={inputRef}
            name="keyword"
            autoFocus
            aria-label={t('search.title')}
            value={keyword}
            placeholder={t('search.title')}
            className="h-full flex-1 rounded-lg border-0 bg-transparent px-2.5 py-0 focus-visible:border-transparent focus-visible:ring-0"
            onChange={(e) => setKeyword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Escape') return

              e.preventDefault()
              e.stopPropagation()
              inputRef.current?.blur()
            }}
          />
          <div className="flex shrink-0 items-center gap-0.5 pr-1">
            <IconButton
              className="text-muted-foreground"
              title={t('action.locate_current')}
              Icon={LocateFixedIcon}
              onClick={() => {
                const sectionIndex = reader.focusedBookTab?.currentSection?.index
                if (sectionIndex === undefined) return

                resultListRef.current?.locateSection(sectionIndex)
              }}
            />
            <IconButton
              className="text-muted-foreground"
              title={t(expanded ? 'action.collapse_all' : 'action.expand_all')}
              Icon={expanded ? FoldVerticalIcon : UnfoldVerticalIcon}
              onClick={toggleResults}
            />
            {keyword && (
              <IconButton
                className="text-muted-foreground"
                title={t('action.clear')}
                Icon={XIcon}
                onClick={() => setKeyword('')}
              />
            )}
          </div>
        </div>
      </div>
      {keyword && results && (
        <ResultList
          ref={resultListRef}
          results={results as IMatch[]}
          keyword={keyword}
          activeResultID={activeResultID}
        />
      )}
    </div>
  )
}

interface ResultListProps {
  results: IMatch[]
  keyword: string
  activeResultID?: string
}
interface ResultListHandle {
  locateSection(sectionIndex: number): void
}

const ResultList = forwardRef<ResultListHandle, ResultListProps>(({ results, keyword, activeResultID }, ref) => {
  const rowIndex = useMemo(() => createSearchRowIndex(results), [results])
  const { outerRef, items, scrollbar, scrollToItem, totalSize } = useListSize(rowIndex.length)
  const pendingLocateSectionRef = useRef<number | null>(null)
  const t = useTranslation('search')

  const sectionCount = results.length
  const resultCount = results.reduce((a, r) => r.subitems!.length + a, 0)

  useLayoutEffect(() => {
    const sectionIndex = pendingLocateSectionRef.current
    if (sectionIndex === null) return

    const group = rowIndex.groups.find(({ result }) => result.sectionIndex === sectionIndex)
    pendingLocateSectionRef.current = null
    if (!group || group.childCount === 0) return

    scrollToItem({ index: group.start, align: 'start' })
  }, [rowIndex, scrollToItem])

  useImperativeHandle(
    ref,
    () => ({
      locateSection(sectionIndex) {
        const group = rowIndex.groups.find(({ result }) => result.sectionIndex === sectionIndex)
        const result = reader.focusedBookTab?.results?.find((result) => result.sectionIndex === sectionIndex)
        if (!group || !result) return

        if (result.expanded) {
          scrollToItem({ index: group.start, align: 'start' })
          return
        }

        pendingLocateSectionRef.current = sectionIndex
        result.expanded = true
      },
    }),
    [rowIndex, scrollToItem],
  )

  return (
    <>
      <div className="text-muted-foreground px-3 py-2 text-base">{t('result.summary', resultCount, sectionCount)}</div>
      <OverlayScroll
        ref={outerRef}
        className="text-muted-foreground text-base"
        containerClassName="min-h-0 flex-1"
        reserveScrollbarWidth
        scrollbar={{ ...scrollbar, scrollRef: outerRef }}
      >
        <div className="relative" style={{ height: totalSize }}>
          {items.map(({ index, start, size }) => {
            const row = searchRowAt(rowIndex, index)
            return (
              <div
                key={row?.result?.id ?? index}
                className="absolute top-0 right-0 left-0"
                style={{
                  height: size,
                  transform: `translateY(${start}px)`,
                }}
              >
                <ResultRow
                  result={row?.result}
                  depth={row?.depth}
                  sectionIndex={row?.sectionIndex}
                  href={row?.href}
                  keyword={keyword}
                  active={row?.result?.id === activeResultID}
                />
              </div>
            )
          })}
        </div>
      </OverlayScroll>
    </>
  )
})
ResultList.displayName = 'ResultList'

interface ResultRowProps {
  result?: IMatch
  depth?: number
  sectionIndex?: number
  href?: string
  keyword: string
  active: boolean
}
const ResultRow: React.FC<ResultRowProps> = ({ result, depth, sectionIndex, href, keyword, active }) => {
  if (!result) return null
  const { expanded, subitems, id } = result
  let { excerpt, description } = result
  const tab = reader.focusedBookTab
  const isGroup = !!subitems?.length

  excerpt = excerpt.trim()
  description = description?.trim()

  return (
    <Row
      title={description ? `${description} / ${excerpt}` : excerpt}
      label={excerpt}
      description={description}
      depth={depth}
      active={active}
      aria-current={active ? 'true' : undefined}
      expanded={expanded}
      subitems={subitems}
      badge={isGroup}
      tooltipContentStyle={readerPageTooltipContentStyle}
      {...(!isGroup && {
        onClick: () => {
          if (tab) {
            tab.activeResultID = id
            void tab.displaySearchResult(result, keyword, {
              sectionIndex,
              href,
            })
          }
        },
      })}
      toggle={() => tab?.toggleResult(id)}
    >
      {!isGroup && (
        <Highlighter
          highlightClassName="match-highlight"
          searchWords={[keyword]}
          textToHighlight={excerpt}
          autoEscape
        />
      )}
    </Row>
  )
}

interface SearchRowGroup {
  result: IMatch
  start: number
  childCount: number
}

interface SearchRowIndex {
  groups: SearchRowGroup[]
  length: number
}

function createSearchRowIndex(results: IMatch[]): SearchRowIndex {
  const groups: SearchRowGroup[] = []
  let length = 0

  results.forEach((result) => {
    const childCount = result.expanded ? (result.subitems?.length ?? 0) : 0
    groups.push({ result, start: length, childCount })
    length += childCount + 1
  })

  return { groups, length }
}

function searchRowAt(index: SearchRowIndex, rowIndex: number) {
  let low = 0
  let high = index.groups.length - 1

  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const group = index.groups[middle]!
    if (rowIndex < group.start) {
      high = middle - 1
    } else if (rowIndex > group.start + group.childCount) {
      low = middle + 1
    } else {
      const childIndex = rowIndex - group.start - 1
      return childIndex < 0
        ? {
            result: group.result,
            depth: 1,
            sectionIndex: group.result.sectionIndex,
            href: group.result.href ?? group.result.id,
          }
        : {
            result: group.result.subitems?.[childIndex],
            depth: 2,
            sectionIndex: group.result.sectionIndex,
            href: group.result.href ?? group.result.id,
          }
    }
  }
}
