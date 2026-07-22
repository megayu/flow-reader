import { FoldVerticalIcon, UnfoldVerticalIcon, XIcon } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Highlighter from 'react-highlight-words'

import { useList } from '@flow/reader/hooks/useList'
import { useTranslation } from '@flow/reader/hooks/useTranslation'
import { IMatch, reader, useReaderSnapshot } from '@flow/reader/models/reader'
import { flatTree } from '@flow/reader/models/tree'

import { readerPageTooltipContentStyle } from '../AppTooltip'
import { IconButton } from '../Button'
import { Row } from '../Row'
import { OverlayScroll, PaneView, PaneViewProps } from '../base/PaneView'
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
    setLocalKeyword((current) =>
      current === modelKeyword ? current : modelKeyword,
    )
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
const ResultList: React.FC<ResultListProps> = ({
  results,
  keyword,
  activeResultID,
}) => {
  const rows = useMemo(
    () => results.flatMap((r) => flatTree(r)) ?? [],
    [results],
  )
  const { outerRef, items, scrollbar, totalSize } = useList(rows)
  const t = useTranslation('search')

  const sectionCount = results.length
  const resultCount = results.reduce((a, r) => r.subitems!.length + a, 0)

  return (
    <>
      <div className="text-muted-foreground px-3 py-2 text-base">
        {t('files.result')
          .replace('{n}', '' + resultCount)
          .replace('{m}', '' + sectionCount)}
      </div>
      <OverlayScroll
        ref={outerRef}
        className="text-muted-foreground text-base"
        containerClassName="min-h-0 flex-1"
        reserveScrollbarWidth
        scrollbar={{ ...scrollbar, scrollRef: outerRef }}
      >
        <div className="relative" style={{ height: totalSize }}>
          {items.map(({ index, start, size }) => (
            <div
              key={rows[index]?.id ?? index}
              className="absolute top-0 right-0 left-0"
              style={{
                height: size,
                transform: `translateY(${start}px)`,
              }}
            >
              <ResultRow
                result={rows[index]}
                keyword={keyword}
                active={rows[index]?.id === activeResultID}
              />
            </div>
          ))}
        </div>
      </OverlayScroll>
    </>
  )
}

interface ResultRowProps {
  result?: IMatch
  keyword: string
  active: boolean
}
const ResultRow: React.FC<ResultRowProps> = ({ result, keyword, active }) => {
  if (!result) return null
  const { depth, expanded, subitems, id } = result
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
            void tab.displaySearchResult(result, keyword)
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
