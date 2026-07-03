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

function restoreIllustration(image: ImageEntry) {
  const changed = image.hiddenByDefault || image.reason !== undefined
  image.hiddenByDefault = false
  delete image.reason
  return changed
}

export function createDuplicateIllustrationFilter() {
  const firstCandidateBySrc = new Map<string, ImageEntry>()
  const duplicateSrcs = new Set<string>()
  const titleArtCandidatesBySrc = new Map<string, ImageEntry[]>()
  let processedSections = new WeakSet<ImageSectionLike>()

  return {
    applyToSection(section: ImageSectionLike) {
      if (processedSections.has(section)) return false
      processedSections.add(section)

      let changed = false

      for (const image of section.images) {
        const duplicateEvidence = image.reason === 'duplicate'
        const titleArtEvidence =
          image.hiddenByDefault && image.reason === 'titleArt'
        if ((image.hiddenByDefault && !duplicateEvidence) || !image.src) {
          if (titleArtEvidence && image.src) {
            const key = normalizeImageSourceKey(image.src)
            if (key) {
              const candidates = titleArtCandidatesBySrc.get(key) ?? []
              candidates.push(image)
              titleArtCandidatesBySrc.set(key, candidates)
            }
          }
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
    finalize() {
      let changed = false

      for (const [key, candidates] of titleArtCandidatesBySrc) {
        if (
          candidates.length !== 1 ||
          duplicateSrcs.has(key) ||
          firstCandidateBySrc.has(key)
        ) {
          continue
        }

        const candidate = candidates[0]
        if (!candidate) continue
        if (candidate.hiddenByDefault && candidate.reason === 'titleArt') {
          changed = restoreIllustration(candidate) || changed
        }
      }

      return changed
    },
    reset() {
      firstCandidateBySrc.clear()
      duplicateSrcs.clear()
      titleArtCandidatesBySrc.clear()
      processedSections = new WeakSet<ImageSectionLike>()
    },
  }
}
