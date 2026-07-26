import path from './utils/posix-path'

import {
  createBase64Url,
  createBlobUrl,
  revokeBlobUrl,
  blob2base64,
} from './utils/core'
import mime from './utils/mime'
import Path from './utils/path'
import { resolveDirectFallback } from './utils/fallback'
import { substitute } from './utils/replacements'
import Url from './utils/url'

/**
 * Handle Package Resources
 * @class
 * @param {Manifest} manifest
 * @param {object} [options]
 * @param {string} [options.replacements="base64"]
 * @param {Archive} [options.archive]
 * @param {method} [options.resolver]
 * @param {string} [options.rootUrl]
 * @param {string} [options.containerRootUrl]
 */
class Resources {
  constructor(manifest, options) {
    this.settings = {
      replacements: (options && options.replacements) || 'base64',
      archive: options && options.archive,
      resolver: options && options.resolver,
      request: options && options.request,
      rootUrl: options && options.rootUrl,
      containerRootUrl: options && options.containerRootUrl,
    }
    this.ownedBlobUrls = new Set()

    this.process(manifest)
  }

  createOwnedBlobUrl(content, mime) {
    var url = createBlobUrl(content, mime)
    if (url) {
      this.ownedBlobUrls.add(url)
    }
    return url
  }

  /**
   * Process resources
   * @param {Manifest} manifest
   */
  process(manifest) {
    this.manifest = manifest
    this.resources = Object.keys(manifest).map(function (key) {
      return manifest[key]
    })

    this.replacementUrls = []

    this.html = []
    this.assets = []
    this.css = []

    this.urls = []
    this.cssUrls = []
    this.resolvedCssUrls = Object.create(null)

    this.split()
    this.splitUrls()
    this.replacementSourceUrls = this.directImageFallbacks
      ? this.urls.map((url) => this.directImageFallbacks[url] || url)
      : this.urls
    this.fallbackUrlIndexes = this.directImageFallbacks
      ? Object.create(null)
      : undefined
  }

  /**
   * Split resources by type
   * @private
   */
  split() {
    this.directImageFallbacks = undefined

    this.resources.forEach((item) => {
      if (item.type === 'application/xhtml+xml' || item.type === 'text/html') {
        this.html.push(item)
      } else {
        this.assets.push(item)
      }

      if (item.type === 'text/css') {
        this.css.push(item)
      }

      if (!item.fallback) {
        return
      }

      var fallback = resolveDirectFallback(
        this.manifest,
        item,
        isSupportedImageMediaType,
      )

      if (fallback && fallback !== item && item.href && fallback.href) {
        this.directImageFallbacks =
          this.directImageFallbacks || Object.create(null)
        this.directImageFallbacks[item.href] = fallback.href
      }
    })
  }

  /**
   * Convert split resources into Urls
   * @private
   */
  splitUrls() {
    // All Assets Urls
    this.urls = this.assets.map(
      function (item) {
        return item.href
      }.bind(this),
    )

    // Css Urls
    this.cssUrls = this.css.map(function (item) {
      return item.href
    })
  }

  /**
   * Create a url to a resource
   * @param {string} url
   * @return {Promise<string>} Promise resolves with url string
   */
  createUrl(url) {
    var parsedUrl = new Url(url)
    var mimeType = mime.lookup(parsedUrl.filename)

    if (this.settings.archive) {
      return this.settings.archive.createUrl(url, {
        base64: this.settings.replacements === 'base64',
      })
    } else {
      if (this.settings.replacements === 'base64') {
        return this.settings
          .request(url, 'blob')
          .then((blob) => {
            return blob2base64(blob)
          })
          .then((blob) => {
            return createBase64Url(blob, mimeType)
          })
      } else {
        return this.settings.request(url, 'blob').then((blob) => {
          return this.createOwnedBlobUrl(blob, mimeType)
        })
      }
    }
  }

  /**
   * Create blob urls for all the assets
   * @return {Promise}         returns replacement urls
   */
  replacements() {
    if (this.settings.replacements === 'none') {
      return new Promise(
        function (resolve) {
          resolve(this.urls)
        }.bind(this),
      )
    }

    var replacementsByUrl = Object.create(null)
    var replacements = this.replacementSourceUrls.map((url) => {
      var absolute = this.settings.resolver(url)

      if (!replacementsByUrl[absolute]) {
        replacementsByUrl[absolute] = this.createUrl(absolute).catch((err) => {
          console.error(err)
          return null
        })
      }

      return replacementsByUrl[absolute]
    })

    return Promise.all(replacements).then((replacementUrls) => {
      this.replacementUrls = replacementUrls
      return replacementUrls
    })
  }

  /**
   * Replace URLs in CSS resources
   * @private
   * @param  {Archive} [archive]
   * @param  {method} [resolver]
   * @return {Promise}
   */
  replaceCss(archive, resolver) {
    var replaced = []
    archive = archive || this.settings.archive
    resolver = resolver || this.settings.resolver
    this.cssUrls.forEach(
      function (href) {
        var replacement = this.createCssFile(href, archive, resolver).then(
          function (replacementUrl) {
            // switch the url in the replacementUrls
            var indexInUrls = this.urls.indexOf(href)
            if (indexInUrls > -1) {
              this.replacementUrls[indexInUrls] = replacementUrl
            }
          }.bind(this),
        )

        replaced.push(replacement)
      }.bind(this),
    )
    return Promise.all(replaced)
  }

  /**
   * Create a new CSS file with the replaced URLs
   * @private
   * @param  {string} href the original css file
   * @return {Promise}  returns a BlobUrl to the new CSS file or a data url
   */
  createCssFile(href) {
    var newUrl

    if (path.isAbsolute(href)) {
      return new Promise(function (resolve) {
        resolve()
      })
    }

    var absolute = this.settings.resolver(href)

    // Get the text of the css file from the archive
    var textResponse

    if (this.settings.archive) {
      textResponse = this.settings.archive.getText(absolute)
    } else {
      textResponse = this.settings.request(absolute, 'text')
    }

    // Get asset links relative to css file
    var relUrls = this.urls.map((assetHref) => {
      var resolved = this.settings.resolver(assetHref)
      var relative = new Path(absolute).relative(resolved)

      return relative
    })

    if (!textResponse) {
      // file not found, don't replace
      return new Promise(function (resolve) {
        resolve()
      })
    }

    return textResponse.then(
      (text) => {
        // Replacements in the css text
        var cssSubstitutions = createSubstitutionUrls(
          relUrls,
          this.replacementUrls,
        )
        text = substitute(
          text,
          cssSubstitutions.urls,
          cssSubstitutions.replacements,
        )

        // Get the new url
        if (this.settings.replacements === 'base64') {
          newUrl = createBase64Url(text, 'text/css')
        } else {
          newUrl = this.createOwnedBlobUrl(text, 'text/css')
        }

        return newUrl
      },
      (err) => {
        // handle response errors
        return new Promise(function (resolve) {
          resolve()
        })
      },
    )
  }

  /**
   * Resolve all resources URLs relative to an absolute URL
   * @param  {string} absolute to be resolved to
   * @param  {resolver} [resolver]
   * @return {string[]} array with relative Urls
   */
  relativeTo(absolute, resolver) {
    resolver = resolver || this.settings.resolver

    // Get Urls relative to current sections
    return this.urls.map(
      function (href) {
        var resolved = resolver(href)
        var relative = new Path(absolute).relative(resolved)
        return relative
      }.bind(this),
    )
  }

  /**
   * Get a URL for a resource
   * @param  {string} path
   * @return {string} url
   */
  get(path) {
    var indexInUrls = this.urls.indexOf(path)
    if (indexInUrls === -1) {
      return
    }
    if (this.replacementUrls.length && this.replacementUrls[indexInUrls]) {
      return new Promise(
        function (resolve, reject) {
          resolve(this.replacementUrls[indexInUrls])
        }.bind(this),
      )
    } else {
      return this.createUrl(this.replacementSourceUrls[indexInUrls])
    }
  }

  /**
   * Substitute urls in content, with replacements,
   * relative to a url if provided
   * @param  {string} content
   * @param  {string} [url]   url to resolve to
   * @return {string}         content with urls substituted
   */
  substitute(content, url) {
    var relUrls
    if (url) {
      relUrls = this.relativeTo(url)
    } else {
      relUrls = this.urls
    }
    var substitutions = createSubstitutionUrls(relUrls, this.replacementUrls)
    return substitute(content, substitutions.urls, substitutions.replacements)
  }

  /**
   * Resolve local resource references in a section document without preloading
   * every manifest asset. This keeps the unarchived Tauri path lazy while
   * preventing srcdoc iframes from resolving relative paths against
   * asset.localhost/.
   * @param  {document} doc section document
   * @param  {Section} section current section
   * @return {Promise<void>}
   */
  resolveSectionResourceUrls(doc, section) {
    if (!doc || !section || !section.url) {
      return Promise.resolve()
    }

    var sectionUrl = new Url(section.url)
    var packageRootUrl = resolvePackageRootUrl(
      this.settings.rootUrl,
      section,
      sectionUrl,
    )
    var containerRootUrl = resolveContainerRootUrl(
      this.settings.containerRootUrl,
      packageRootUrl,
    )

    if (packageRootUrl && section.href) {
      sectionUrl = new Url(packageRootUrl.resolve(stripUrlPath(section.href)))
    }

    var stylesheetTasks = []
    var resolveResourceUrl = this.directImageFallbacks
      ? (src) => {
          return this.resolveResourceFallback(
            src,
            sectionUrl,
            packageRootUrl,
            containerRootUrl,
          )
        }
      : undefined

    eachElement(doc, (element) => {
      var tagName = getTagName(element)

      resolveElementAttribute(
        element,
        sectionUrl,
        containerRootUrl,
        'src',
        resolveResourceUrl,
      )
      resolveElementAttribute(
        element,
        sectionUrl,
        containerRootUrl,
        'poster',
        resolveResourceUrl,
      )
      resolveElementAttribute(
        element,
        sectionUrl,
        containerRootUrl,
        'data',
        resolveResourceUrl,
      )
      resolveElementAttribute(
        element,
        sectionUrl,
        containerRootUrl,
        'xlink:href',
        resolveResourceUrl,
      )
      resolveSrcsetAttribute(
        element,
        sectionUrl,
        containerRootUrl,
        resolveResourceUrl,
      )
      resolveStyleAttribute(element, sectionUrl, containerRootUrl)

      if (tagName === 'image') {
        resolveElementAttribute(
          element,
          sectionUrl,
          containerRootUrl,
          'href',
          resolveResourceUrl,
        )
      }

      if (tagName === 'link') {
        var href = element.getAttribute('href')
        if (isBlockedResourceUrl(href)) {
          removeElement(element)
          return
        }

        if (!shouldResolveUrl(href)) {
          return
        }

        if (isStylesheetLink(element)) {
          stylesheetTasks.push(
            this.createResolvedCssUrl(href, sectionUrl, containerRootUrl).then(
              (url) => {
                element.setAttribute('href', url)
              },
            ),
          )
        } else {
          element.setAttribute(
            'href',
            resolveLocalUrl(href, sectionUrl, containerRootUrl),
          )
        }
      }
    })

    return Promise.all(stylesheetTasks).then(() => {
      return resolveInlineStyleElements.call(
        this,
        doc,
        sectionUrl,
        containerRootUrl,
      )
    })
  }

  resolveResourceFallback(src, baseUrl, packageRootUrl, containerRootUrl) {
    var absolute = resolveLocalUrl(src, baseUrl, containerRootUrl)

    if (!packageRootUrl || !shouldResolveUrl(src)) {
      return absolute
    }

    var root = packageRootUrl.toString()
    var index = this.fallbackUrlIndexes[root]

    if (!index) {
      index = Object.create(null)
      Object.keys(this.directImageFallbacks).forEach((href) => {
        var fallbackHref = this.directImageFallbacks[href]
        var primary = packageRootUrl.resolve(stripUrlPath(href))
        var fallback = packageRootUrl.resolve(stripUrlPath(fallbackHref))

        resourceUrlVariants(primary).forEach((variant) => {
          index[variant] = fallback
        })
      })
      this.fallbackUrlIndexes[root] = index
    }

    var suffix = getUrlSuffix(absolute)
    var path = stripUrlSuffix(absolute)
    var fallback

    resourceUrlVariants(path).some((variant) => {
      fallback = index[variant]
      return Boolean(fallback)
    })

    return fallback ? fallback + suffix : absolute
  }

  createResolvedCssUrl(href, sectionUrl, rootUrl) {
    var absolute = resolveLocalUrl(href, sectionUrl, rootUrl)

    if (this.resolvedCssUrls[absolute]) {
      return Promise.resolve(this.resolvedCssUrls[absolute])
    }

    return this.createResolvedCssUrlFromAbsolute(absolute, rootUrl)
  }

  createResolvedCssUrlFromAbsolute(absolute, rootUrl, seen) {
    if (this.resolvedCssUrls[absolute]) {
      return Promise.resolve(this.resolvedCssUrls[absolute])
    }

    return this.createResolvedCssText(absolute, rootUrl, seen)
      .then((rewritten) => {
        var objectUrl = this.createOwnedBlobUrl(rewritten, 'text/css')
        this.resolvedCssUrls[absolute] = objectUrl
        return objectUrl
      })
      .catch((error) => {
        var objectUrl = this.createOwnedBlobUrl('', 'text/css')
        this.resolvedCssUrls[absolute] = objectUrl
        return objectUrl
      })
  }

  createResolvedCssText(absolute, rootUrl, seen) {
    seen = seen || Object.create(null)

    if (seen[absolute]) {
      return Promise.resolve('')
    }

    seen[absolute] = true

    return this.settings.request(absolute, 'text').then((text) => {
      var cssUrl = new Url(absolute)
      return resolveCssImports
        .call(this, text, cssUrl, rootUrl, seen)
        .then((withImports) => resolveCssUrls(withImports, cssUrl, rootUrl))
    })
  }

  /**
   * Substitute media references that are present in section markup but omitted
   * from the OPF manifest. Some EPUBs reference images directly from XHTML
   * without declaring them as package resources, so the normal manifest-based
   * replacement pass cannot see them.
   * @param  {string} content
   * @param  {string} url section url the content is relative to
   * @return {Promise<string>}
   */
  substituteMissingMedia(content, url) {
    if (!this.settings.archive || !content || !url) {
      return Promise.resolve(content)
    }

    var sectionPath = new Path(url)
    var urls = collectMediaUrls(content)

    if (!urls.length) {
      return Promise.resolve(content)
    }

    var replacements = urls.map((src) => {
      var assetPath = decodeUrlPath(stripUrlSuffix(src))
      var absolute = path.isAbsolute(assetPath)
        ? assetPath
        : sectionPath.resolve(assetPath)

      return this.createUrl(absolute)
        .then((replacement) => {
          return { src, replacement }
        })
        .catch(() => {
          return null
        })
    })

    return Promise.all(replacements).then((items) => {
      var output = content

      items.forEach((item) => {
        if (!item || !item.replacement) {
          return
        }

        output = substitute(output, [item.src], [item.replacement])
      })

      return output
    })
  }

  destroy() {
    if (this.ownedBlobUrls) {
      this.ownedBlobUrls.forEach((url) => {
        try {
          revokeBlobUrl(url)
        } catch (error) {
          // Ignore URLs already released by the browser.
        }
      })
      this.ownedBlobUrls.clear()
    }

    this.settings = undefined
    this.manifest = undefined
    this.resources = undefined
    this.replacementUrls = undefined
    this.html = undefined
    this.assets = undefined
    this.css = undefined

    this.urls = undefined
    this.cssUrls = undefined
    this.resolvedCssUrls = undefined
    this.directImageFallbacks = undefined
    this.replacementSourceUrls = undefined
    this.fallbackUrlIndexes = undefined
    this.ownedBlobUrls = undefined
  }
}

const MEDIA_TAG_RE = /<(?:img|image|source)\b[^>]*>/gi
const URL_ATTR_RE = /\b(?:src|href|xlink:href)=["']([^"']+)["']/gi
const SRCSET_ATTR_RE = /\bsrcset=["']([^"']+)["']/gi
const ABSOLUTE_URL_RE = /^[a-z][a-z0-9+.-]*:/i
const BLOCKED_RESOURCE_URL_RE = /^(?:file|res):/i
const CSS_IMPORT_RE =
  /@import\s+(?:url\(\s*)?(['"]?)([^'")\s;]+)\1\s*\)?([^;]*);/gi
const CSS_URL_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi
const EMPTY_RESOURCE_URL = 'data:,'
const SUPPORTED_IMAGE_MEDIA_TYPES = [
  'image/avif',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/svg+xml',
  'image/webp',
]

function isSupportedImageMediaType(mediaType) {
  return SUPPORTED_IMAGE_MEDIA_TYPES.includes(
    typeof mediaType === 'string' ? mediaType.toLowerCase() : '',
  )
}

function collectMediaUrls(content) {
  var urls = []
  var seen = Object.create(null)
  var tagMatch

  while ((tagMatch = MEDIA_TAG_RE.exec(content))) {
    var tag = tagMatch[0]
    var attrMatch

    URL_ATTR_RE.lastIndex = 0
    while ((attrMatch = URL_ATTR_RE.exec(tag))) {
      addMediaUrl(attrMatch[1], urls, seen)
    }

    SRCSET_ATTR_RE.lastIndex = 0
    while ((attrMatch = SRCSET_ATTR_RE.exec(tag))) {
      attrMatch[1].split(',').forEach((candidate) => {
        addMediaUrl(candidate.trim().split(/\s+/)[0], urls, seen)
      })
    }
  }

  return urls
}

function addMediaUrl(src, urls, seen) {
  if (!src || !shouldResolveMediaUrl(src) || seen[src]) {
    return
  }

  seen[src] = true
  urls.push(src)
}

function shouldResolveMediaUrl(src) {
  var value = src.trim()

  return (
    value &&
    value.charAt(0) !== '#' &&
    value.indexOf('//') !== 0 &&
    !ABSOLUTE_URL_RE.test(value)
  )
}

function stripUrlSuffix(src) {
  var end = src.length
  var query = src.indexOf('?')
  var hash = src.indexOf('#')

  if (query > -1) {
    end = Math.min(end, query)
  }

  if (hash > -1) {
    end = Math.min(end, hash)
  }

  return src.slice(0, end)
}

function stripUrlPath(src) {
  return decodeUrlPath(src.slice(0, stripUrlSuffix(src).length))
}

function getUrlSuffix(src) {
  return src.slice(stripUrlSuffix(src).length)
}

function decodeUrlPath(src) {
  try {
    return decodeURI(src)
  } catch {
    return src
  }
}

function decodeUrlPathSegments(src) {
  return src
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

function encodeUrlPathSegments(src) {
  return src
    .split('/')
    .map((part) => {
      if (!part || part === '.' || part === '..') {
        return part
      }

      return encodeURIComponent(part).replace(/\*/g, '%2A')
    })
    .join('/')
}

function addResourceUrlVariant(result, seen, url) {
  if (!url || seen[url]) {
    return
  }

  seen[url] = true
  result.push(url)
}

function resourceUrlVariants(url) {
  var variants = []
  var seen = Object.create(null)
  var path = stripUrlSuffix(url)
  var suffix = getUrlSuffix(url)
  var decoded = decodeUrlPathSegments(path)
  var encoded = encodeUrlPathSegments(decoded)

  addResourceUrlVariant(variants, seen, url)
  addResourceUrlVariant(variants, seen, decoded + suffix)
  addResourceUrlVariant(variants, seen, encoded + suffix)

  return variants
}

function createSubstitutionUrls(urls, replacements) {
  var nextUrls = []
  var nextReplacements = []
  var seen = Object.create(null)

  urls.forEach((url, index) => {
    var replacement = replacements[index]
    if (!url || !replacement) {
      return
    }

    resourceUrlVariants(url).forEach((variant) => {
      var key = variant + '\u0000' + replacement
      if (seen[key]) {
        return
      }

      seen[key] = true
      nextUrls.push(variant)
      nextReplacements.push(replacement)
    })
  })

  return {
    replacements: nextReplacements,
    urls: nextUrls,
  }
}

function shouldResolveUrl(src) {
  var value = src && src.trim()

  return (
    value &&
    value.charAt(0) !== '#' &&
    value.indexOf('//') !== 0 &&
    !isBlockedResourceUrl(value) &&
    !ABSOLUTE_URL_RE.test(value)
  )
}

function isBlockedResourceUrl(src) {
  var value = src && src.trim()

  return !!value && BLOCKED_RESOURCE_URL_RE.test(value)
}

function resolvePackageRootUrl(rootUrl, section, sectionUrl) {
  var configured = rootUrl && new Url(ensureDirectoryUrl(rootUrl))
  return configured || derivePackageRootUrl(section, sectionUrl)
}

function resolveContainerRootUrl(containerRootUrl, packageRootUrl) {
  return containerRootUrl
    ? new Url(ensureDirectoryUrl(containerRootUrl))
    : packageRootUrl
}

function derivePackageRootUrl(section, sectionUrl) {
  if (!section || !section.href || !sectionUrl) {
    return
  }

  var sectionHref = stripUrlPath(section.href).replace(/\\/g, '/')
  var segments = sectionHref.split('/').filter(Boolean)
  var parentSteps = Math.max(0, segments.length - 1)
  var relativeRoot = parentSteps
    ? new Array(parentSteps).fill('..').join('/')
    : '.'

  return new Url(ensureDirectoryUrl(sectionUrl.resolve(relativeRoot)))
}

function resolveLocalUrl(src, baseUrl, rootUrl) {
  var assetPath

  if (!shouldResolveUrl(src)) {
    return src
  }

  assetPath = stripUrlPath(src)

  if (!assetPath) {
    return src
  }

  if (assetPath.charAt(0) === '/' && rootUrl) {
    return rootUrl.resolve(assetPath.slice(1)) + getUrlSuffix(src)
  }

  if (rootUrl) {
    return resolveWithinRoot(assetPath, baseUrl, rootUrl) + getUrlSuffix(src)
  }

  return baseUrl.resolve(assetPath) + getUrlSuffix(src)
}

function resolveWithinRoot(assetPath, baseUrl, rootUrl) {
  var relativeBase = path.relative(
    rootUrl.Path.directory,
    baseUrl.Path.directory,
  )
  var normalized = path
    .resolve('/', relativeBase, assetPath)
    .replace(/^\/+/, '')

  // EPUB-local references cannot traverse above the publication container.
  return rootUrl.resolve(normalized)
}

function resolveSrcsetAttribute(element, baseUrl, rootUrl, resolver) {
  var srcset = element.getAttribute('srcset')

  if (!srcset) {
    return
  }

  element.setAttribute(
    'srcset',
    srcset
      .split(',')
      .map((candidate) => {
        var parts = candidate.trim().split(/\s+/)
        if (!parts[0]) {
          return candidate
        }

        if (isBlockedResourceUrl(parts[0])) {
          return ''
        }

        parts[0] = resolver
          ? resolver(parts[0])
          : resolveLocalUrl(parts[0], baseUrl, rootUrl)
        return parts.join(' ')
      })
      .filter(Boolean)
      .join(', '),
  )
}

function resolveElementAttribute(
  element,
  baseUrl,
  rootUrl,
  attribute,
  resolver,
) {
  var value = element.getAttribute(attribute)

  if (!value) {
    return
  }

  if (isBlockedResourceUrl(value)) {
    element.removeAttribute(attribute)
    return
  }

  element.setAttribute(
    attribute,
    resolver ? resolver(value) : resolveLocalUrl(value, baseUrl, rootUrl),
  )
}

function resolveStyleAttribute(element, baseUrl, rootUrl) {
  var style = element.getAttribute('style')

  if (!style) {
    return
  }

  element.setAttribute('style', resolveCssUrls(style, baseUrl, rootUrl))
}

function resolveInlineStyleElements(doc, baseUrl, rootUrl) {
  var styles = doc.getElementsByTagName('style')
  var tasks = []

  for (var i = 0; i < styles.length; i++) {
    let style = styles[i]
    tasks.push(
      resolveCssImports
        .call(this, style.textContent, baseUrl, rootUrl)
        .then((withImports) => {
          style.textContent = resolveCssUrls(withImports, baseUrl, rootUrl)
        }),
    )
  }

  return Promise.all(tasks)
}

function resolveCssImports(css, baseUrl, rootUrl, seen) {
  if (!css) {
    return Promise.resolve(css)
  }

  var replacements = []
  var output = css.replace(CSS_IMPORT_RE, (match, quote, url, suffix) => {
    if (isBlockedResourceUrl(url)) {
      return ''
    }

    if (!shouldResolveUrl(url)) {
      return match
    }

    var absolute = resolveLocalUrl(url, baseUrl, rootUrl)
    var token = '/* FLOW_CSS_IMPORT_' + replacements.length + ' */'
    replacements.push(
      this.createResolvedCssUrlFromAbsolute(absolute, rootUrl, seen).then(
        (resolved) => {
          return {
            token,
            replacement: '@import url("' + resolved + '")' + suffix + ';',
          }
        },
      ),
    )
    return token
  })

  return Promise.all(replacements).then((items) => {
    items.forEach((item) => {
      output = output.replace(item.token, item.replacement)
    })
    return output
  })
}

function resolveCssUrls(css, baseUrl, rootUrl) {
  if (!css) {
    return css
  }

  return css.replace(CSS_URL_RE, (match, quote, url) => {
    if (isBlockedResourceUrl(url)) {
      return 'url("' + EMPTY_RESOURCE_URL + '")'
    }

    if (!shouldResolveUrl(url)) {
      return match
    }

    var resolved = resolveLocalUrl(url, baseUrl, rootUrl)
    return 'url("' + resolved + '")'
  })
}

function ensureDirectoryUrl(url) {
  if (!url || url.charAt(url.length - 1) === '/') {
    return url
  }

  return url + '/'
}

function isStylesheetLink(element) {
  var rel = element.getAttribute('rel')
  var type = element.getAttribute('type')

  return (
    (rel && rel.toLowerCase().indexOf('stylesheet') > -1) ||
    (type && type.toLowerCase() === 'text/css')
  )
}

function removeElement(element) {
  if (element.parentNode) {
    element.parentNode.removeChild(element)
  }
}

function eachElement(doc, callback) {
  var elements = doc.getElementsByTagName('*')

  for (var i = 0; i < elements.length; i++) {
    callback(elements[i])
  }
}

function getTagName(element) {
  return (element.localName || element.tagName || '').toLowerCase()
}

export default Resources
