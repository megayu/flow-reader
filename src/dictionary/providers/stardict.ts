import type { DictionaryProvider } from '../coordinator'
import { cancelDictionarySession, type LocalDictionaryRecord, lookupStarDict, nextDictionarySessionId } from '../native'

export function createStarDictProvider(dictionary: LocalDictionaryRecord): DictionaryProvider {
  return {
    id: `stardict:${dictionary.id}`,
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

      // Keep this listener after invoke resolves: the Rust mmap and data file
      // belong to the popup session and are released when the popup closes.
      signal.addEventListener('abort', release, { once: true })
      const response = await lookupStarDict(dictionary.id, query.text, sessionId)
      if (signal.aborted) {
        throw new DOMException('Request cancelled', 'AbortError')
      }
      const entries = response.entries.flatMap((entry) => {
        const definitions = entry.definitions
          .filter((definition) => typeof definition === 'string')
          .flatMap((definition) => definition.split(/\n{2,}/))
          .map((definition) => definition.trim())
          .filter(Boolean)
        if (!definitions.length) return []
        return [
          {
            headword: entry.headword,
            senses: definitions.map((definition) => ({
              definition: { kind: 'plain' as const, text: definition },
            })),
          },
        ]
      })
      if (!entries.length) return null
      return {
        content: { entries, kind: 'entries' },
        sourceId: `stardict:${dictionary.id}`,
        sourceName: dictionary.name,
      }
    },
  }
}
