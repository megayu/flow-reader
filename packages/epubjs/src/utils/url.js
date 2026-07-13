import path from './posix-path'

import Path from './path'

function isTauriAssetUrl(url) {
  return (
    url &&
    ((url.protocol === 'asset:' && url.hostname === 'localhost') ||
      (url.protocol === 'http:' && url.hostname === 'asset.localhost'))
  )
}

function hasEncodedPathSeparators(pathname) {
  return /%2f|%5c/i.test(pathname)
}

function decodeAssetPath(pathname) {
  var encodedPath = pathname.charAt(0) === '/' ? pathname.slice(1) : pathname
  var decodedPath = window.decodeURIComponent(encodedPath).replace(/\\/g, '/')

  return decodedPath.charAt(0) === '/' ? decodedPath : '/' + decodedPath
}

function encodeAssetPath(pathname, encodeLeadingSlash) {
  var normalized = pathname.replace(/\\/g, '/')

  if (!encodeLeadingSlash && normalized.charAt(0) === '/') {
    normalized = normalized.slice(1)
  }

  return '/' + window.encodeURIComponent(normalized)
}

/**
 * creates a Url object for parsing and manipulation of a url string
 * @param	{string} urlString	a url string (relative or absolute)
 * @param	{string} [baseString] optional base for the url,
 * default to window.location.href
 */
class Url {
  constructor(urlString, baseString) {
    var absolute = urlString.indexOf('://') > -1
    var pathname = urlString
    var basePath

    this.Url = undefined
    this.href = urlString
    this.protocol = ''
    this.origin = ''
    this.hash = ''
    this.hash = ''
    this.search = ''
    this.base = baseString
    this.encodedAssetPath = false

    if (
      !absolute &&
      baseString !== false &&
      typeof baseString !== 'string' &&
      window &&
      window.location
    ) {
      this.base = window.location.href
    }

    // URL Polyfill doesn't throw an error if base is empty
    if (absolute || this.base) {
      try {
        if (this.base) {
          // Safari doesn't like an undefined base
          this.Url = new URL(urlString, this.base)
        } else {
          this.Url = new URL(urlString)
        }
        this.href = this.Url.href

        this.protocol = this.Url.protocol
        this.origin =
          this.Url.origin === 'null' && this.Url.protocol === 'asset:'
            ? `${this.Url.protocol}//${this.Url.host}`
            : this.Url.origin
        this.hash = this.Url.hash
        this.search = this.Url.search

        pathname = this.Url.pathname + (this.Url.search ? this.Url.search : '')
        this.encodedAssetPath =
          isTauriAssetUrl(this.Url) &&
          hasEncodedPathSeparators(this.Url.pathname)
        if (this.encodedAssetPath) {
          pathname =
            decodeAssetPath(this.Url.pathname) +
            (this.Url.search ? this.Url.search : '')
        }
      } catch (e) {
        // Skip URL parsing
        this.Url = undefined
        // resolve the pathname from the base
        if (this.base) {
          basePath = new Path(this.base)
          pathname = basePath.resolve(pathname)
        }
      }
    }

    this.Path = new Path(pathname)

    this.directory = this.Path.directory
    this.filename = this.Path.filename
    this.extension = this.Path.extension
  }

  /**
   * @returns {Path}
   */
  path() {
    return this.Path
  }

  /**
   * Resolves a relative path to a absolute url
   * @param {string} what
   * @returns {string} url
   */
  resolve(what) {
    var isAbsolute = what.indexOf('://') > -1
    var fullpath

    if (isAbsolute) {
      return what
    }

    fullpath = path.resolve(this.directory, what)

    if (this.encodedAssetPath) {
      return this.origin + encodeAssetPath(fullpath, this.protocol === 'asset:')
    }

    return this.origin + fullpath
  }

  /**
   * Resolve a path relative to the url
   * @param {string} what
   * @returns {string} path
   */
  relative(what) {
    return path.relative(what, this.directory)
  }

  /**
   * @returns {string}
   */
  toString() {
    return this.href
  }
}

export default Url
