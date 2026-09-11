import type { NavigationJsonItem } from './navigation'

export interface PackagingManifestItem {
  href: string
  type: string
  overlay?: string
  fallback?: string
  properties: string[]
  rel?: string[]
}
export type PackagingManifestObject = Record<string, PackagingManifestItem>
export interface PackagingSpineItem {
  id?: string | null
  idref: string | null
  linear: string
  properties: string[]
  index: number
  href?: string
}
export interface PackagingMetadataObject {
  minSpreadWidth?: number
  title?: string | null
  creator?: string | null
  description?: string | null
  pubdate?: string | null
  publisher?: string | null
  identifier?: string | null
  language?: string | null
  rights?: string | null
  modified_date?: string | null
  layout?: string | null
  orientation?: string | null
  flow?: string | null
  viewport?: string | null
  media_active_class?: string | null
  spread?: string | null
  direction?: string | null
}
export interface PackagingJson {
  metadata: PackagingMetadataObject
  readingOrder?: PackagingSpineItem[]
  spine: PackagingSpineItem[]
  resources: PackagingManifestItem[]
  toc: NavigationJsonItem[]
}

import { qs, qsa, qsp, indexOfElementNode } from './utils/core'
import { decodeHref } from './utils/href'

/**
 * Open Packaging Format Parser
 * @class
 * @param {document} packageDocument OPF XML
 */
class Packaging {
  declare manifest: PackagingManifestObject
  declare navPath: string | false | null
  declare ncxPath: string | false | null
  declare coverPath: string | false | null
  declare spineNodeIndex: number
  declare spine: PackagingSpineItem[]
  declare metadata: PackagingMetadataObject
  declare uniqueIdentifier: string
  declare toc: NavigationJsonItem[]

  constructor(packageDocument?: Document) {
    this.manifest = {}
    this.navPath = ''
    this.ncxPath = ''
    this.coverPath = ''
    this.spineNodeIndex = 0
    this.spine = []
    this.metadata = {}

    if (packageDocument) {
      this.parse(packageDocument)
    }
  }

  /**
   * Parse OPF XML
   * @param  {document} packageDocument OPF XML
   * @return {object} parsed package parts
   */
  parse(packageDocument: Document) {
    var metadataNode, manifestNode, spineNode

    if (!packageDocument) {
      throw new Error('Package File Not Found')
    }

    metadataNode = qs(packageDocument, 'metadata')
    if (!metadataNode) {
      throw new Error('No Metadata Found')
    }

    manifestNode = qs(packageDocument, 'manifest')
    if (!manifestNode) {
      throw new Error('No Manifest Found')
    }

    spineNode = qs(packageDocument, 'spine')
    if (!spineNode) {
      throw new Error('No Spine Found')
    }

    this.manifest = this.parseManifest(manifestNode)
    this.navPath = this.findNavPath(manifestNode)
    this.ncxPath = this.findNcxPath(manifestNode, spineNode)
    this.coverPath = this.findCoverPath(packageDocument)

    this.spineNodeIndex = indexOfElementNode(spineNode)

    this.spine = this.parseSpine(spineNode)

    this.uniqueIdentifier = this.findUniqueIdentifier(packageDocument)
    this.metadata = this.parseMetadata(metadataNode)

    this.metadata.direction = spineNode.getAttribute(
      'page-progression-direction',
    )

    return {
      metadata: this.metadata,
      spine: this.spine,
      manifest: this.manifest,
      navPath: this.navPath,
      ncxPath: this.ncxPath,
      coverPath: this.coverPath,
      spineNodeIndex: this.spineNodeIndex,
    }
  }

  /**
   * Parse Metadata
   * @private
   * @param  {node} xml
   * @return {object} metadata
   */
  parseMetadata(xml: Element) {
    var metadata: PackagingMetadataObject = {}

    metadata.title = this.getElementText(xml, 'title')
    metadata.creator = this.getElementText(xml, 'creator')
    metadata.description = this.getElementText(xml, 'description')

    metadata.pubdate = this.getElementText(xml, 'date')

    metadata.publisher = this.getElementText(xml, 'publisher')

    metadata.identifier = this.getElementText(xml, 'identifier')
    metadata.language = this.getElementText(xml, 'language')
    metadata.rights = this.getElementText(xml, 'rights')

    metadata.modified_date = this.getPropertyText(xml, 'dcterms:modified')

    metadata.layout = this.getPropertyText(xml, 'rendition:layout')
    metadata.orientation = this.getPropertyText(xml, 'rendition:orientation')
    metadata.flow = this.getPropertyText(xml, 'rendition:flow')
    metadata.viewport = this.getPropertyText(xml, 'rendition:viewport')
    if (!metadata.viewport && metadata.layout === 'pre-paginated') {
      metadata.viewport = this.getOriginalResolutionViewport(xml)
    }
    metadata.media_active_class = this.getPropertyText(
      xml,
      'media:active-class',
    )
    metadata.spread = this.getPropertyText(xml, 'rendition:spread')
    // metadata.page_prog_dir = packageXml.querySelector("spine").getAttribute("page-progression-direction");

    return metadata
  }

  /**
   * Kindle fixed-layout conversions can omit per-page viewport tags and keep
   * the authored page size only in OPF original-resolution metadata.
   */
  getOriginalResolutionViewport(xml: Element) {
    var metas = qsa(xml, 'meta')
    var items = Array.prototype.slice.call(metas) as Element[]

    for (var i = 0; i < items.length; i++) {
      if (items[i]!.getAttribute('name') !== 'original-resolution') {
        continue
      }

      var content = items[i]!.getAttribute('content') || ''
      var match = content.match(
        /^\s*(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)\s*$/i,
      )
      if (!match) return ''

      return 'width=' + match[1] + ',height=' + match[2]
    }

    return ''
  }

  /**
   * Parse Manifest
   * @private
   * @param  {node} manifestXml
   * @return {object} manifest
   */
  parseManifest(manifestXml: Element) {
    var manifest: PackagingManifestObject = {}

    //-- Turn items into an array
    // var selected = manifestXml.querySelectorAll("item");
    var selected = qsa(manifestXml, 'item')
    var items = Array.prototype.slice.call(selected) as Element[]

    //-- Create an object with the id as key
    items.forEach(function (item) {
      var id = item.getAttribute('id'),
        href = decodeHref(item.getAttribute('href') || ''),
        type = item.getAttribute('media-type') || '',
        overlay = item.getAttribute('media-overlay') || '',
        fallback = item.getAttribute('fallback') || '',
        properties = item.getAttribute('properties') || ''

      manifest[id as string] = {
        href: href,
        // "url" : href,
        type: type,
        overlay: overlay,
        fallback: fallback,
        properties: properties.length ? properties.split(' ') : [],
      }
    })

    return manifest
  }

  /**
   * Parse Spine
   * @private
   * @param  {node} spineXml
   * @return {object} spine
   */
  parseSpine(spineXml: Element) {
    var spine: PackagingSpineItem[] = []

    var selected = qsa(spineXml, 'itemref')
    var items = Array.prototype.slice.call(selected) as Element[]

    //-- Add to array to maintain ordering and cross reference with manifest
    items.forEach(function (item, index) {
      var idref = item.getAttribute('idref')
      var props = item.getAttribute('properties') || ''
      var propArray = props.length ? props.split(' ') : []

      var itemref = {
        id: item.getAttribute('id'),
        idref: idref,
        linear: item.getAttribute('linear') || 'yes',
        properties: propArray,
        index: index,
      }
      spine.push(itemref)
    })

    return spine
  }

  /**
   * Find Unique Identifier
   * @private
   * @param  {node} packageXml
   * @return {string} Unique Identifier text
   */
  findUniqueIdentifier(packageXml: Document) {
    var uniqueIdentifierId =
      packageXml.documentElement.getAttribute('unique-identifier')
    if (!uniqueIdentifierId) {
      return ''
    }
    var identifier = packageXml.getElementById(uniqueIdentifierId)
    if (!identifier) {
      return ''
    }

    if (
      identifier.localName === 'identifier' &&
      identifier.namespaceURI === 'http://purl.org/dc/elements/1.1/'
    ) {
      return identifier.childNodes.length > 0
        ? identifier.childNodes[0]!.nodeValue!.trim()
        : ''
    }

    return ''
  }

  /**
   * Find TOC NAV
   * @private
   * @param {element} manifestNode
   * @return {string}
   */
  findNavPath(manifestNode: Element) {
    // Find item with property "nav"
    // Should catch nav regardless of order
    // var node = manifestNode.querySelector("item[properties$='nav'], item[properties^='nav '], item[properties*=' nav ']");
    var node = qsp(manifestNode, 'item', { properties: 'nav' })
    return node ? decodeHref(node.getAttribute('href')) : false
  }

  /**
   * Find TOC NCX
   * media-type="application/x-dtbncx+xml" href="toc.ncx"
   * @private
   * @param {element} manifestNode
   * @param {element} spineNode
   * @return {string}
   */
  findNcxPath(manifestNode: Element, spineNode: Element) {
    // var node = manifestNode.querySelector("item[media-type='application/x-dtbncx+xml']");
    var node = qsp(manifestNode, 'item', {
      'media-type': 'application/x-dtbncx+xml',
    })
    var tocId

    // If we can't find the toc by media-type then try to look for id of the item in the spine attributes as
    // according to http://www.idpf.org/epub/20/spec/OPF_2.0.1_draft.htm#Section2.4.1.2,
    // "The item that describes the NCX must be referenced by the spine toc attribute."
    if (!node) {
      tocId = spineNode.getAttribute('toc')
      if (tocId) {
        // node = manifestNode.querySelector("item[id='" + tocId + "']");
        node = manifestNode.querySelector(`#${tocId}`)
      }
    }

    return node ? decodeHref(node.getAttribute('href')) : false
  }

  /**
   * Find the Cover Path
   * <item properties="cover-image" id="ci" href="cover.svg" media-type="image/svg+xml" />
   * Fallback for Epub 2.0
   * @private
   * @param  {node} packageXml
   * @return {string} href
   */
  findCoverPath(packageXml: Document) {
    var pkg = qs(packageXml, 'package')
    var epubVersion = pkg!.getAttribute('version')

    // Try parsing cover with epub 3.
    // var node = packageXml.querySelector("item[properties='cover-image']");
    var node = qsp(packageXml, 'item', { properties: 'cover-image' })
    if (node) return decodeHref(node.getAttribute('href'))

    // Fallback to epub 2.
    var metaCover = qsp(packageXml, 'meta', { name: 'cover' })

    if (metaCover) {
      var coverId = metaCover.getAttribute('content')
      // var cover = packageXml.querySelector("item[id='" + coverId + "']");
      var cover = packageXml.getElementById(coverId as string)
      return cover ? decodeHref(cover.getAttribute('href')) : ''
    } else {
      return false
    }
  }

  /**
   * Get text of a namespaced element
   * @private
   * @param  {node} xml
   * @param  {string} tag
   * @return {string} text
   */
  getElementText(xml: Element, tag: string) {
    var found = xml.getElementsByTagNameNS(
      'http://purl.org/dc/elements/1.1/',
      tag,
    )
    var el

    if (!found || found.length === 0) return ''

    el = found[0]!

    if (el.childNodes.length) {
      return el.childNodes[0]!.nodeValue
    }

    return ''
  }

  /**
   * Get text by property
   * @private
   * @param  {node} xml
   * @param  {string} property
   * @return {string} text
   */
  getPropertyText(xml: Element, property: string) {
    var el = qsp(xml, 'meta', { property: property })

    if (el && el.childNodes.length) {
      return el.childNodes[0]!.nodeValue
    }

    return ''
  }

  /**
   * Load JSON Manifest
   * @param  {document} packageDocument OPF XML
   * @return {object} parsed package parts
   */
  load(json: PackagingJson) {
    this.metadata = json.metadata

    let spine = json.readingOrder || json.spine
    this.spine = spine.map((item, index) => {
      item.index = index
      item.linear = item.linear || 'yes'
      return item
    })

    json.resources.forEach((item, index) => {
      this.manifest[index] = {
        ...item,
        href: decodeHref(item.href),
      }

      if (item.rel && item.rel[0] === 'cover') {
        this.coverPath = decodeHref(item.href)
      }
    })

    this.spineNodeIndex = 0

    this.toc = json.toc.map((item) => {
      item.label = item.title
      return item
    })

    return {
      metadata: this.metadata,
      spine: this.spine,
      manifest: this.manifest,
      navPath: this.navPath,
      ncxPath: this.ncxPath,
      coverPath: this.coverPath,
      spineNodeIndex: this.spineNodeIndex,
      toc: this.toc,
    }
  }

  destroy() {
    this.manifest = undefined!
    this.navPath = undefined!
    this.ncxPath = undefined!
    this.coverPath = undefined!
    this.spineNodeIndex = undefined!
    this.spine = undefined!
    this.metadata = undefined!
  }
}

export default Packaging
