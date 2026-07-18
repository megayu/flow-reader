import { classifyDictionaryQuery, normalizeDictionaryQuery } from './query'
import type {
  DictionaryQuery,
  DictionaryQueryLanguage,
  DictionaryResult,
  SupportedDictionaryLanguage,
} from './types'

export type DictionaryProviderScope = 'local' | 'online'

export interface DictionaryProvider {
  externalUrl?: (query: DictionaryQuery) => string
  id: string
  lookup: (
    query: DictionaryQuery,
    context: { signal: AbortSignal },
  ) => Promise<DictionaryResult | null>
  name: string
  scope: DictionaryProviderScope
  sourceLanguages: readonly SupportedDictionaryLanguage[]
}

export type DictionarySourceStatus =
  | 'cancelled'
  | 'empty'
  | 'error'
  | 'idle'
  | 'loading'
  | 'success'

export interface DictionarySourceState {
  error?: string
  externalUrl?: string
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
const MAX_DICTIONARY_INTERNAL_ENTRY_LENGTH = 128

export class DictionaryCoordinator {
  private activeSession?: { controller: AbortController; id: number }
  private readonly localTasks = new AbortableTaskLimiter(2)
  private nextSessionId = 1

  lookup(
    rawText: string,
    providers: DictionaryProvider[],
    onUpdate?: SourceUpdateListener,
    metadataLanguage?: string,
  ): DictionaryLookupSession {
    const query = normalizeDictionaryQuery(rawText, metadataLanguage)
    const eligibleProviders = query
      ? providers.filter((provider) =>
          isProviderEligible(provider, query.language),
        )
      : []
    return this.startLookup(query, eligibleProviders, onUpdate)
  }

  lookupInternalEntry(
    entry: string,
    provider: DictionaryProvider,
    onUpdate?: SourceUpdateListener,
  ): DictionaryLookupSession {
    const query = exactInternalEntryQuery(entry)
    return this.startLookup(query, query ? [provider] : [], onUpdate)
  }

  private startLookup(
    query: DictionaryQuery | null,
    eligibleProviders: DictionaryProvider[],
    onUpdate?: SourceUpdateListener,
  ) {
    this.activeSession?.controller.abort()

    const id = this.nextSessionId++
    const controller = new AbortController()
    this.activeSession = { controller, id }
    let sources = eligibleProviders.map<DictionarySourceState>((provider) => ({
      externalUrl: query ? provider.externalUrl?.(query) : undefined,
      providerId: provider.id,
      providerName: provider.name,
      status: provider.scope === 'local' ? 'idle' : 'loading',
    }))

    if (sources.length > 0) onUpdate?.(sources)

    const done = Promise.all(
      eligibleProviders.map(async (provider, index) => {
        try {
          const lookup = () =>
            provider.lookup(query!, {
              signal: controller.signal,
            })
          const result = await (provider.scope === 'local'
            ? this.localTasks.run(controller.signal, lookup, () => {
                if (!this.isCurrent(id) || controller.signal.aborted) return
                sources = replaceSource(sources, index, {
                  externalUrl: provider.externalUrl?.(query!),
                  providerId: provider.id,
                  providerName: provider.name,
                  status: 'loading',
                })
                onUpdate?.(sources)
              })
            : lookup())
          if (!this.isCurrent(id) || controller.signal.aborted) return

          sources = replaceSource(sources, index, {
            externalUrl: result?.externalUrl ?? provider.externalUrl?.(query!),
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
            externalUrl:
              externalUrlFromError(error) ?? provider.externalUrl?.(query!),
            providerId: provider.id,
            providerName: provider.name,
            status: 'error',
          })
          onUpdate?.(sources)
        }
      }),
    ).then<DictionaryLookupCompletion>(() => {
      const cancelled = controller.signal.aborted || !this.isCurrent(id)

      return {
        cancelled,
        query,
        sources: cancelled
          ? sources.map((source) => ({ ...source, status: 'cancelled' }))
          : sources,
      }
    })

    return {
      cancel: () => this.cancelSession(id, controller),
      done,
      id,
      query,
    }
  }

  cancelActive() {
    const session = this.activeSession
    if (session) this.cancelSession(session.id, session.controller)
  }

  diagnostics() {
    return {
      activeSessionId: this.activeSession?.id,
      localQueriesRunning: this.localTasks.running,
      localQueriesWaiting: this.localTasks.waiting,
    }
  }

  private isCurrent(id: number) {
    return this.activeSession?.id === id
  }

  private cancelSession(id: number, controller: AbortController) {
    controller.abort()
    if (this.isCurrent(id)) this.activeSession = undefined
  }
}

function exactInternalEntryQuery(entry: string): DictionaryQuery | null {
  const characters = Array.from(entry)
  if (
    !characters.length ||
    characters.length > MAX_DICTIONARY_INTERNAL_ENTRY_LENGTH ||
    /[\u0000-\u001f\u007f]/u.test(entry)
  ) {
    return null
  }

  return {
    language: classifyDictionaryQuery(entry),
    text: entry,
  }
}

class AbortableTaskLimiter {
  private activeCount = 0
  private readonly queue: Array<{
    reject: (reason?: unknown) => void
    resolve: (value: unknown) => void
    signal: AbortSignal
    start: () => Promise<unknown>
    started: () => void
    stopListening: () => void
  }> = []

  constructor(private readonly limit: number) {}

  get running() {
    return this.activeCount
  }

  get waiting() {
    return this.queue.length
  }

  run<T>(signal: AbortSignal, task: () => Promise<T>, onStart: () => void) {
    if (signal.aborted) return Promise.reject(abortError())

    return new Promise<T>((resolve, reject) => {
      const queuedTask = {
        reject,
        resolve: resolve as (value: unknown) => void,
        signal,
        start: task as () => Promise<unknown>,
        started: onStart,
        stopListening: () => signal.removeEventListener('abort', handleAbort),
      }
      const handleAbort = () => {
        const index = this.queue.indexOf(queuedTask)
        if (index < 0) return
        this.queue.splice(index, 1)
        reject(abortError())
      }
      signal.addEventListener('abort', handleAbort, { once: true })
      this.queue.push(queuedTask)
      this.drain()
    })
  }

  private drain() {
    while (this.activeCount < this.limit) {
      const task = this.queue.shift()
      if (!task) return
      if (task.signal.aborted) {
        task.reject(abortError())
        continue
      }

      task.stopListening()
      task.started()
      this.activeCount += 1
      void task
        .start()
        .then(task.resolve, task.reject)
        .finally(() => {
          this.activeCount -= 1
          this.drain()
        })
    }
  }
}

function abortError() {
  return new DOMException('Request cancelled', 'AbortError')
}

function externalUrlFromError(error: unknown) {
  if (
    typeof error === 'object' &&
    error !== null &&
    'externalUrl' in error &&
    typeof error.externalUrl === 'string'
  ) {
    return error.externalUrl
  }
}

export function isProviderEligible(
  provider: Pick<DictionaryProvider, 'scope' | 'sourceLanguages'>,
  queryLanguage: DictionaryQueryLanguage,
) {
  return provider.sourceLanguages.some((language) => language === queryLanguage)
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
