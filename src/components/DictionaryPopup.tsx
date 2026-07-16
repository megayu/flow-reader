import { ArrowLeftIcon, XIcon } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import {
  DictionaryCoordinator,
  type DictionarySourceState,
} from '../dictionary/coordinator'
import { zdicProvider } from '../dictionary/providers/zdic'
import { useTranslation } from '../hooks/useTranslation'

import { IconButton } from './Button'
import { DictionarySourceSection } from './DictionarySourceSection'

interface DictionaryPopupProps {
  maxBodyHeight: number
  onBack: () => void
  onClose: () => void
  query: string
}

export function DictionaryPopup({
  maxBodyHeight,
  onBack,
  onClose,
  query,
}: DictionaryPopupProps) {
  const t = useTranslation('dictionary')
  const coordinator = useMemo(() => new DictionaryCoordinator(), [])
  const [sources, setSources] = useState<DictionarySourceState[]>([
    {
      providerId: zdicProvider.id,
      providerName: zdicProvider.name,
      status: 'loading',
    },
  ])

  useEffect(() => {
    const session = coordinator.lookup(query, [zdicProvider], setSources)
    return () => {
      session.cancel()
      coordinator.cancelActive()
    }
  }, [coordinator, query])

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
          {query}
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
            <DictionarySourceSection key={source.providerId} source={source} />
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
