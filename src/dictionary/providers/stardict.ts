import type { DictionaryProvider } from '../coordinator'
import { type LocalDictionaryRecord, lookupStarDict } from '../native'
import { beginDictionarySession } from '../session'

export function createStarDictProvider(dictionary: LocalDictionaryRecord): DictionaryProvider {
  return {
    id: `stardict:${dictionary.id}`,
    name: dictionary.name,
    scope: 'local',
    sourceLanguages: dictionary.language.value,
    async lookup(query, { signal }) {
      const session = beginDictionarySession(signal)
      const response = await lookupStarDict(dictionary.id, query.text, session.id)
      session.throwIfCancelled()
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
