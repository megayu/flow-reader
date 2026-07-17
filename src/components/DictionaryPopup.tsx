import { ArrowLeftIcon, XIcon } from 'lucide-react'
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
import { useTranslation } from '../hooks/useTranslation'
import { useSettings } from '../state'

import { IconButton } from './Button'
import { DictionarySourceSection } from './DictionarySourceSection'

interface DictionaryPopupProps {
  maxBodyHeight: number
  onBack: () => void
  onClose: () => void
  query: string
  localDictionaries: LocalDictionaryRecord[]
}

export function DictionaryPopup({
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
  const [detailHistory, setDetailHistory] = useState<
    readonly DictionaryDetailLocation[]
  >([])
  const [detailState, setDetailState] = useState<{
    key?: string
    sources: DictionarySourceState[]
  }>({ sources: [] })
  const scrollRef = useRef<HTMLDivElement>(null)
  const rootScrollTopRef = useRef(0)
  const restoreRootScrollRef = useRef(false)
  const currentDetail = detailHistory.at(-1)
  const detailKey = currentDetail
    ? `${currentDetail.providerId}\u0000${currentDetail.query}`
    : undefined
  const detailProvider = currentDetail
    ? providers.find((provider) => provider.id === currentDetail.providerId)
    : undefined
  const visibleSources = currentDetail
    ? detailState.key === detailKey
      ? detailState.sources
      : []
    : rootSources
  const backLabel = currentDetail ? t('back_entry') : t('back')

  useEffect(() => {
    const session = rootCoordinator.lookup(query, providers, setRootSources)
    return () => {
      session.cancel()
      rootCoordinator.cancelActive()
    }
  }, [providers, query, rootCoordinator])

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
        <div className="min-w-0 flex-1 truncate text-center font-medium">
          {currentDetail?.query ?? query}
        </div>
        <IconButton
          title={t('close')}
          Icon={XIcon}
          className="shrink-0"
          onClick={onClose}
        />
      </header>
      <div
        ref={scrollRef}
        className="scroll min-h-0 overflow-y-auto overscroll-contain"
        style={{ maxHeight: maxBodyHeight }}
      >
        {visibleSources.length ? (
          visibleSources.map((source) => (
            <DictionarySourceSection
              key={source.providerId}
              onContentResize={currentDetail ? undefined : restoreRootScroll}
              onEntryNavigate={navigateToEntry}
              source={source}
            />
          ))
        ) : (
          <div className="text-muted-foreground px-5 py-6 text-sm">
            {t('no_result')}
          </div>
        )}
      </div>
    </div>
  )
}
