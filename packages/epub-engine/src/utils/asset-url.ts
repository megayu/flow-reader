export function isTauriAssetUrl(
  url: Pick<URL, 'protocol' | 'hostname'>,
): boolean
export function isTauriAssetUrl(
  url: Pick<URL, 'protocol' | 'hostname'> | null | undefined,
): boolean | null | undefined
export function isTauriAssetUrl(
  url: Pick<URL, 'protocol' | 'hostname'> | null | undefined,
) {
  return (
    url &&
    ((url.protocol === 'asset:' && url.hostname === 'localhost') ||
      (url.protocol === 'http:' && url.hostname === 'asset.localhost'))
  )
}

export function hasEncodedPathSeparators(pathname: string) {
  return /%2f|%5c/i.test(pathname)
}

export function decodeAssetPath(pathname: string) {
  var encodedPath = pathname.charAt(0) === '/' ? pathname.slice(1) : pathname
  var decodedPath = window.decodeURIComponent(encodedPath).replace(/\\/g, '/')

  return decodedPath.charAt(0) === '/' ? decodedPath : '/' + decodedPath
}

export function encodeAssetPath(
  pathname: string,
  encodeLeadingSlash?: boolean,
) {
  var normalized = pathname.replace(/\\/g, '/')

  if (!encodeLeadingSlash && normalized.charAt(0) === '/') {
    normalized = normalized.slice(1)
  }

  return '/' + window.encodeURIComponent(normalized)
}
