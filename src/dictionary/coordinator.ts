import { normalizeDictionaryQuery } from './query'
import type {
  DictionaryQuery,
  DictionaryQueryLanguage,
  DictionaryResult,
} from './types'

export type DictionaryProviderScope = 'local' | 'online'

export interface DictionaryProvider {
  id: string
  lookup: (
    query: DictionaryQuery,
    context: { signal: AbortSignal },
  ) => Promise<DictionaryResult | null>
  name: string
  scope: DictionaryProviderScope
  sourceLanguage: 'en' | 'unknown' | 'zh'
}

export type DictionarySourceStatus =
  | 'cancelled'
  | 'empty'
  | 'error'
  | 'loading'
  | 'success'

export interface DictionarySourceState {
  error?: string
  providerId: string
  providerName: string
  result?: DictionaryResult
  status: DictionarySourceStatus
}

export interface DictionaryLookupCompletion {
  cancelled: boolean
  query: DictionaryQuery | null
  sources: DictionarySourceState[]
}

export interface DictionaryLookupSession {
  cancel: () => void
  done: Promise<DictionaryLookupCompletion>
  id: number
  query: DictionaryQuery | null
}

type SourceUpdateListener = (sources: DictionarySourceState[]) => void

export class DictionaryCoordinator {
  private activeSession?: { controller: AbortController; id: number }
  private nextSessionId = 1

  lookup(
    rawText: string,
    providers: DictionaryProvider[],
    onUpdate?: SourceUpdateListener,
  ): DictionaryLookupSession {
    this.activeSession?.controller.abort()

    const id = this.nextSessionId++
    const controller = new AbortController()
    const query = normalizeDictionaryQuery(rawText)
    this.activeSession = { controller, id }

    const eligibleProviders = query
      ? providers.filter((provider) =>
          isProviderEligible(provider, query.language),
        )
      : []
    let sources = eligibleProviders.map<DictionarySourceState>((provider) => ({
      providerId: provider.id,
      providerName: provider.name,
      status: 'loading',
    }))

    if (sources.length > 0) onUpdate?.(sources)

    const done = Promise.all(
      eligibleProviders.map(async (provider, index) => {
        try {
          const result = await provider.lookup(query!, {
            signal: controller.signal,
          })
          if (!this.isCurrent(id) || controller.signal.aborted) return

          sources = replaceSource(sources, index, {
            providerId: provider.id,
            providerName: provider.name,
            ...(result
              ? { result, status: 'success' as const }
              : { status: 'empty' as const }),
          })
          onUpdate?.(sources)
        } catch (error) {
          if (!this.isCurrent(id) || controller.signal.aborted) return

          sources = replaceSource(sources, index, {
            error: error instanceof Error ? error.message : String(error),
            providerId: provider.id,
            providerName: provider.name,
            status: 'error',
          })
          onUpdate?.(sources)
        }
      }),
    ).then<DictionaryLookupCompletion>(() => {
      const cancelled = controller.signal.aborted || !this.isCurrent(id)
      if (this.isCurrent(id)) this.activeSession = undefined

      return {
        cancelled,
        query,
        sources: cancelled
          ? sources.map((source) => ({ ...source, status: 'cancelled' }))
          : sources,
      }
    })

    return {
      cancel: () => controller.abort(),
      done,
      id,
      query,
    }
  }

  cancelActive() {
    this.activeSession?.controller.abort()
  }

  private isCurrent(id: number) {
    return this.activeSession?.id === id
  }
}

export function isProviderEligible(
  provider: Pick<DictionaryProvider, 'scope' | 'sourceLanguage'>,
  queryLanguage: DictionaryQueryLanguage,
) {
  if (provider.scope === 'online') {
    return queryLanguage === provider.sourceLanguage
  }

  return (
    provider.sourceLanguage === 'unknown' ||
    provider.sourceLanguage === queryLanguage
  )
}

function replaceSource(
  sources: DictionarySourceState[],
  index: number,
  source: DictionarySourceState,
) {
  return sources.map((current, currentIndex) =>
    currentIndex === index ? source : current,
  )
}
