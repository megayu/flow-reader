import { ArrowLeftIcon, XIcon } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import {
  DictionaryCoordinator,
  type DictionarySourceState,
} from '../dictionary/coordinator'
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
  const [activeQuery, setActiveQuery] = useState(query)
  const [settings] = useSettings()
  const coordinator = useMemo(() => new DictionaryCoordinator(), [])
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
  const [sources, setSources] = useState<DictionarySourceState[]>([])

  useEffect(() => {
    const session = coordinator.lookup(activeQuery, providers, setSources)
    return () => {
      session.cancel()
      coordinator.cancelActive()
    }
  }, [activeQuery, coordinator, providers])

  return (
    <div className="flex min-h-0 flex-col">
      <header className="border-border flex h-12 shrink-0 items-center gap-2 border-b px-2">
        <IconButton
          title={t('back')}
          Icon={ArrowLeftIcon}
          className="shrink-0"
          onClick={onBack}
        />
        <div className="min-w-0 flex-1 truncate text-center font-medium">
          {activeQuery}
        </div>
        <IconButton
          title={t('close')}
          Icon={XIcon}
          className="shrink-0"
          onClick={onClose}
        />
      </header>
      <div
        className="scroll min-h-0 overflow-y-auto overscroll-contain"
        style={{ maxHeight: maxBodyHeight }}
      >
        {sources.length ? (
          sources.map((source) => (
            <DictionarySourceSection
              key={source.providerId}
              onEntryNavigate={setActiveQuery}
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
