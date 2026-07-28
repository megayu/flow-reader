export const zdicSourceId = 'zdic'
export const merriamWebsterSourceId = 'merriam-webster'

export function localDictionarySourceId(dictionaryId: string) {
  return `local:${dictionaryId}`
}

export function reconcileDictionarySourceOrder(
  savedOrder: readonly string[] | undefined,
  localDictionaryIds: readonly string[],
) {
  const available = new Set([zdicSourceId, merriamWebsterSourceId, ...localDictionaryIds.map(localDictionarySourceId)])
  const result: string[] = []
  const seen = new Set<string>()

  for (const sourceId of savedOrder ?? []) {
    if (!available.has(sourceId) || seen.has(sourceId)) continue
    seen.add(sourceId)
    result.push(sourceId)
  }
  for (const sourceId of available) {
    if (seen.has(sourceId)) continue
    seen.add(sourceId)
    result.push(sourceId)
  }

  return result
}

export function orderByDictionarySource<T>(
  sources: readonly T[],
  sourceOrder: readonly string[],
  sourceId: (source: T) => string,
) {
  const positions = new Map(sourceOrder.map((currentSourceId, index) => [currentSourceId, index]))
  return [...sources].sort(
    (left, right) =>
      (positions.get(sourceId(left)) ?? Number.MAX_SAFE_INTEGER) -
      (positions.get(sourceId(right)) ?? Number.MAX_SAFE_INTEGER),
  )
}
