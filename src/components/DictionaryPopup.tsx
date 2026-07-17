import { ArrowLeftIcon, SquareIcon, Volume2Icon, XIcon } from 'lucide-react'
import { ScrollArea as ScrollAreaPrimitive } from 'radix-ui'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

import {
  DictionaryCoordinator,
  type DictionaryProvider,
  type DictionarySourceState,
} from '../dictionary/coordinator'
import {
  pushDictionaryDetailHistory,
  type DictionaryDetailLocation,
} from '../dictionary/detailHistory'
import type { LocalDictionaryRecord } from '../dictionary/native'
import { createMdictProvider } from '../dictionary/providers/mdict'
import { createMerriamWebsterProvider } from '../dictionary/providers/merriamWebster'
import { createStarDictProvider } from '../dictionary/providers/stardict'
import { zdicProvider } from '../dictionary/providers/zdic'
import { normalizeDictionaryQuery } from '../dictionary/query'
import { useSelectionSpeech } from '../hooks/useSelectionSpeech'
import { useTranslation } from '../hooks/useTranslation'
import { useSettings } from '../state'

import { IconButton } from './Button'
import { DictionarySourceSection } from './DictionarySourceSection'

interface DictionaryPopupProps {
  bookLanguage?: string
  maxBodyHeight: number
  onBack: () => void
  onClose: () => void
  query: string
  localDictionaries: LocalDictionaryRecord[]
}

interface DictionaryScrollAnchor {
  element?: HTMLElement
  offset: number
  scrollTop: number
  sourceId?: string
}

export function DictionaryPopup({
  bookLanguage,
  maxBodyHeight,
  onBack,
  onClose,
  query,
  localDictionaries,
}: DictionaryPopupProps) {
  const t = useTranslation('dictionary')
  const [settings] = useSettings()
  const rootCoordinator = useMemo(() => new DictionaryCoordinator(), [])
  const detailCoordinator = useMemo(() => new DictionaryCoordinator(), [])
  const merriamWebster = settings.dictionary?.merriamWebster
  const providers = useMemo(
    () => [
      zdicProvider,
      ...(merriamWebster?.enabled
        ? [createMerriamWebsterProvider(merriamWebster.apiKey)]
        : []),
      ...localDictionaries.map((dictionary) =>
        dictionary.format === 'mdict'
          ? createMdictProvider(dictionary)
          : createStarDictProvider(dictionary),
      ),
    ],
    [localDictionaries, merriamWebster],
  )
  const [rootSources, setRootSources] = useState<DictionarySourceState[]>([])
  const [retrySources, setRetrySources] = useState<
    Record<string, DictionarySourceState>
  >({})
  const [retryingSourceIds, setRetryingSourceIds] = useState<
    Record<string, boolean>
  >({})
  const [detailHistory, setDetailHistory] = useState<
    readonly DictionaryDetailLocation[]
  >([])
  const [detailSourcesByKey, setDetailSourcesByKey] = useState<
    Record<string, DictionarySourceState[]>
  >({})
  const [currentSourceId, setCurrentSourceId] = useState<string>()
  const scrollRef = useRef<HTMLDivElement>(null)
  const retryCoordinatorsRef = useRef(new Map<string, DictionaryCoordinator>())
  const detailLookupKeysRef = useRef(new Set<string>())
  const detailScrollTopsRef = useRef(new Map<string, number>())
  const pendingScrollAnchorRef = useRef<DictionaryScrollAnchor>(undefined)
  const rootScrollTopRef = useRef(0)
  const restoreRootScrollRef = useRef(false)
  const currentDetail = detailHistory.at(-1)
  const detailKey = currentDetail
    ? dictionaryDetailKey(currentDetail)
    : undefined
  const detailProvider = currentDetail
    ? providers.find((provider) => provider.id === currentDetail.providerId)
    : undefined
  const mergedRootSources = useMemo(
    () =>
      rootSources.map((source) => retrySources[source.providerId] ?? source),
    [retrySources, rootSources],
  )
  const retainedDetailViews = useMemo(() => {
    const views = new Map<string, DictionaryDetailLocation>()
    detailHistory.forEach((location) => {
      const key = dictionaryDetailKey(location)
      if (!views.has(key)) views.set(key, location)
    })
    return Array.from(views, ([key, location]) => ({ key, location }))
  }, [detailHistory])
  const navigationSources = useMemo(
    () => mergedRootSources.filter((source) => source.status !== 'cancelled'),
    [mergedRootSources],
  )
  const selectableNavigationSources = useMemo(
    () => navigationSources.filter((source) => source.status !== 'empty'),
    [navigationSources],
  )
  const currentSource = currentDetail
    ? navigationSources.find(
        (source) => source.providerId === currentDetail.providerId,
      )
    : (selectableNavigationSources.find(
        (source) => source.providerId === currentSourceId,
      ) ??
      selectableNavigationSources[0] ??
      navigationSources[0])
  const queryLanguage = normalizeDictionaryQuery(query)?.language ?? 'unknown'
  const speech = useSelectionSpeech({
    bookLanguage,
    queryLanguage,
    text: query,
  })
  useEffect(() => {
    const retryCoordinators = retryCoordinatorsRef.current
    retryCoordinators.forEach((coordinator) => coordinator.cancelActive())
    retryCoordinators.clear()
    setRetrySources({})
    setRetryingSourceIds({})
    const session = rootCoordinator.lookup(query, providers, setRootSources)
    return () => {
      session.cancel()
      rootCoordinator.cancelActive()
      retryCoordinators.forEach((coordinator) => coordinator.cancelActive())
      retryCoordinators.clear()
    }
  }, [providers, query, rootCoordinator])

  const captureScrollAnchor = useCallback((): DictionaryScrollAnchor | null => {
    const scroll = scrollRef.current
    if (!scroll) return null

    const scrollRect = scroll.getBoundingClientRect()
    const source = Array.from(
      scroll.querySelectorAll<HTMLElement>('[data-dictionary-source-id]'),
    ).find((element) => element.getBoundingClientRect().bottom > scrollRect.top)
    const hit = document.elementFromPoint(
      Math.min(scrollRect.right - 1, scrollRect.left + 20),
      Math.min(scrollRect.bottom - 1, scrollRect.top + 8),
    )
    const element =
      hit instanceof HTMLElement && hit !== scroll && scroll.contains(hit)
        ? hit
        : source
    const anchorSource = element?.closest<HTMLElement>(
      '[data-dictionary-source-id]',
    )
    const anchorRect = element?.getBoundingClientRect()

    return {
      element,
      offset: anchorRect ? anchorRect.top - scrollRect.top : 0,
      scrollTop: scroll.scrollTop,
      sourceId:
        anchorSource?.dataset.dictionarySourceId ??
        source?.dataset.dictionarySourceId,
    }
  }, [])

  useLayoutEffect(() => {
    const anchor = pendingScrollAnchorRef.current
    const scroll = scrollRef.current
    if (!anchor || !scroll) return
    pendingScrollAnchorRef.current = undefined

    const element = anchor.element?.isConnected
      ? anchor.element
      : Array.from(
          scroll.querySelectorAll<HTMLElement>('[data-dictionary-source-id]'),
        ).find(
          (source) => source.dataset.dictionarySourceId === anchor.sourceId,
        )
    if (!element) {
      scroll.scrollTop = anchor.scrollTop
      return
    }
    const nextOffset =
      element.getBoundingClientRect().top - scroll.getBoundingClientRect().top
    scroll.scrollTop += nextOffset - anchor.offset
  }, [retrySources])

  const retrySource = useCallback(
    (provider: DictionaryProvider) => {
      if (currentDetail || provider.scope !== 'online') return

      const coordinator =
        retryCoordinatorsRef.current.get(provider.id) ??
        new DictionaryCoordinator()
      retryCoordinatorsRef.current.set(provider.id, coordinator)
      setRetryingSourceIds((current) => ({
        ...current,
        [provider.id]: true,
      }))
      coordinator.lookup(query, [provider], (sources) => {
        const source = sources[0]
        if (!source) return
        const terminal =
          source.status === 'empty' ||
          source.status === 'error' ||
          source.status === 'success'
        if (terminal) {
          pendingScrollAnchorRef.current = captureScrollAnchor() ?? undefined
        }
        setRetrySources((current) => ({
          ...current,
          [provider.id]: source,
        }))
        if (terminal) {
          setRetryingSourceIds((current) => ({
            ...current,
            [provider.id]: false,
          }))
        }
      })
    },
    [captureScrollAnchor, currentDetail, query],
  )

  useEffect(() => {
    if (currentDetail) return
    setCurrentSourceId((current) =>
      selectableNavigationSources.some(
        (source) => source.providerId === current,
      )
        ? current
        : selectableNavigationSources[0]?.providerId,
    )
  }, [currentDetail, selectableNavigationSources])

  const pruneDetailCaches = useCallback(
    (history: readonly DictionaryDetailLocation[]) => {
      const retainedKeys = new Set(
        history.map((location) => dictionaryDetailKey(location)),
      )
      detailLookupKeysRef.current.forEach((key) => {
        if (!retainedKeys.has(key)) detailLookupKeysRef.current.delete(key)
      })
      detailScrollTopsRef.current.forEach((_, key) => {
        if (!retainedKeys.has(key)) detailScrollTopsRef.current.delete(key)
      })
      setDetailSourcesByKey((current) => {
        const entries = Object.entries(current).filter(([key]) =>
          retainedKeys.has(key),
        )
        return entries.length === Object.keys(current).length
          ? current
          : Object.fromEntries(entries)
      })
    },
    [],
  )

  useEffect(() => {
    if (
      !currentDetail ||
      !detailKey ||
      !detailProvider ||
      detailLookupKeysRef.current.has(detailKey)
    ) {
      return
    }

    detailLookupKeysRef.current.add(detailKey)
    setDetailSourcesByKey((current) => ({
      ...current,
      [detailKey]: [],
    }))
    const session = detailCoordinator.lookupInternalEntry(
      currentDetail.query,
      detailProvider,
      (sources) => {
        if (!detailLookupKeysRef.current.has(detailKey)) return
        setDetailSourcesByKey((current) => ({
          ...current,
          [detailKey]: sources,
        }))
      },
    )
    return () => {
      session.cancel()
      detailCoordinator.cancelActive()
    }
  }, [currentDetail, detailCoordinator, detailKey, detailProvider])

  const restoreRootScroll = useCallback(() => {
    const scroll = scrollRef.current
    if (!scroll || !restoreRootScrollRef.current) return

    scroll.scrollTop = rootScrollTopRef.current
    if (Math.abs(scroll.scrollTop - rootScrollTopRef.current) < 1) {
      restoreRootScrollRef.current = false
    }
  }, [])

  useLayoutEffect(() => {
    const scroll = scrollRef.current
    if (!scroll) return
    if (detailKey) {
      scroll.scrollTop = detailScrollTopsRef.current.get(detailKey) ?? 0
      return
    }
    restoreRootScroll()
  }, [detailKey, restoreRootScroll])

  const navigateToEntry = useCallback(
    (providerId: string, entry: string) => {
      if (detailKey) {
        detailScrollTopsRef.current.set(
          detailKey,
          scrollRef.current?.scrollTop ?? 0,
        )
      } else {
        rootScrollTopRef.current = scrollRef.current?.scrollTop ?? 0
      }
      const nextHistory = pushDictionaryDetailHistory(detailHistory, {
        providerId,
        query: entry,
      })
      pruneDetailCaches(nextHistory)
      setDetailHistory(nextHistory)
    },
    [detailHistory, detailKey, pruneDetailCaches],
  )

  const handleBack = useCallback(() => {
    if (!currentDetail) {
      onBack()
      return
    }

    if (detailKey) {
      detailScrollTopsRef.current.set(
        detailKey,
        scrollRef.current?.scrollTop ?? 0,
      )
    }
    if (detailHistory.length === 1) {
      restoreRootScrollRef.current = true
    }
    const nextHistory = detailHistory.slice(0, -1)
    pruneDetailCaches(nextHistory)
    setDetailHistory(nextHistory)
  }, [currentDetail, detailHistory, detailKey, onBack, pruneDetailCaches])

  const canNavigateDetailBack =
    currentDetail?.providerId.startsWith('mdict:') ?? false

  const updateCurrentSource = (scroll: HTMLDivElement) => {
    if (currentDetail) return
    const sources = Array.from(
      scroll.querySelectorAll<HTMLElement>('[data-dictionary-source-id]'),
    ).filter(
      (source) =>
        source.dataset.dictionarySourceStatus !== 'cancelled' &&
        source.dataset.dictionarySourceStatus !== 'empty',
    )
    if (!sources.length) return

    const scrollTop = scroll.getBoundingClientRect().top + 1
    const atEnd =
      scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 1
    const current = atEnd
      ? sources.at(-1)
      : sources.reduce(
          (candidate, source) =>
            source.getBoundingClientRect().top <= scrollTop
              ? source
              : candidate,
          sources[0],
        )
    const sourceId = current?.dataset.dictionarySourceId
    if (sourceId) setCurrentSourceId(sourceId)
  }

  const locateSource = (sourceId: string) => {
    if (currentDetail) return
    if (
      !selectableNavigationSources.some(
        (source) => source.providerId === sourceId,
      )
    ) {
      return
    }
    const scroll = scrollRef.current
    const source = Array.from(
      scroll?.querySelectorAll<HTMLElement>('[data-dictionary-source-id]') ??
        [],
    ).find((element) => element.dataset.dictionarySourceId === sourceId)
    if (!scroll || !source) return

    const header = source.querySelector<HTMLElement>(
      '[data-dictionary-source-header]',
    )
    const targetTop = header
      ? header.getBoundingClientRect().bottom + 1
      : source.getBoundingClientRect().top
    scroll.scrollTop += targetTop - scroll.getBoundingClientRect().top
    setCurrentSourceId(sourceId)
  }

  return (
    <div
      className="flex min-h-0 flex-col"
      onMouseDownCapture={(event) => {
        if (event.button !== 3 || !canNavigateDetailBack) return
        event.preventDefault()
        event.stopPropagation()
        handleBack()
      }}
    >
      <header className="border-border flex h-12 shrink-0 items-center gap-2 border-b px-2">
        <IconButton
          Icon={ArrowLeftIcon}
          className="shrink-0"
          data-dictionary-back="true"
          onClick={handleBack}
        />
        <div className="flex min-w-0 flex-1 items-center justify-center gap-1">
          <div className="truncate text-center font-medium">{query}</div>
          <IconButton
            aria-pressed={speech.isSpeaking}
            Icon={speech.isSpeaking ? SquareIcon : Volume2Icon}
            className="shrink-0"
            data-dictionary-speech="true"
            disabled={!speech.isSupported}
            onClick={speech.toggle}
          />
        </div>
        <IconButton
          Icon={XIcon}
          className="shrink-0"
          data-dictionary-close="true"
          onClick={onClose}
        />
      </header>
      {navigationSources.length > 0 && (
        <div className="border-border grid min-h-10 shrink-0 grid-cols-[minmax(0,7fr)_minmax(0,3fr)] items-center border-b">
          <div
            className="truncate px-5 text-sm font-medium"
            data-dictionary-current-source="true"
          >
            {currentSource?.providerName}
          </div>
          <nav
            className="flex min-w-0 items-center justify-end gap-1 px-2"
            data-dictionary-navigator="true"
          >
            {navigationSources.map((source) => {
              const active =
                !currentDetail &&
                source.status !== 'empty' &&
                source.providerId === currentSource?.providerId
              return (
                <button
                  key={source.providerId}
                  type="button"
                  aria-label={source.providerName}
                  aria-pressed={active}
                  className={`enabled:hover:border-border enabled:hover:bg-muted enabled:hover:text-foreground inline-flex size-7 shrink-0 items-center justify-center rounded-sm border text-sm leading-none font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-[var(--flow-accent-border)] enabled:cursor-pointer disabled:cursor-default disabled:opacity-35 ${
                    active
                      ? 'text-foreground border-transparent bg-[var(--flow-accent-bg)] ring-1 ring-[var(--flow-accent-border)] ring-inset'
                      : 'text-muted-foreground border-transparent'
                  }`}
                  disabled={Boolean(currentDetail) || source.status === 'empty'}
                  onClick={() => locateSource(source.providerId)}
                >
                  {sourceShortcut(source)}
                </button>
              )
            })}
          </nav>
        </div>
      )}
      <ScrollAreaPrimitive.Root
        className="relative min-h-0 overflow-hidden"
        style={{ maxHeight: maxBodyHeight }}
      >
        <ScrollAreaPrimitive.Viewport
          ref={scrollRef}
          className="min-h-0 w-full overscroll-contain"
          data-dictionary-scroll="true"
          style={{ maxHeight: maxBodyHeight, overflowAnchor: 'none' }}
          onScroll={(event) => updateCurrentSource(event.currentTarget)}
        >
          <div hidden={Boolean(currentDetail)}>
            {mergedRootSources.length ? (
              mergedRootSources.map((source) => {
                const provider = providers.find(
                  (candidate) => candidate.id === source.providerId,
                )
                return (
                  <DictionarySourceSection
                    key={source.providerId}
                    activeRichContent={!currentDetail}
                    isRetrying={Boolean(retryingSourceIds[source.providerId])}
                    onContentResize={restoreRootScroll}
                    onEntryNavigate={navigateToEntry}
                    onRetry={
                      provider?.scope === 'online'
                        ? () => retrySource(provider)
                        : undefined
                    }
                    source={source}
                  />
                )
              })
            ) : (
              <div className="text-muted-foreground px-5 py-3 text-sm">
                {t('no_result')}
              </div>
            )}
          </div>
          {retainedDetailViews.map(({ key }) => {
            const active = key === detailKey
            const sources = detailSourcesByKey[key] ?? []
            return (
              <div key={key} hidden={!active}>
                {sources.length ? (
                  sources.map((source) => (
                    <DictionarySourceSection
                      key={source.providerId}
                      activeRichContent={active}
                      onEntryNavigate={navigateToEntry}
                      onNavigateBack={handleBack}
                      source={source}
                    />
                  ))
                ) : (
                  <div className="text-muted-foreground px-5 py-3 text-sm">
                    {t('no_result')}
                  </div>
                )}
              </div>
            )
          })}
        </ScrollAreaPrimitive.Viewport>
        <ScrollAreaPrimitive.Scrollbar
          className="flex w-2.5 touch-none bg-transparent p-0.5 select-none"
          orientation="vertical"
        >
          <ScrollAreaPrimitive.Thumb className="bg-muted-foreground/20 hover:bg-muted-foreground/30 active:bg-muted-foreground/40 relative flex-1 rounded-full" />
        </ScrollAreaPrimitive.Scrollbar>
      </ScrollAreaPrimitive.Root>
    </div>
  )
}

function sourceShortcut(source: DictionarySourceState) {
  if (source.providerId === 'zdic') return '汉'
  if (source.providerId === 'merriam-webster') return 'M'
  return Array.from(source.providerName.trim())[0]?.toLocaleUpperCase() ?? '·'
}

function dictionaryDetailKey(location: DictionaryDetailLocation) {
  return `${location.providerId}\u0000${location.query}`
}
