import EpubCFI from './epubcfi'
import { defer } from './utils/core'
import { sprint } from './utils/core'
import Hook from './utils/hook'
import { replaceBase } from './utils/replacements'
import Request from './utils/request'
import { findChapterMatches } from './utils/chapter-search'

function requestType(mediaType) {
  if (mediaType === 'application/xhtml+xml') return 'xhtml'
  if (mediaType === 'text/html') return 'html'
}

const bitmapMediaTypes = [
  'image/avif',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
]

function isBitmapMediaType(mediaType) {
  return bitmapMediaTypes.includes(
    typeof mediaType === 'string' ? mediaType.toLowerCase() : '',
  )
}

const XHTML_NAMESPACE = 'http://www.w3.org/1999/xhtml'
const SCRIPT_BLOCKING_CSP_CONTENT = "script-src 'none'; object-src 'none'"

function serializeWithScriptBlockingCsp(doc, contents, mediaType) {
  var serializer = new XMLSerializer()

  if (mediaType === 'image/svg+xml') {
    return `<html><head><meta http-equiv="Content-Security-Policy" content="${SCRIPT_BLOCKING_CSP_CONTENT}" /></head><body>${serializer.serializeToString(contents)}</body></html>`
  }

  var head = doc.getElementsByTagName('head')[0]
  var createdHead = false
  if (!head) {
    head = doc.createElementNS(contents.namespaceURI || XHTML_NAMESPACE, 'head')
    contents.insertBefore(head, contents.firstChild)
    createdHead = true
  }

  var meta = doc.createElementNS(head.namespaceURI || XHTML_NAMESPACE, 'meta')
  meta.setAttribute('http-equiv', 'Content-Security-Policy')
  meta.setAttribute('content', SCRIPT_BLOCKING_CSP_CONTENT)
  head.insertBefore(meta, head.firstChild)

  try {
    return serializer.serializeToString(contents)
  } finally {
    head.removeChild(meta)
    if (createdHead) contents.removeChild(head)
  }
}

export function isRenderableSpineMediaType(mediaType) {
  return Boolean(
    requestType(mediaType) ||
    mediaType === 'image/svg+xml' ||
    isBitmapMediaType(mediaType),
  )
}

function createBitmapDocument(url) {
  var doc = new DOMParser().parseFromString(
    `<html xmlns="http://www.w3.org/1999/xhtml">
      <head>
        <style>
          html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; }
          img { display: block; width: 100%; height: 100%; object-fit: contain; }
        </style>
      </head>
      <body><img alt="" /></body>
    </html>`,
    'application/xhtml+xml',
  )
  doc.getElementsByTagName('img')[0].setAttribute('src', url)
  return doc
}

function processingInstructionAttribute(data, name) {
  var match = data.match(
    new RegExp('(?:^|\\s)' + name + '\\s*=\\s*([\'"])(.*?)\\1', 'i'),
  )
  return match && match[2]
}

function preserveSvgXmlStylesheets(doc, contents) {
  var anchor = contents.firstChild
  var nodes = doc.childNodes

  for (var i = 0; i < nodes.length; i++) {
    var node = nodes[i]
    if (
      node.nodeType !== 7 ||
      (node.target || node.nodeName).toLowerCase() !== 'xml-stylesheet'
    ) {
      continue
    }

    var type = processingInstructionAttribute(node.data, 'type')
    var href = processingInstructionAttribute(node.data, 'href')
    if (!href || (type && type.toLowerCase() !== 'text/css')) {
      continue
    }

    // Section output serializes only the SVG root, so document-level
    // stylesheet processing instructions must move inside that root.
    var style = doc.createElementNS(contents.namespaceURI, 'style')
    style.setAttribute('type', 'text/css')
    style.textContent = '@import url(' + JSON.stringify(href) + ');'
    contents.insertBefore(style, anchor)
  }
}

/**
 * Represents a Section of the Book
 *
 * In most books this is equivalent to a Chapter
 * @param {object} item  The spine item representing the section
 * @param {object} hooks hooks for serialize and content
 */
class Section {
  constructor(item, hooks) {
    this.idref = item.idref
    this.linear = item.linear === 'yes'
    this.properties = item.properties
    this.index = item.index
    this.href = item.href
    this.hrefAliases = item.hrefAliases || []
    this.type = item.type
    this.url = item.url
    this.canonical = item.canonical
    this.resourceAvailable = item.resourceAvailable
    this.next = item.next
    this.prev = item.prev

    this.cfiBase = item.cfiBase

    if (hooks) {
      this.hooks = hooks
    } else {
      this.hooks = {}
      this.hooks.serialize = new Hook(this)
      this.hooks.content = new Hook(this)
    }

    this.document = undefined
    this.contents = undefined
    this.output = undefined
  }

  /**
   * Load the section from its url
   * @param  {method} [_request] a request method to use for loading
   * @return {document} a promise with the xml document
   */
  load(_request) {
    var request = _request || this.request || Request
    var loading = new defer()
    var loaded = loading.promise

    if (this.contents) {
      loading.resolve(this.contents)
    } else if (isBitmapMediaType(this.type)) {
      this.document = createBitmapDocument(this.url)
      this.contents = this.document.documentElement

      this.hooks.content
        .trigger(this.document, this)
        .then(() => loading.resolve(this.contents))
        .catch((error) => loading.reject(error))
    } else {
      request(this.url, requestType(this.type))
        .then(
          function (xml) {
            // var directory = new Url(this.url).directory;

            this.document = xml
            this.contents = xml.documentElement

            if (this.type === 'image/svg+xml') {
              preserveSvgXmlStylesheets(this.document, this.contents)
            }

            return this.hooks.content.trigger(this.document, this)
          }.bind(this),
        )
        .then(
          function () {
            loading.resolve(this.contents)
          }.bind(this),
        )
        .catch(function (error) {
          loading.reject(error)
        })
    }

    return loaded
  }

  /**
   * Adds a base tag for resolving urls in the section
   * @private
   */
  base() {
    return replaceBase(this.document, this)
  }

  /**
   * Render the contents of a section
   * @param  {method} [_request] a request method to use for loading
   * @param  {object} [options] serialization options
   * @return {string} output a serialized XML Document
   */
  render(_request, options = {}) {
    var rendering = new defer()
    var rendered = rendering.promise
    this.output // TODO: better way to return this from hooks?

    this.load(_request)
      .then(
        function (contents) {
          if (options.blockScripts) {
            this.output = serializeWithScriptBlockingCsp(
              this.document,
              contents,
              this.type,
            )
          } else {
            var serializer = new XMLSerializer()
            this.output = serializer.serializeToString(contents)
          }
          return this.output
        }.bind(this),
      )
      .then(
        function () {
          return this.hooks.serialize.trigger(this.output, this)
        }.bind(this),
      )
      .then(
        function () {
          rendering.resolve(this.output)
        }.bind(this),
      )
      .catch(function (error) {
        rendering.reject(error)
      })

    return rendered
  }

  /** Search one loaded chapter, yielding between batches and discarding cancelled results. */
  findAsync(query, options) {
    return findChapterMatches(this, query, options)
  }

  /** Resolve one occurrence without constructing CFIs for the other matches. */
  findOccurrence(keyword, occurrence = 0) {
    const query = keyword.toLowerCase()
    if (!query || !this.document) return
    const walker = this.document.createTreeWalker(this.document.body || this.document.documentElement, 4)
    let first
    let node
    let index = 0
    const resolve = ({ node, pos }) => {
      const range = this.document.createRange()
      range.setStart(node, pos)
      range.setEnd(node, pos + query.length)
      return this.cfiFromRange(range)
    }
    while ((node = walker.nextNode())) {
      const text = node.textContent.toLowerCase()
      let pos = text.indexOf(query)
      while (pos !== -1) {
        first ??= { node, pos }
        if (index++ === occurrence) return resolve({ node, pos })
        pos = text.indexOf(query, pos + 1)
      }
    }
    // Preserve the existing result-navigation fallback for an outdated occurrence.
    if (first) return resolve(first)
  }

  /**
   * Find a string in a section
   * @param  {string} _query The query string to find
   * @return {object[]} A list of matches, with form {cfi, excerpt}
   */
  find(_query) {
    var section = this
    var matches = []
    var query = _query.toLowerCase()
    var find = function (node) {
      var text = node.textContent.toLowerCase()
      var range = section.document.createRange()
      var cfi
      var pos
      var last = -1
      var excerpt
      var limit = 150

      while (pos != -1) {
        // Search for the query
        pos = text.indexOf(query, last + 1)

        if (pos != -1) {
          // We found it! Generate a CFI
          range = section.document.createRange()
          range.setStart(node, pos)
          range.setEnd(node, pos + query.length)

          cfi = section.cfiFromRange(range)

          // Generate the excerpt
          if (node.textContent.length < limit) {
            excerpt = node.textContent
          } else {
            excerpt = node.textContent.substring(
              pos - limit / 2,
              pos + limit / 2,
            )
            excerpt = '...' + excerpt + '...'
          }

          // Add the CFI to the matches list
          matches.push({
            cfi: cfi,
            excerpt: excerpt,
          })
        }

        last = pos
      }
    }

    sprint(
      section.document.body || section.document.documentElement,
      function (node) {
        find(node)
      },
    )

    return matches
  }

  /**
   * Search a string in multiple sequential Element of the section. If the document.createTreeWalker api is missed(eg: IE8), use `find` as a fallback.
   * @param  {string} _query The query string to search
   * @param  {int} maxSeqEle The maximum number of Element that are combined for search, default value is 5.
   * @return {object[]} A list of matches, with form {cfi, excerpt}
   */
  search(_query, maxSeqEle = 5) {
    if (typeof document.createTreeWalker == 'undefined') {
      return this.find(_query)
    }
    let matches = []
    const excerptLimit = 150
    const section = this
    const query = _query.toLowerCase()
    const search = function (nodeList) {
      const textWithCase = nodeList.reduce((acc, current) => {
        return acc + current.textContent
      }, '')
      const text = textWithCase.toLowerCase()
      const pos = text.indexOf(query)
      if (pos != -1) {
        const startNodeIndex = 0,
          endPos = pos + query.length
        let endNodeIndex = 0,
          l = 0
        if (pos < nodeList[startNodeIndex].length) {
          let cfi
          while (endNodeIndex < nodeList.length - 1) {
            l += nodeList[endNodeIndex].length
            if (endPos <= l) {
              break
            }
            endNodeIndex += 1
          }

          let startNode = nodeList[startNodeIndex],
            endNode = nodeList[endNodeIndex]
          let range = section.document.createRange()
          range.setStart(startNode, pos)
          let beforeEndLengthCount = nodeList
            .slice(0, endNodeIndex)
            .reduce((acc, current) => {
              return acc + current.textContent.length
            }, 0)
          range.setEnd(
            endNode,
            beforeEndLengthCount > endPos
              ? endPos
              : endPos - beforeEndLengthCount,
          )
          cfi = section.cfiFromRange(range)

          let excerpt = nodeList
            .slice(0, endNodeIndex + 1)
            .reduce((acc, current) => {
              return acc + current.textContent
            }, '')
          if (excerpt.length > excerptLimit) {
            excerpt = excerpt.substring(
              pos - excerptLimit / 2,
              pos + excerptLimit / 2,
            )
            excerpt = '...' + excerpt + '...'
          }
          matches.push({
            cfi: cfi,
            excerpt: excerpt,
          })
        }
      }
    }

    const treeWalker = document.createTreeWalker(
      section.document.body || section.document.documentElement,
      NodeFilter.SHOW_TEXT,
      null,
      false,
    )
    let node,
      nodeList = []
    while ((node = treeWalker.nextNode())) {
      nodeList.push(node)
      if (nodeList.length == maxSeqEle) {
        search(nodeList.slice(0, maxSeqEle))
        nodeList = nodeList.slice(1, maxSeqEle)
      }
    }
    if (nodeList.length > 0) {
      search(nodeList)
    }
    return matches
  }

  /**
   * Reconciles the current chapters layout properties with
   * the global layout properties.
   * @param {object} globalLayout  The global layout settings object, chapter properties string
   * @return {object} layoutProperties Object with layout properties
   */
  reconcileLayoutSettings(globalLayout) {
    //-- Get the global defaults
    var settings = {
      layout: globalLayout.layout,
      spread: globalLayout.spread,
      orientation: globalLayout.orientation,
    }

    //-- Get the chapter's display type
    this.properties.forEach(function (prop) {
      var rendition = prop.replace('rendition:', '')
      var split = rendition.indexOf('-')
      var property, value

      if (split != -1) {
        property = rendition.slice(0, split)
        value = rendition.slice(split + 1)

        settings[property] = value
      }
    })
    return settings
  }

  /**
   * Get a CFI from a Range in the Section
   * @param  {range} _range
   * @return {string} cfi an EpubCFI string
   */
  cfiFromRange(_range) {
    return new EpubCFI(_range, this.cfiBase).toString()
  }

  /**
   * Get a CFI from an Element in the Section
   * @param  {element} el
   * @return {string} cfi an EpubCFI string
   */
  cfiFromElement(el) {
    return new EpubCFI(el, this.cfiBase).toString()
  }

  /**
   * Unload the section document
   */
  unload() {
    this.document = undefined
    this.contents = undefined
    this.output = undefined
  }

  destroy() {
    this.unload()
    this.hooks.serialize.clear()
    this.hooks.content.clear()

    this.hooks = undefined
    this.idref = undefined
    this.linear = undefined
    this.properties = undefined
    this.index = undefined
    this.href = undefined
    this.url = undefined
    this.next = undefined
    this.prev = undefined

    this.cfiBase = undefined
  }
}

export default Section
