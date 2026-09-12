export function decodeHref(href: string): string
export function decodeHref(href: string | null): string | null
export function decodeHref(href: string | null) {
  if (!href) {
    return href
  }

  try {
    return decodeURIComponent(href)
  } catch (_error) {
    return href
  }
}

export function stripHrefSuffix(href: string) {
  const queryIndex = href.indexOf('?')
  const hashIndex = href.indexOf('#')
  const suffixIndex =
    queryIndex === -1 ? hashIndex : hashIndex === -1 ? queryIndex : Math.min(queryIndex, hashIndex)

  return suffixIndex === -1 ? href : href.slice(0, suffixIndex)
}

export function decodeHrefPathSegments(href: string) {
  return href
    .split('/')
    .map((part) => {
      try {
        return decodeURIComponent(part)
      } catch {
        return part
      }
    })
    .join('/')
}

export function encodeHrefPathSegments(href: string) {
  return href
    .split('/')
    .map((part) => {
      if (!part || part === '.' || part === '..') return part

      return encodeURIComponent(part).replace(/\*/g, '%2A')
    })
    .join('/')
}
