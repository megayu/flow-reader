import path from './posix-path'
import {
  decodeAssetPath,
  hasEncodedPathSeparators,
  isTauriAssetUrl,
} from './asset-url'
import { stripHrefSuffix } from './href'

/**
 * Creates a Path object for parsing and manipulation of a path strings
 *
 * Uses a polyfill for Nodejs path: https://nodejs.org/api/path.html
 * @param	{string} pathString	a url string (relative or absolute)
 * @class
 */
class Path {
  declare path: string
  declare directory: string
  declare filename: string
  declare extension: string

  constructor(pathString: string) {
    var protocol
    var parsed

    protocol = pathString.indexOf('://')
    if (protocol > -1) {
      const url = new URL(pathString)
      pathString =
        isTauriAssetUrl(url) && hasEncodedPathSeparators(url.pathname)
          ? decodeAssetPath(url.pathname)
          : url.pathname
    } else {
      pathString = stripHrefSuffix(pathString)
    }

    parsed = this.parse(pathString)

    this.path = pathString

    if (this.isDirectory(pathString)) {
      this.directory = pathString
    } else {
      this.directory = parsed.dir + '/'
    }

    this.filename = parsed.base
    this.extension = parsed.ext.slice(1)
  }

  /**
   * Parse the path: https://nodejs.org/api/path.html#path_path_parse_path
   * @param	{string} what
   * @returns {object}
   */
  parse(what: string) {
    return path.parse(what)
  }

  /**
   * @param	{string} what
   * @returns {boolean}
   */
  isAbsolute(what?: string) {
    return path.isAbsolute(what || this.path)
  }

  /**
   * Check if path ends with a directory
   * @param	{string} what
   * @returns {boolean}
   */
  isDirectory(what: string) {
    return what.charAt(what.length - 1) === '/'
  }

  /**
   * Resolve a path against the directory of the Path
   *
   * https://nodejs.org/api/path.html#path_path_resolve_paths
   * @param	{string} what
   * @returns {string} resolved
   */
  resolve(what: string) {
    return path.resolve(this.directory, what)
  }

  /**
   * Resolve a path relative to the directory of the Path
   *
   * https://nodejs.org/api/path.html#path_path_relative_from_to
   * @param	{string} what
   * @returns {string} relative
   */
  relative(what: string) {
    var isAbsolute = what && what.indexOf('://') > -1

    if (isAbsolute) {
      return what
    }

    return path.relative(this.directory, what)
  }

  /**
   * Return the path string
   * @returns {string} path
   */
  toString() {
    return this.path
  }
}

export default Path
