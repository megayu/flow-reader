export function isTauriAssetUrl(url) {
  return (
    url &&
    ((url.protocol === 'asset:' && url.hostname === 'localhost') ||
      (url.protocol === 'http:' && url.hostname === 'asset.localhost'))
  )
}

export function hasEncodedPathSeparators(pathname) {
  return /%2f|%5c/i.test(pathname)
}

export function decodeAssetPath(pathname) {
  var encodedPath = pathname.charAt(0) === '/' ? pathname.slice(1) : pathname
  var decodedPath = window.decodeURIComponent(encodedPath).replace(/\\/g, '/')

  return decodedPath.charAt(0) === '/' ? decodedPath : '/' + decodedPath
}

export function encodeAssetPath(pathname, encodeLeadingSlash) {
  var normalized = pathname.replace(/\\/g, '/')

  if (!encodeLeadingSlash && normalized.charAt(0) === '/') {
    normalized = normalized.slice(1)
  }

  return '/' + window.encodeURIComponent(normalized)
}
