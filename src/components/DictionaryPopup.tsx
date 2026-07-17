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
  const [detailState, setDetailState] = useState<{
    key?: string
    sources: DictionarySourceState[]
  }>({ sources: [] })
  const [currentSourceId, setCurrentSourceId] = useState<string>()
  const scrollRef = useRef<HTMLDivElement>(null)
  const retryCoordinatorsRef = useRef(new Map<string, DictionaryCoordinator>())
  const pendingScrollAnchorRef = useRef<DictionaryScrollAnchor>(undefined)
  const rootScrollTopRef = useRef(0)
  const restoreRootScrollRef = useRef(false)
  const currentDetail = detailHistory.at(-1)
  const detailKey = currentDetail
    ? `${currentDetail.providerId}\u0000${currentDetail.query}`
    : undefined
  const detailProvider = currentDetail
    ? providers.find((provider) => provider.id === currentDetail.providerId)
    : undefined
  const mergedRootSources = useMemo(
    () =>
      rootSources.map((source) => retrySources[source.providerId] ?? source),
    [retrySources, rootSources],
  )
  const visibleSources = currentDetail
    ? detailState.key === detailKey
      ? detailState.sources
      : []
    : mergedRootSources
  const navigationSources = useMemo(
    () => mergedRootSources.filter((source) => source.status !== 'cancelled'),
    [mergedRootSources],
  )
  const currentSource = currentDetail
    ? navigationSources.find(
        (source) => source.providerId === currentDetail.providerId,
      )
    : (navigationSources.find(
        (source) => source.providerId === currentSourceId,
      ) ?? navigationSources[0])
  const backLabel = currentDetail ? t('back_entry') : t('back')
  const queryLanguage = normalizeDictionaryQuery(query)?.language ?? 'unknown'
  const speech = useSelectionSpeech({
    bookLanguage,
    queryLanguage,
    text: query,
  })
  const speechLabel = speech.isSupported
    ? speech.isSpeaking
      ? t('stop_speaking')
      : t('speak')
    : t('speech_unavailable')

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
      navigationSources.some((source) => source.providerId === current)
        ? current
        : navigationSources[0]?.providerId,
    )
  }, [currentDetail, navigationSources])

  useEffect(() => {
    if (!currentDetail || !detailKey || !detailProvider) return

    setDetailState({ key: detailKey, sources: [] })
    const session = detailCoordinator.lookupInternalEntry(
      currentDetail.query,
      detailProvider,
      (sources) => setDetailState({ key: detailKey, sources }),
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
    if (currentDetail) {
      scroll.scrollTop = 0
      return
    }
    restoreRootScroll()
  }, [currentDetail, restoreRootScroll])

  const navigateToEntry = useCallback(
    (providerId: string, entry: string) => {
      if (!currentDetail) {
        rootScrollTopRef.current = scrollRef.current?.scrollTop ?? 0
      }
      setDetailHistory((history) =>
        pushDictionaryDetailHistory(history, { providerId, query: entry }),
      )
    },
    [currentDetail],
  )

  const handleBack = () => {
    if (!currentDetail) {
      onBack()
      return
    }

    if (detailHistory.length === 1) {
      restoreRootScrollRef.current = true
    }
    setDetailHistory((history) => history.slice(0, -1))
  }

  const updateCurrentSource = (scroll: HTMLDivElement) => {
    if (currentDetail) return
    const sources = Array.from(
      scroll.querySelectorAll<HTMLElement>('[data-dictionary-source-id]'),
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
    <div className="flex min-h-0 flex-col">
      <header className="border-border flex h-12 shrink-0 items-center gap-2 border-b px-2">
        <IconButton
          title={backLabel}
          Icon={ArrowLeftIcon}
          className="shrink-0"
          aria-label={backLabel}
          onClick={handleBack}
        />
        <div className="flex min-w-0 flex-1 items-center justify-center gap-1">
          <div className="truncate text-center font-medium">{query}</div>
          <IconButton
            title={speechLabel}
            aria-label={speechLabel}
            aria-pressed={speech.isSpeaking}
            Icon={speech.isSpeaking ? SquareIcon : Volume2Icon}
            className="shrink-0"
            disabled={!speech.isSupported}
            onClick={speech.toggle}
          />
        </div>
        <IconButton
          title={t('close')}
          Icon={XIcon}
          className="shrink-0"
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
                source.providerId === currentSource?.providerId
              return (
                <button
                  key={source.providerId}
                  type="button"
                  aria-label={source.providerName}
                  aria-pressed={active}
                  className={`enabled:hover:border-border enabled:hover:bg-muted enabled:hover:text-foreground inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-sm border text-sm leading-none font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-[var(--flow-accent-border)] disabled:cursor-default disabled:opacity-35 ${
                    active
                      ? 'text-foreground border-transparent bg-[var(--flow-accent-bg)] ring-1 ring-[var(--flow-accent-border)] ring-inset'
                      : 'text-muted-foreground border-transparent'
                  }`}
                  disabled={Boolean(currentDetail)}
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
          {visibleSources.length ? (
            visibleSources.map((source) => {
              const provider = providers.find(
                (candidate) => candidate.id === source.providerId,
              )
              return (
                <DictionarySourceSection
                  key={source.providerId}
                  isRetrying={Boolean(retryingSourceIds[source.providerId])}
                  onContentResize={
                    currentDetail ? undefined : restoreRootScroll
                  }
                  onEntryNavigate={navigateToEntry}
                  onRetry={
                    !currentDetail && provider?.scope === 'online'
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
