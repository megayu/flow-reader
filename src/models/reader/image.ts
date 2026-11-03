import { originalImageResourceUrl } from '@flow/epub-engine'

export function normalizeImageSource(src: string) {
  src = originalImageResourceUrl(src)
  try {
    return decodeURI(src)
  } catch {
    return src
  }
}

export function imageSourcesMatch(a: string | undefined, b: string | undefined) {
  if (!a || !b) return false
  if (a === b) return true

  const normalizedA = normalizeImageSource(a)
  const normalizedB = normalizeImageSource(b)
  return normalizedA === normalizedB || normalizedA.includes(normalizedB) || normalizedB.includes(normalizedA)
}
