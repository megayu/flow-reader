/**
 * Resolve at most one manifest fallback. Multi-step chains are intentionally
 * ignored so malformed publications cannot create unbounded or cyclic work.
 * @param {object} manifest
 * @param {object} item
 * @param {(mediaType: string) => boolean} supports
 * @returns {object|undefined}
 */
export function resolveDirectFallback(manifest, item, supports) {
  if (!item || !item.type || supports(item.type)) {
    return item
  }

  var fallback = item.fallback && manifest[item.fallback]

  if (!fallback || fallback === item || !supports(fallback.type)) {
    return
  }

  return fallback
}
