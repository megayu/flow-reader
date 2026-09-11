import type { DictionaryProvider } from '../coordinator'
import { type LocalDictionaryRecord, loadMdictStylesheet, lookupMdict } from '../native'
import { beginDictionarySession } from '../session'

import { sanitizeMdictContent } from './mdictContent'

export function createMdictProvider(dictionary: LocalDictionaryRecord): DictionaryProvider {
  return {
    id: `mdict:${dictionary.id}`,
    name: dictionary.name,
    scope: 'local',
    sourceLanguages: dictionary.language.value,
    async lookup(query, { signal }) {
      const session = beginDictionarySession(signal)
      const response = await lookupMdict(dictionary.id, query.text, session.id)
      session.throwIfCancelled()
      if (!response.entry) return null

      const document = await sanitizeMdictContent({
        html: response.entry.html,
        resourceUrlPrefix: response.resourceUrlPrefix,
        async loadStylesheet(key) {
          const stylesheet = await loadMdictStylesheet(dictionary.id, key, session.id)
          return stylesheet?.text ?? null
        },
      })
      session.throwIfCancelled()
      return {
        content: { document, kind: 'rich' },
        sourceId: `mdict:${dictionary.id}`,
        sourceName: dictionary.name,
      }
    },
  }
}
