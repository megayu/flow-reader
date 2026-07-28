export const DICTIONARY_DETAIL_HISTORY_LIMIT = 16

export interface DictionaryDetailLocation {
  providerId: string
  query: string
}

export function pushDictionaryDetailHistory(
  history: readonly DictionaryDetailLocation[],
  location: DictionaryDetailLocation,
) {
  const current = history.at(-1)
  if (current?.providerId === location.providerId && current.query === location.query) {
    return history
  }

  return [...history, location].slice(-DICTIONARY_DETAIL_HISTORY_LIMIT)
}
