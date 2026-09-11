import type Section from './section'
import type { NavItem } from './navigation'
import type {
  PackagingManifestObject,
  PackagingMetadataObject,
  PackagingJson,
} from './packaging'
import type { RenditionOptions } from './rendition'
import type { Deferred } from './utils/core'
export type BookInput = string | ArrayBuffer | Blob
export interface BookOptions {
  requestMethod?: (
    url: string,
    type?: string,
    withCredentials?: boolean,
    headers?: Record<string, string>,
  ) => Promise<unknown>
  requestCredentials?: boolean
  requestHeaders?: Record<string, string>
  encoding?: string
  replacements?: string
  containerRootUrl?: string
  canonical?: (path: string) => string
  openAs?: string
}
interface LoadedValues {
  manifest: PackagingManifestObject
  spine: Spine
  metadata: PackagingMetadataObject
  cover: string | undefined
  navigation: Navigation
  resources: Resources
  displayOptions: DisplayOptions
}
import EventEmitter from './utils/event-emitter'

import Archive from './archive'
import Container from './container'
import DisplayOptions from './displayoptions'
import Navigation from './navigation'
import Packaging from './packaging'
import Rendition from './rendition'
import Resources from './resources'
import Spine from './spine'
import { EVENTS } from './utils/constants'
import { extend, defer } from './utils/core'
import Path from './utils/path'
import request from './utils/request'
import Url from './utils/url'

const CONTAINER_PATH = 'META-INF/container.xml'

const INPUT_TYPE = {
  BINARY: 'binary',
  BASE64: 'base64',
  EPUB: 'epub',
  OPF: 'opf',
  MANIFEST: 'json',
  DIRECTORY: 'directory',
}

function normalizedNavigationHref(href: string) {
  if (!href) return

  return href.split('#')[0]
}

function decodeNavigationHref(href: string) {
  return href
    .split('/')
    .map((part) => {
      try {
        return decodeURIComponent(part)
      } catch (_error) {
        return part
      }
    })
    .join('/')
}

function encodeNavigationHref(href: string) {
  return href
    .split('/')
    .map((part) => {
      if (!part || part === '.' || part === '..') {
        return part
      }

      return encodeURIComponent(part).replace(/\*/g, '%2A')
    })
    .join('/')
}

function splitHrefSuffix(href: string) {
  let hashIndex = href.indexOf('#')
  let queryIndex = href.indexOf('?')
  let suffixIndex =
    hashIndex === -1
      ? queryIndex
      : queryIndex === -1
        ? hashIndex
        : Math.min(hashIndex, queryIndex)

  return suffixIndex === -1
    ? { path: href, suffix: '' }
    : { path: href.slice(0, suffixIndex), suffix: href.slice(suffixIndex) }
}

function normalizePathSegments(path: string) {
  let parts: string[] = []

  path
    .replace(/\\/g, '/')
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

function resolveNavigationHrefFromNavPath(href: string, navPath: string) {
  if (!href || !navPath || href.charAt(0) === '#') return href
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.indexOf('//') === 0) {
    return href
  }

  let { path, suffix } = splitHrefSuffix(href)
  if (!path || path.charAt(0) === '/')
    return normalizePathSegments(path) + suffix

  let navDir = normalizedNavigationHref(navPath)
  navDir =
    navDir && navDir.indexOf('/') > -1
      ? navDir.slice(0, navDir.lastIndexOf('/'))
      : ''

  return normalizePathSegments(navDir ? `${navDir}/${path}` : path) + suffix
}

function addReadableSectionHref(index: Set<string>, href: string) {
  let normalized = normalizedNavigationHref(href)
  if (!normalized) return

  index.add(normalized)
  index.add(encodeURI(normalized))
  index.add(encodeNavigationHref(normalized))
  index.add(decodeNavigationHref(normalized))
}

function readableSectionHrefIndex(sections: Section[]) {
  let index = new Set<string>()

  sections.forEach((section) => {
    if (section && section.linear && section.resourceAvailable !== false) {
      addReadableSectionHref(index, section.href)
      section.hrefAliases.forEach((href) => {
        addReadableSectionHref(index, href)
      })
    }
  })

  return index
}

function navigationHrefMatchesReadableSection(
  readableHrefs: Set<string>,
  href: string,
) {
  let normalized = normalizedNavigationHref(href)
  if (!normalized) return false

  if (
    readableHrefs.has(normalized) ||
    readableHrefs.has(encodeURI(normalized)) ||
    readableHrefs.has(encodeNavigationHref(normalized)) ||
    readableHrefs.has(decodeNavigationHref(normalized))
  ) {
    return true
  }

  return false
}

function normalizeNavigationHrefsBySpine(
  items: NavItem[],
  readableHrefs: Set<string>,
  navPath?: string | false | null,
) {
  if (!items || !navPath) return

  items.forEach((item) => {
    if (
      item.href &&
      !navigationHrefMatchesReadableSection(readableHrefs, item.href)
    ) {
      let resolved = resolveNavigationHrefFromNavPath(item.href, navPath)
      if (navigationHrefMatchesReadableSection(readableHrefs, resolved)) {
        item.href = resolved
      }
    }

    normalizeNavigationHrefsBySpine(item.subitems, readableHrefs, navPath)
  })
}

/**
 * An Epub representation with methods for the loading, parsing and manipulation
 * of its contents.
 * @class
 * @param {string} [url]
 * @param {object} [options]
 * @param {method} [options.requestMethod] a request function to use instead of the default
 * @param {boolean} [options.requestCredentials=undefined] send the xhr request withCredentials
 * @param {object} [options.requestHeaders=undefined] send the xhr request headers
 * @param {string} [options.encoding=binary] optional to pass 'binary' or base64' for archived Epubs
 * @param {string} [options.replacements=none] use base64, blobUrl, or none for replacing assets in archived Epubs
 * @param {string} [options.containerRootUrl] root URL that bounds resources in an unarchived EPUB container
 * @param {method} [options.canonical] optional function to determine canonical urls for a path
 * @param {string} [options.openAs] optional string to determine the input type
 * @returns {Book}
 * @example new Book("/path/to/book.epub", {})
 * @example new Book({ replacements: "blobUrl" })
 */
class Book extends EventEmitter<{ openFailed: [Error] }> {
  declare settings: BookOptions
  declare opening: Deferred<Book>
  declare opened: Promise<Book>
  declare isOpen: boolean
  declare isRendered: boolean
  declare loading: { [K in keyof LoadedValues]: Deferred<LoadedValues[K]> }
  declare loaded: { [K in keyof LoadedValues]: Promise<LoadedValues[K]> }
  declare ready: Promise<unknown[]>
  declare request: NonNullable<BookOptions['requestMethod']>
  declare spine: Spine
  declare navigation: Navigation
  declare url: Url
  declare path: Path
  declare archived: boolean
  declare archive: Archive | undefined
  declare resources: Resources
  declare rendition: Rendition | undefined
  declare container: Container
  declare packaging: Packaging
  declare package: Packaging
  declare displayOptions: DisplayOptions
  declare cover: string | undefined

  constructor(url?: BookInput | BookOptions, options?: BookOptions) {
    super()

    // Allow passing just options to the Book
    if (
      typeof options === 'undefined' &&
      typeof url !== 'string' &&
      url instanceof Blob === false &&
      url instanceof ArrayBuffer === false
    ) {
      options = url as BookOptions | undefined
      url = undefined
    }

    this.settings = extend(this.settings || {}, {
      requestMethod: undefined,
      requestCredentials: undefined,
      requestHeaders: undefined,
      encoding: undefined,
      replacements: undefined,
      containerRootUrl: undefined,
      canonical: undefined,
      openAs: undefined,
    })

    extend(this.settings, options)

    // Promises
    this.opening = new defer<Book>()
    /**
     * @member {promise} opened returns after the book is loaded
     * @memberof Book
     */
    this.opened = this.opening.promise
    this.isOpen = false

    this.loading = {
      manifest: new defer<LoadedValues['manifest']>(),
      spine: new defer<LoadedValues['spine']>(),
      metadata: new defer<LoadedValues['metadata']>(),
      cover: new defer<LoadedValues['cover']>(),
      navigation: new defer<LoadedValues['navigation']>(),
      resources: new defer<LoadedValues['resources']>(),
      displayOptions: new defer<LoadedValues['displayOptions']>(),
    }

    this.loaded = {
      manifest: this.loading.manifest.promise,
      spine: this.loading.spine.promise,
      metadata: this.loading.metadata.promise,
      cover: this.loading.cover.promise,
      navigation: this.loading.navigation.promise,
      resources: this.loading.resources.promise,
      displayOptions: this.loading.displayOptions.promise,
    }

    /**
     * @member {promise} ready returns after the book is loaded and parsed
     * @memberof Book
     * @private
     */
    this.ready = Promise.all([
      this.loaded.manifest,
      this.loaded.spine,
      this.loaded.metadata,
      this.loaded.cover,
      this.loaded.navigation,
      this.loaded.resources,
      this.loaded.displayOptions,
    ])

    // Queue for methods used before opening
    this.isRendered = false
    // this._q = queue(this);

    /**
     * @member {method} request
     * @memberof Book
     * @private
     */
    this.request = this.settings.requestMethod || request

    /**
     * @member {Spine} spine
     * @memberof Book
     */
    this.spine = new Spine()

    /**
     * @member {Navigation} navigation
     * @memberof Book
     */
    this.navigation = undefined!

    /**
     * @member {Url} url
     * @memberof Book
     * @private
     */
    this.url = undefined!

    /**
     * @member {Path} path
     * @memberof Book
     * @private
     */
    this.path = undefined!

    /**
     * @member {boolean} archived
     * @memberof Book
     * @private
     */
    this.archived = false

    /**
     * @member {Archive} archive
     * @memberof Book
     * @private
     */
    this.archive = undefined

    /**
     * @member {Resources} resources
     * @memberof Book
     * @private
     */
    this.resources = undefined!

    /**
     * @member {Rendition} rendition
     * @memberof Book
     * @private
     */
    this.rendition = undefined

    /**
     * @member {Container} container
     * @memberof Book
     * @private
     */
    this.container = undefined!

    /**
     * @member {Packaging} packaging
     * @memberof Book
     * @private
     */
    this.packaging = undefined!

    /**
     * @member {DisplayOptions} displayOptions
     * @memberof DisplayOptions
     * @private
     */
    this.displayOptions = undefined!

    // this.toc = undefined;
    if (url) {
      this.open(url as BookInput, this.settings.openAs).catch((error) => {
        var err = new Error('Cannot load book at ' + url)
        this.emit(EVENTS.BOOK.OPEN_FAILED, err)
      })
    }
  }

  /**
   * Open a epub or url
   * @param {string | ArrayBuffer} input Url, Path or ArrayBuffer
   * @param {string} [what="binary", "base64", "epub", "opf", "json", "directory"] force opening as a certain type
   * @returns {Promise} of when the book has been loaded
   * @example book.open("/path/to/book.epub")
   */
  open(input: BookInput, what?: string) {
    var opening
    var type = what || this.determineType(input)

    if (type === INPUT_TYPE.BINARY) {
      this.archived = true
      this.url = new Url('/', '')
      opening = this.openEpub(input)
    } else if (type === INPUT_TYPE.BASE64) {
      this.archived = true
      this.url = new Url('/', '')
      opening = this.openEpub(input, type)
    } else if (type === INPUT_TYPE.EPUB) {
      this.archived = true
      this.url = new Url('/', '')
      opening = this.request(
        input as string,
        'binary',
        this.settings.requestCredentials,
        this.settings.requestHeaders,
      ).then(this.openEpub.bind(this) as (data: unknown) => Promise<void>)
    } else if (type == INPUT_TYPE.OPF) {
      this.url = new Url(input as string)
      opening = this.openPackaging(this.url.Path.toString())
    } else if (type == INPUT_TYPE.MANIFEST) {
      this.url = new Url(input as string)
      opening = this.openManifest(this.url.Path.toString())
    } else {
      this.url = new Url(input as string)
      opening = this.openContainer(CONTAINER_PATH).then(
        this.openPackaging.bind(this),
      )
    }

    return opening
  }

  /**
   * Open an archived epub
   * @private
   * @param  {binary} data
   * @param  {string} [encoding]
   * @return {Promise}
   */
  openEpub(data: BookInput, encoding?: string) {
    return this.unarchive(data, encoding || this.settings.encoding)
      .then(() => {
        return this.openContainer(CONTAINER_PATH)
      })
      .then((packagePath) => {
        return this.openPackaging(packagePath)
      })
  }

  /**
   * Open the epub container
   * @private
   * @param  {string} url
   * @return {string} packagePath
   */
  openContainer(url: string) {
    return this.load(url).then((xml) => {
      this.container = new Container(xml as Document)
      return this.resolve(this.container.packagePath!)!
    })
  }

  /**
   * Open the Open Packaging Format Xml
   * @private
   * @param  {string} url
   * @return {Promise}
   */
  openPackaging(url: string) {
    this.path = new Path(url)
    return this.load(url).then((xml) => {
      this.packaging = new Packaging(xml as Document)
      return this.unpack(this.packaging)
    })
  }

  /**
   * Open the manifest JSON
   * @private
   * @param  {string} url
   * @return {Promise}
   */
  openManifest(url: string) {
    this.path = new Path(url)
    return this.load(url).then((json) => {
      this.packaging = new Packaging()
      this.packaging.load(json as PackagingJson)
      return this.unpack(this.packaging)
    })
  }

  /**
   * Load a resource from the Book
   * @param  {string} path path to the resource to load
   * @param  {string} [type] resource type override
   * @return {Promise}     returns a promise with the requested resource
   */
  load(path: string, type?: string) {
    var resolved = this.resolve(path)
    if (this.archived) {
      return this.archive!.request(resolved!, type)
    } else {
      return this.request(
        resolved!,
        type,
        this.settings.requestCredentials,
        this.settings.requestHeaders,
      )
    }
  }

  /**
   * Resolve a path to it's absolute position in the Book
   * @param  {string} path
   * @param  {boolean} [absolute] force resolving the full URL
   * @return {string}          the resolved path string
   */
  resolve(path: string, absolute?: boolean) {
    if (!path) {
      return
    }
    var resolved = path
    var isAbsolute = path.indexOf('://') > -1

    if (isAbsolute) {
      return path
    }

    if (this.path) {
      resolved = this.path.resolve(path)
    }

    if (absolute != false && this.url) {
      resolved = this.url.resolve(resolved)
    }

    return resolved
  }

  /**
   * Get a canonical link to a path
   * @param  {string} path
   * @return {string} the canonical path string
   */
  canonical(path: string) {
    var url = path

    if (!path) {
      return ''
    }

    if (this.settings.canonical) {
      url = this.settings.canonical(path)
    } else {
      url = this.resolve(path, true)!
    }

    return url
  }

  /**
   * Determine the type of they input passed to open
   * @private
   * @param  {string} input
   * @return {string}  binary | directory | epub | opf
   */
  determineType(input: BookInput) {
    var url
    var path
    var extension

    if (this.settings.encoding === 'base64') {
      return INPUT_TYPE.BASE64
    }

    if (typeof input != 'string') {
      return INPUT_TYPE.BINARY
    }

    url = new Url(input as string)
    path = url.path()
    extension = path.extension

    // If there's a search string, remove it before determining type
    if (extension) {
      extension = extension.replace(/\?.*$/, '')
    }

    if (!extension) {
      return INPUT_TYPE.DIRECTORY
    }

    if (extension === 'epub') {
      return INPUT_TYPE.EPUB
    }

    if (extension === 'opf') {
      return INPUT_TYPE.OPF
    }

    if (extension === 'json') {
      return INPUT_TYPE.MANIFEST
    }
  }

  /**
   * unpack the contents of the Books packaging
   * @private
   * @param {Packaging} packaging object
   */
  unpack(packaging: Packaging) {
    this.package = packaging

    this.displayOptions = new DisplayOptions()
    this.loading.displayOptions.resolve(this.displayOptions)

    this.spine.unpack(
      this.packaging,
      this.resolve.bind(this) as (path: string, absolute?: boolean) => string,
      this.canonical.bind(this),
    )

    this.resources = new Resources(this.packaging.manifest, {
      archive: this.archive,
      resolver: this.resolve.bind(this) as (path: string) => string,
      request: this.request.bind(this),
      rootUrl: this.packageRootUrl(),
      containerRootUrl: this.settings.containerRootUrl,
      replacements:
        this.settings.replacements || (this.archived ? 'blobUrl' : 'none'),
    })

    if (!this.archived) {
      this.spine.hooks.content.register(
        this.resources.resolveSectionResourceUrls.bind(this.resources),
      )
    }

    this.loadNavigation(this.packaging).then(() => {
      this.filterNavigationBySpine(this.packaging)
      // this.toc = this.navigation.toc;
      this.loading.navigation.resolve(this.navigation)
    })

    if (this.packaging.coverPath) {
      this.cover = this.resolve(this.packaging.coverPath)
    }
    // Resolve promises
    this.loading.manifest.resolve(this.packaging.manifest)
    this.loading.metadata.resolve(this.packaging.metadata)
    this.loading.spine.resolve(this.spine)
    this.loading.cover.resolve(this.cover)
    this.loading.resources.resolve(this.resources)

    this.isOpen = true

    if (
      this.archived ||
      (this.settings.replacements && this.settings.replacements != 'none')
    ) {
      this.replacements()
        .then(() => {
          this.loaded.displayOptions.then(() => {
            this.opening.resolve(this)
          })
        })
        .catch((err) => {
          console.error(err)
        })
    } else {
      // Resolve book opened promise
      this.loaded.displayOptions.then(() => {
        this.opening.resolve(this)
      })
    }
  }

  /**
   * Load navigation from package
   * @private
   * @param {Packaging} packaging
   */
  loadNavigation(packaging: Packaging) {
    let navPath = packaging.navPath || packaging.ncxPath
    let toc = packaging.toc

    // From json manifest
    if (toc) {
      return new Promise<Navigation>((resolve, reject) => {
        this.navigation = new Navigation(toc)

        resolve(this.navigation)
      })
    }

    if (!navPath) {
      return new Promise((resolve, reject) => {
        this.navigation = new Navigation()

        resolve(this.navigation)
      })
    }

    return this.load(navPath, 'xml').then((xml) => {
      this.navigation = new Navigation(xml as Document)
      return this.navigation
    })
  }

  /**
   * Remove navigation entries that do not point at readable spine sections.
   * @private
   */
  filterNavigationBySpine(packaging: Packaging) {
    if (!this.navigation || !this.navigation.filter || !this.spine) {
      return
    }

    let readableHrefs = readableSectionHrefIndex(this.spine.spineItems)
    let navPath = packaging && (packaging.navPath || packaging.ncxPath)

    normalizeNavigationHrefsBySpine(this.navigation.toc, readableHrefs, navPath)

    this.navigation.filter((item) => {
      if (!item.href) {
        return true
      }

      return navigationHrefMatchesReadableSection(readableHrefs, item.href)
    })
  }

  /**
   * Gets a Section of the Book from the Spine
   * Alias for `book.spine.get`
   * @param {string} target
   * @return {Section}
   */
  section(target?: string | number) {
    return this.spine.get(target)
  }

  /**
   * Create and attach the book's rendering session.
   * @param  {Element} element reader container
   * @param  {object} [options]
   * @return {Promise<Rendition>}
   */
  async renderTo(element: HTMLElement, options?: RenditionOptions) {
    this.rendition?.destroy()
    const rendition = new Rendition(this, options)
    this.rendition = rendition
    await rendition.attachTo(element)
    return rendition
  }

  /**
   * Unarchive a zipped epub
   * @private
   * @param  {binary} input epub data
   * @param  {string} [encoding]
   * @return {Archive}
   */
  unarchive(input: BookInput, encoding?: string) {
    this.archive = new Archive()
    return this.archive.open(input, encoding)
  }

  /**
   * Load replacement urls
   * @private
   * @return {Promise} completed loading urls
   */
  replacements() {
    this.spine.hooks.serialize.register((output, section) => {
      section.output = this.resources.substitute(output, section.url)
      return this.resources
        .substituteMissingMedia(section.output, section.url)
        .then((output) => {
          section.output = output
        })
    })

    return this.resources.replacements().then(() => {
      return this.resources.replaceCss()
    })
  }

  /**
   * Destroy the Book and all associated objects
   */
  destroy() {
    this.rendition?.destroy()
    this.opened = undefined!
    this.loading = undefined!
    this.loaded = undefined!
    this.ready = undefined!

    this.isOpen = false
    this.isRendered = false

    this.spine && this.spine.destroy()
    this.archive && this.archive.destroy()
    this.resources && this.resources.destroy()
    this.container && this.container.destroy()
    this.packaging && this.packaging.destroy()
    this.displayOptions && this.displayOptions.destroy()

    this.spine = undefined!
    this.archive = undefined
    this.resources = undefined!
    this.container = undefined!
    this.packaging = undefined!
    this.package = undefined!
    this.rendition = undefined

    this.navigation = undefined!
    this.url = undefined!
    this.path = undefined!
    this.archived = false
    this.removeAllListeners()
  }

  packageRootUrl() {
    if (!this.path || !this.url) {
      return
    }

    if (this.path.isAbsolute(this.path.directory)) {
      return ensureDirectoryUrl(this.url.resolve('.'))
    }

    return ensureDirectoryUrl(this.url.resolve(this.path.directory || '.'))
  }
}

export default Book

function ensureDirectoryUrl(url: string) {
  if (!url || url.charAt(url.length - 1) === '/') {
    return url
  }

  return url + '/'
}
