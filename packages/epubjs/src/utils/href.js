export function decodeHref(href) {
  if (!href) {
    return href
  }

  try {
    return decodeURIComponent(href)
  } catch (_error) {
    return href
  }
}
