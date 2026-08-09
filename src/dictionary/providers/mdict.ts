import type { DictionaryProvider } from '../coordinator'
import {
  cancelDictionarySession,
  type LocalDictionaryRecord,
  loadMdictStylesheet,
  lookupMdict,
  nextDictionarySessionId,
} from '../native'

import { sanitizeMdictContent } from './mdictContent'

export function createMdictProvider(dictionary: LocalDictionaryRecord): DictionaryProvider {
  return {
    id: `mdict:${dictionary.id}`,
    name: dictionary.name,
    scope: 'local',
    sourceLanguages: dictionary.language.value,
    async lookup(query, { signal }) {
      const sessionId = nextDictionarySessionId()
      const release = () => {
        void cancelDictionarySession(sessionId).catch(() => undefined)
      }
      if (signal.aborted) {
        release()
        throw new DOMException('Request cancelled', 'AbortError')
      }
      signal.addEventListener('abort', release, { once: true })
      const response = await lookupMdict(dictionary.id, query.text, sessionId)
      if (signal.aborted) {
        throw new DOMException('Request cancelled', 'AbortError')
      }
      if (!response.entry) return null

      const document = await sanitizeMdictContent({
        html: response.entry.html,
        resourceUrlPrefix: response.resourceUrlPrefix,
        async loadStylesheet(key) {
          const stylesheet = await loadMdictStylesheet(dictionary.id, key, sessionId)
          return stylesheet?.text ?? null
        },
      })
      if (signal.aborted) {
        throw new DOMException('Request cancelled', 'AbortError')
      }
      return {
        content: { document, kind: 'rich' },
        sourceId: `mdict:${dictionary.id}`,
        sourceName: dictionary.name,
      }
    },
  }
}
