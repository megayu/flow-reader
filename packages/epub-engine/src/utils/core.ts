export type LegacyWindow = Window &
  typeof globalThis & {
    mozRequestAnimationFrame?: typeof window.requestAnimationFrame
    webkitRequestAnimationFrame?: typeof window.requestAnimationFrame
    msRequestAnimationFrame?: typeof window.requestAnimationFrame
    webkitURL?: typeof URL
    mozURL?: typeof URL
  }

export interface Deferred<T> {
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
  id: string
  promise: Promise<T>
}
type QueryRoot = Document | Element

/**
 * Core Utilities and Helpers
 * @module Core
 */

/**
 * Vendor prefixed requestAnimationFrame
 * @returns {function} requestAnimationFrame
 * @memberof Core
 */
export const requestAnimationFrame =
  typeof window != 'undefined'
    ? window.requestAnimationFrame ||
      (window as LegacyWindow).mozRequestAnimationFrame ||
      (window as LegacyWindow).webkitRequestAnimationFrame ||
      (window as LegacyWindow).msRequestAnimationFrame
    : false
const ELEMENT_NODE = 1
const _URL =
  typeof URL != 'undefined'
    ? URL
    : typeof window != 'undefined'
      ? window.URL ||
        (window as LegacyWindow).webkitURL ||
        (window as LegacyWindow).mozURL
      : undefined

function looksLikeNcxMarkup(markup: string, mime: DOMParserSupportedType) {
  return (
    mime === 'text/xml' &&
    typeof markup === 'string' &&
    /<\s*ncx(?:\s|>)/i.test(markup) &&
    /<\s*navMap(?:\s|>)/i.test(markup)
  )
}

function sanitizeNcxNavLabelText(markup: string) {
  return markup.replace(
    /(<\s*text\b[^>]*>)([\s\S]*?)(<\s*\/\s*text\s*>)/gi,
    function (_match: string, open: string, text: string, close: string) {
      return open + text.replace(/</g, '&lt;') + close
    },
  )
}

function isParserErrorDocument(doc: Document) {
  var root = doc && doc.documentElement
  if (!root) return false

  var isParserError = function (node: Element | null) {
    return (
      node &&
      String(node.localName || node.nodeName).toLowerCase() === 'parsererror'
    )
  }
  if (isParserError(root)) return true

  return isParserError(root.firstElementChild)
}

function repairBareXmlAmpersands(markup: string) {
  return markup.replace(/&(?!(?:#\d+|#x[\da-f]+|[^\s<>&;]+);)/gi, '&amp;')
}

/**
 * Generates a UUID
 * based on: http://stackoverflow.com/questions/105034/how-to-create-a-guid-uuid-in-javascript
 * @returns {string} uuid
 * @memberof Core
 */
export function uuid() {
  var d = new Date().getTime()
  var uuid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(
    /[xy]/g,
    function (c) {
      var r = ((d + Math.random() * 16) % 16) | 0
      d = Math.floor(d / 16)
      return (c == 'x' ? r : (r & 0x7) | 0x8).toString(16)
    },
  )
  return uuid
}

/**
 * Checks if a node is an element
 * @param {object} obj
 * @returns {boolean}
 * @memberof Core
 */
export function isElement(obj: unknown): obj is Element {
  return !!(obj && (obj as Node).nodeType == 1)
}

/**
 * @param {any} n
 * @returns {boolean}
 * @memberof Core
 */
export function isNumber(n: string | number | null | undefined) {
  return !isNaN(parseFloat(n as string)) && isFinite(n as number)
}

/**
 * Get a prefixed css property
 * @param {string} unprefixed
 * @returns {string}
 * @memberof Core
 */
export function prefixed(unprefixed: string) {
  var vendors = ['Webkit', 'webkit', 'Moz', 'O', 'ms']
  var prefixes = ['-webkit-', '-webkit-', '-moz-', '-o-', '-ms-']
  var lower = unprefixed.toLowerCase()
  var length = vendors.length

  if (
    typeof document === 'undefined' ||
    typeof (document.body.style as unknown as Record<string, string>)[lower] !=
      'undefined'
  ) {
    return unprefixed
  }

  for (var i = 0; i < length; i++) {
    if (
      typeof (document.body.style as unknown as Record<string, string>)[
        prefixes[i]! + lower
      ] != 'undefined'
    ) {
      return prefixes[i] + lower
    }
  }

  return unprefixed
}

/**
 * Apply defaults to an object
 * @param {object} obj
 * @returns {object}
 * @memberof Core
 */
export function defaults<T extends object>(obj: T, ...sources: Partial<T>[]): T {
  for (const source of sources) {
    for (const prop in source) {
      if (obj[prop] === undefined) obj[prop] = source[prop]!
    }
  }
  return obj
}

/**
 * Extend properties of an object
 * @param {object} target
 * @returns {object}
 * @memberof Core
 */
export function extend<T extends object, S extends object>(
  target: T,
  source: S,
): T & S
export function extend<T extends object, S extends object, U extends object>(
  target: T,
  source: S,
  other: U,
): T & S & U
export function extend<T extends object, S extends object>(
  target: T,
  source: S | undefined,
): T & Partial<S>
export function extend(target: object, ...sources: (object | undefined)[]) {
  sources.forEach(function (source) {
    if (!source) return
    Object.getOwnPropertyNames(source).forEach(function (propName) {
      Object.defineProperty(
        target,
        propName,
        Object.getOwnPropertyDescriptor(source, propName)!,
      )
    })
  })
  return target
}

/**
 * Find the bounds of an element
 * taking padding and margin into account
 * @param {element} el
 * @returns {{ width: Number, height: Number}}
 * @memberof Core
 */
export function bounds(el: Element) {
  var style = window.getComputedStyle(el)
  var widthProps = [
    'width',
    'paddingRight',
    'paddingLeft',
    'marginRight',
    'marginLeft',
    'borderRightWidth',
    'borderLeftWidth',
  ]
  var heightProps = [
    'height',
    'paddingTop',
    'paddingBottom',
    'marginTop',
    'marginBottom',
    'borderTopWidth',
    'borderBottomWidth',
  ]

  var width = 0
  var height = 0

  widthProps.forEach(function (prop) {
    width +=
      parseFloat((style as unknown as Record<string, string>)[prop]!) || 0
  })

  heightProps.forEach(function (prop) {
    height +=
      parseFloat((style as unknown as Record<string, string>)[prop]!) || 0
  })

  return {
    height: height,
    width: width,
  }
}

/**
 * Find the bounds of an element
 * taking padding, margin and borders into account
 * @param {element} el
 * @returns {{ width: Number, height: Number}}
 * @memberof Core
 */
export function borders(el: Element) {
  var style = window.getComputedStyle(el)
  var widthProps = [
    'paddingRight',
    'paddingLeft',
    'marginRight',
    'marginLeft',
    'borderRightWidth',
    'borderLeftWidth',
  ]
  var heightProps = [
    'paddingTop',
    'paddingBottom',
    'marginTop',
    'marginBottom',
    'borderTopWidth',
    'borderBottomWidth',
  ]

  var width = 0
  var height = 0

  widthProps.forEach(function (prop) {
    width +=
      parseFloat((style as unknown as Record<string, string>)[prop]!) || 0
  })

  heightProps.forEach(function (prop) {
    height +=
      parseFloat((style as unknown as Record<string, string>)[prop]!) || 0
  })

  return {
    height: height,
    width: width,
  }
}

/**
 * Find the bounds of any node
 * allows for getting bounds of text nodes by wrapping them in a range
 * @param {node} node
 * @returns {BoundingClientRect}
 * @memberof Core
 */
export function nodeBounds(node: Node) {
  let elPos
  let doc = node.ownerDocument!
  if (node.nodeType == Node.TEXT_NODE) {
    let elRange = doc.createRange()
    elRange.selectNodeContents(node)
    elPos = elRange.getBoundingClientRect()
  } else {
    elPos = (node as Element).getBoundingClientRect()
  }
  return elPos
}

/**
 * Find the equivalent of getBoundingClientRect of a browser window
 * @returns {{ width: Number, height: Number, top: Number, left: Number, right: Number, bottom: Number }}
 * @memberof Core
 */
export function windowBounds() {
  var width = window.innerWidth
  var height = window.innerHeight

  return {
    top: 0,
    left: 0,
    right: width,
    bottom: height,
    width: width,
    height: height,
  }
}

/**
 * Gets the index of a node in its parent
 * @param {Node} node
 * @param {string} typeId
 * @return {number} index
 * @memberof Core
 */
export function indexOfNode(node: Node, typeId: number) {
  var parent = node.parentNode!
  var children = parent.childNodes
  var sib
  var index = -1
  for (var i = 0; i < children.length; i++) {
    sib = children[i]!
    if (sib.nodeType === typeId) {
      index++
    }
    if (sib == node) break
  }

  return index
}

/**
 * Gets the index of an element node in its parent
 * @param {element} elementNode
 * @returns {number} index
 * @memberof Core
 */
export function indexOfElementNode(elementNode: Element) {
  return indexOfNode(elementNode, ELEMENT_NODE)
}

/**
 * Check if extension is xml
 * @param {string} ext
 * @returns {boolean}
 * @memberof Core
 */
export function isXml(ext: string) {
  return ['xml', 'opf', 'ncx'].indexOf(ext) > -1
}

/**
 * Create a new blob
 * @param {any} content
 * @param {string} mime
 * @returns {Blob}
 * @memberof Core
 */
export function createBlob(content: BlobPart, mime: string) {
  return new Blob([content], { type: mime })
}

/**
 * Create a new blob url
 * @param {any} content
 * @param {string} mime
 * @returns {string} url
 * @memberof Core
 */
export function createBlobUrl(content: BlobPart, mime: string) {
  var tempUrl
  var blob = createBlob(content, mime)

  tempUrl = _URL!.createObjectURL(blob)

  return tempUrl
}

/**
 * Remove a blob url
 * @param {string} url
 * @memberof Core
 */
export function revokeBlobUrl(url: string) {
  return _URL!.revokeObjectURL(url)
}

/**
 * Create a new base64 encoded url
 * @param {any} content
 * @param {string} mime
 * @returns {string} url
 * @memberof Core
 */
export function createBase64Url(content: string, mime: string) {
  var data
  var datauri

  if (typeof content !== 'string') {
    // Only handles strings
    return
  }

  data = btoa(content)

  datauri = 'data:' + mime + ';base64,' + data

  return datauri
}

/**
 * Get type of an object
 * @param {object} obj
 * @returns {string} type
 * @memberof Core
 */
export function type(obj: unknown) {
  return Object.prototype.toString.call(obj).slice(8, -1)
}

/**
 * Parse xml (or html) markup
 * @param {string} markup
 * @param {string} mime
 * @returns {document} document
 * @memberof Core
 */
export function parse(markup: string, mime: DOMParserSupportedType) {
  var doc

  // Remove byte order mark before parsing
  // https://www.w3.org/International/questions/qa-byte-order-mark
  if (markup.charCodeAt(0) === 0xfeff) {
    markup = markup.slice(1)
  }

  if (looksLikeNcxMarkup(markup, mime)) {
    markup = sanitizeNcxNavLabelText(markup)
  }

  doc = new DOMParser().parseFromString(markup, mime)

  // Some otherwise readable EPUBs contain HTML-style URLs with bare ampersands.
  // Keep the strict parser as the normal path and repair only a failed XHTML.
  if (mime === 'application/xhtml+xml' && isParserErrorDocument(doc)) {
    var repairedMarkup = repairBareXmlAmpersands(markup)
    if (repairedMarkup !== markup) {
      var repairedDoc = new DOMParser().parseFromString(repairedMarkup, mime)
      if (!isParserErrorDocument(repairedDoc)) {
        return repairedDoc
      }
    }
  }

  return doc
}

/**
 * querySelector polyfill
 * @param {element} el
 * @param {string} sel selector string
 * @returns {element} element
 * @memberof Core
 */
export function qs(el: QueryRoot, sel: string) {
  var elements
  if (!el) {
    throw new Error('No Element Provided')
  }

  if (typeof el.querySelector != 'undefined') {
    return el.querySelector(sel)
  } else {
    elements = el.getElementsByTagName(sel)
    if (elements.length) {
      return elements[0]
    }
  }
}

/**
 * querySelectorAll polyfill
 * @param {element} el
 * @param {string} sel selector string
 * @returns {element[]} elements
 * @memberof Core
 */
export function qsa(el: QueryRoot, sel: string) {
  if (typeof el.querySelector != 'undefined') {
    return el.querySelectorAll(sel)
  } else {
    return el.getElementsByTagName(sel)
  }
}

/**
 * querySelector by property
 * @param {element} el
 * @param {string} sel selector string
 * @param {object[]} props
 * @returns {element[]} elements
 * @memberof Core
 */
export function qsp(el: QueryRoot, sel: string, props: Record<string, string>) {
  var q, filtered: Element[] | undefined
  if (typeof el.querySelector != 'undefined') {
    sel += '['
    for (var prop in props) {
      sel += prop + "~='" + props[prop] + "'"
    }
    sel += ']'
    return el.querySelector(sel)
  } else {
    q = el.getElementsByTagName(sel)
    filtered = Array.prototype.slice.call(q, 0).filter(function (el: Element) {
      for (var prop in props) {
        if (el.getAttribute(prop) === props[prop]) {
          return true
        }
      }
      return false
    })

    if (filtered) {
      return filtered[0]
    }
  }
}

/**
 * Sprint through all text nodes in a document
 * @memberof Core
 * @param  {element} root element to start with
 * @param  {function} func function to run on each element
 */
export function sprint(root: Node, func: (node: Text) => unknown) {
  var doc = root.ownerDocument || (root as Document)
  if (typeof doc.createTreeWalker !== 'undefined') {
    treeWalker(root, func as (node: Node) => unknown, NodeFilter.SHOW_TEXT)
  } else {
    walk(
      root,
      function (node) {
        if (node && node.nodeType === 3) {
          // Node.TEXT_NODE
          func(node as Text)
        }
      },
      true,
    )
  }
}

/**
 * Create a treeWalker
 * @memberof Core
 * @param  {element} root element to start with
 * @param  {function} func function to run on each element
 * @param  {function | object} filter function or object to filter with
 */
export function treeWalker(
  root: Node,
  func: (node: Node) => unknown,
  filter: number,
) {
  var treeWalker = (
    document.createTreeWalker as (
      root: Node,
      filter: number,
      accept: NodeFilter | null,
      expand: boolean,
    ) => TreeWalker
  )(root, filter, null, false)
  let node
  while ((node = treeWalker.nextNode())) {
    func(node)
  }
}

/**
 * @memberof Core
 * @param {node} node
 * @param {callback} return false for continue,true for break inside callback
 */
export function walk(
  node: Node | null,
  callback: (node: Node | null) => unknown,
  legacy?: boolean,
): true | undefined
export function walk(
  node: Node | null,
  callback: (node: Node | null) => unknown,
): true | undefined {
  if (callback(node)) {
    return true
  }
  node = node!.firstChild
  if (node) {
    do {
      let walked = walk(node, callback)
      if (walked) {
        return true
      }
      node = node.nextSibling
    } while (node)
  }
}

/**
 * Convert a blob to a base64 encoded string
 * @param {Blog} blob
 * @returns {string}
 * @memberof Core
 */
export function blob2base64(blob: Blob) {
  return new Promise<string | ArrayBuffer | null>(function (resolve, reject) {
    var reader = new FileReader()
    reader.readAsDataURL(blob)
    reader.onloadend = function () {
      resolve(reader.result)
    }
  })
}

/**
 * Creates a new pending promise and provides methods to resolve or reject it.
 * From: https://developer.mozilla.org/en-US/docs/Mozilla/JavaScript_code_modules/Promise.jsm/Deferred#backwards_forwards_compatible
 * @memberof Core
 */
// The Promise executor installs both callbacks synchronously before the constructor returns.
export const defer = function defer<T>(
  this: Partial<Omit<Deferred<T>, 'resolve' | 'reject'>> & {
    resolve: Deferred<T>['resolve'] | null
    reject: Deferred<T>['reject'] | null
  },
) {
  /* A method to resolve the associated Promise with the value passed.
   * If the promise is already settled it does nothing.
   *
   * @param {anything} value : This value is used to resolve the promise
   * If the value is a Promise then the associated promise assumes the state
   * of Promise passed as value.
   */
  this.resolve = null

  /* A method to reject the associated Promise with the value passed.
   * If the promise is already settled it does nothing.
   *
   * @param {anything} reason: The reason for the rejection of the Promise.
   * Generally its an Error object. If however a Promise is passed, then the Promise
   * itself will be the reason for rejection no matter the state of the Promise.
   */
  this.reject = null

  this.id = uuid()

  /* A newly created Pomise object.
   * Initially in pending state.
   */
  this.promise = new Promise<T>((resolve, reject) => {
    this.resolve = resolve
    this.reject = reject
  })
  Object.freeze(this)
} as unknown as { new <T = void>(): Deferred<T> }

/**
 * querySelector with filter by epub type
 * @param {element} html
 * @param {string} element element type to find
 * @param {string} type epub type to find
 * @returns {element[]} elements
 * @memberof Core
 */
export function querySelectorByType(
  html: QueryRoot,
  element: string,
  type: string,
) {
  var query: Element | ArrayLike<Element> | null | undefined
  if (typeof html.querySelector != 'undefined') {
    query = html.querySelector(`${element}[*|type="${type}"]`)
  }
  // Handle IE not supporting namespaced epub:type in querySelector
  if (!query || (query as ArrayLike<Element>).length === 0) {
    query = qsa(html, element)
    for (var i = 0; i < query.length; i++) {
      if (
        query[i]!.getAttributeNS('http://www.idpf.org/2007/ops', 'type') ===
          type ||
        query[i]!.getAttribute('epub:type') === type
      ) {
        return query[i]
      }
    }
  } else {
    return query as Element
  }
}

/**
 * Find direct descendents of an element
 * @param {element} el
 * @returns {element[]} children
 * @memberof Core
 */
export function findChildren(el: Node) {
  var result: Element[] = []
  var childNodes = el.childNodes
  for (var i = 0; i < childNodes.length; i++) {
    let node = childNodes[i]!
    if (node.nodeType === 1) {
      result.push(node as Element)
    }
  }
  return result
}

/**
 * Find all direct descendents of a specific type
 * @param {element} el
 * @param {string} nodeName
 * @param {boolean} [single]
 * @returns {element[]} children
 * @memberof Core
 */
export function filterChildren(
  el: Node,
  nodeName: string,
  single: true,
): Element | undefined
export function filterChildren(
  el: Node,
  nodeName: string,
  single?: false,
): Element[]
export function filterChildren(el: Node, nodeName: string, single?: boolean) {
  var result: Element[] = []
  var childNodes = el.childNodes
  for (var i = 0; i < childNodes.length; i++) {
    let node = childNodes[i]!
    if (node.nodeType === 1 && node.nodeName.toLowerCase() === nodeName) {
      if (single) {
        return node as Element
      } else {
        result.push(node as Element)
      }
    }
  }
  if (!single) {
    return result
  }
}
