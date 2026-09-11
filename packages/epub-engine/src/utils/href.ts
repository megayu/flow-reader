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
