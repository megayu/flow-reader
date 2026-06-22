export interface HrefSectionLike {
  href?: string
  canonical?: string
}

export function safeDecodeHref(text: string) {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}

export function normalizeHrefPath(href: string | undefined) {
  if (!href) return ''

  return normalizePathSegments(
    safeDecodeHref(href)
      .split('#')[0]!
      .replace(/\\/g, '/')
      .replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i, ''),
  )
}

export function resolveLinkedHrefPath(
  baseHref: string | undefined,
  linkedPath: string,
) {
  const path = normalizeHrefPath(linkedPath)
  if (!path) return normalizeHrefPath(baseHref)
  if (linkedPath.startsWith('/')) return path

  const base = normalizeHrefPath(baseHref)
  const baseDir = base.includes('/') ? base.slice(0, base.lastIndexOf('/')) : ''

  return normalizePathSegments(
    baseDir ? `${baseDir}/${linkedPath}` : linkedPath,
  )
}

export function sameHref(a: string | undefined, b: string | undefined) {
  const na = normalizeHrefPath(a)
  const nb = normalizeHrefPath(b)

  if (!na || !nb) return false

  return na === nb || na.endsWith(`/${nb}`) || nb.endsWith(`/${na}`)
}

export function findSectionByLinkedHref<T extends HrefSectionLike>(
  sections: T[] | undefined,
  baseHref: string | undefined,
  linkedPath: string,
) {
  if (!sections?.length) return

  const resolved = resolveLinkedHrefPath(baseHref, linkedPath)
  if (!resolved) return

  return (
    sections.find((section) => normalizeHrefPath(section.href) === resolved) ??
    sections.find(
      (section) => normalizeHrefPath(section.canonical) === resolved,
    ) ??
    sections.find(
      (section) =>
        sameHref(section.href, resolved) ||
        sameHref(section.canonical, resolved),
    )
  )
}

function normalizePathSegments(path: string) {
  const [pathname = ''] = path.split(/[?#]/)
  const parts: string[] = []

  pathname
    .replace(/^\/+/, '')
    .split('/')
    .forEach((part) => {
      if (!part || part === '.') return
      if (part === '..') {
        parts.pop()
        return
      }
      parts.push(part)
    })

  return parts.join('/')
}
