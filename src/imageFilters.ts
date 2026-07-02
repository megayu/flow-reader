import type { ImageEntry } from './models/reader'

interface ImageSectionLike {
  images: ImageEntry[]
}

function normalizeImageSourceKey(src: string) {
  const [withoutFragment] = src.split('#')
  const value = withoutFragment || src

  try {
    return decodeURI(value)
  } catch {
    return value
  }
}

function markDuplicate(image: ImageEntry) {
  const changed = !image.hiddenByDefault || image.reason !== 'duplicate'
  image.hiddenByDefault = true
  image.reason = 'duplicate'
  return changed
}

export function createDuplicateIllustrationFilter() {
  const firstCandidateBySrc = new Map<string, ImageEntry>()
  const duplicateSrcs = new Set<string>()
  let processedSections = new WeakSet<ImageSectionLike>()

  return {
    applyToSection(section: ImageSectionLike) {
      if (processedSections.has(section)) return false
      processedSections.add(section)

      let changed = false

      for (const image of section.images) {
        const duplicateEvidence = image.reason === 'duplicate'
        if ((image.hiddenByDefault && !duplicateEvidence) || !image.src) {
          continue
        }

        const key = normalizeImageSourceKey(image.src)
        if (!key) continue

        if (duplicateSrcs.has(key)) {
          changed = markDuplicate(image) || changed
          continue
        }

        const first = firstCandidateBySrc.get(key)
        if (first) {
          changed = markDuplicate(first) || changed
          changed = markDuplicate(image) || changed
          duplicateSrcs.add(key)
          firstCandidateBySrc.delete(key)
          continue
        }

        if (duplicateEvidence) {
          duplicateSrcs.add(key)
          continue
        }

        firstCandidateBySrc.set(key, image)
      }

      return changed
    },
    reset() {
      firstCandidateBySrc.clear()
      duplicateSrcs.clear()
      processedSections = new WeakSet<ImageSectionLike>()
    },
  }
}
