export interface NavItem {
  id: string | false | undefined
  href: string
  label: string
  subitems: NavItem[]
  parent?: string | false | null
}
export interface NavigationJsonItem {
  id: string
  href: string
  title: string
  label?: string
  subitems?: NavItem[]
  children?: NavigationJsonItem[]
}

import { qs, qsa, querySelectorByType, filterChildren } from './utils/core'
import { decodeHref } from './utils/href'

function isListElement(element: Element | undefined) {
  if (!element) return false

  let name = element.localName || element.nodeName || ''
  return name.toLowerCase().split(':').pop() === 'ol'
}

function directChildByName(element: Element, name: string) {
  if (!element || !element.childNodes) return undefined

  let child
  let childName

  for (let i = 0; i < element.childNodes.length; i++) {
    child = element.childNodes[i] as Element
    if (!child || child.nodeType !== 1) continue

    childName = child.localName || child.nodeName || ''
    if (childName.toLowerCase().split(':').pop() === name) {
      return child
    }
  }
}

/**
 * Navigation Parser
 * @param {document} xml navigation html / xhtml / ncx
 */
class Navigation {
  declare toc: NavItem[]
  declare tocByHref: Record<string, number>
  declare tocById: Record<string, number>
  declare length: number
  private declare _hasMissingNavItemIds: boolean
  private declare _navItemIds: Set<string>
  private declare _generatedNavItemId: number

  constructor(xml?: Document | NavigationJsonItem[]) {
    this.toc = []
    this.tocByHref = {}
    this.tocById = {}

    this.length = 0
    if (xml) {
      this.parse(xml)
    }
  }

  /**
   * Parse out the navigation items
   * @param {document} xml navigation html / xhtml / ncx
   */
  parse(xml: Document | NavigationJsonItem[]) {
    let isXml = (xml as Document).nodeType
    let html
    let ncx

    if (isXml) {
      html = qs(xml as Document, 'html')
      ncx = qs(xml as Document, 'ncx')
    }

    if (!isXml) {
      this.toc = this.load(xml as NavigationJsonItem[])
    } else if (html) {
      this.toc = this.parseNav(xml as Document)
    } else if (ncx) {
      this.toc = this.parseNcx(xml as Document)
    }

    this.length = 0

    this.unpack(this.toc)
  }

  /**
   * Unpack navigation items
   * @private
   * @param  {array} toc
   */
  unpack(toc: NavItem[]) {
    var item

    for (var i = 0; i < toc.length; i++) {
      item = toc[i]!

      if (item.href) {
        this.tocByHref[item.href] = i
      }

      if (item.id) {
        this.tocById[item.id] = i
      }

      this.length++

      if (item.subitems.length) {
        this.unpack(item.subitems)
      }
    }
  }

  /**
   * Filter navigation items and rebuild lookup indexes.
   * @param {(item: object) => boolean} predicate
   */
  filter(predicate: (item: NavItem) => boolean) {
    this.toc = this.filterItems(this.toc, predicate)
    this.tocByHref = {}
    this.tocById = {}
    this.length = 0
    this.unpack(this.toc)
  }

  /**
   * Filter a navigation item tree.
   * @private
   * @param {array} items
   * @param {(item: object) => boolean} predicate
   * @return {array}
   */
  filterItems(
    items: NavItem[],
    predicate: (item: NavItem) => boolean,
  ): NavItem[] {
    return items.reduce<NavItem[]>((result, item) => {
      item.subitems = this.filterItems(item.subitems || [], predicate)
      let keepItem = predicate(item)

      if (keepItem || item.subitems.length) {
        if (!keepItem) {
          item.href = ''
        }
        result.push(item)
      }

      return result
    }, [])
  }

  /**
   * Get an item from the navigation
   * @param  {string} target
   * @return {object} navItem
   */
  get(): NavItem[]
  get(target: string): NavItem | NavItem[] | undefined
  get(target?: string) {
    var index

    if (!target) {
      return this.toc
    }

    if (target.indexOf('#') === 0) {
      index = this.tocById[target.substring(1)]
    } else if (target in this.tocByHref) {
      index = this.tocByHref[target]
    }

    return this.getByIndex(target, index, this.toc)
  }

  /**
   * Get an item from navigation subitems recursively by index
   * @param  {string} target
   * @param  {number} index
   * @param  {array} navItems
   * @return {object} navItem
   */
  getByIndex(
    target: string,
    index: number | undefined,
    navItems: NavItem[],
  ): NavItem | undefined {
    if (navItems.length === 0) {
      return
    }

    const item = navItems[index as number]
    if (item && (target === item.id || target === item.href)) {
      return item
    } else {
      let result
      for (let i = 0; i < navItems.length; ++i) {
        result = this.getByIndex(target, index, navItems[i]!.subitems)
        if (result) {
          break
        }
      }
      return result
    }
  }

  /**
   * Parse toc from a Epub > 3.0 Nav
   * @private
   * @param  {document} navHtml
   * @return {array} navigation list
   */
  parseNav(navHtml: Document) {
    var navElement = querySelectorByType(navHtml, 'nav', 'toc')
    var list: NavItem[] = []

    if (!navElement) return list

    let navList = filterChildren(navElement, 'ol', true)
    if (!navList) return list

    this._hasMissingNavItemIds = false
    list = this.parseNavList(navList)
    if (this._hasMissingNavItemIds) {
      this.prepareNavItemIds(list)
      this.assignMissingNavItemIds(list)
    }
    return list
  }

  prepareNavItemIds(items: NavItem[]) {
    this._navItemIds = new Set()
    this._generatedNavItemId = 0
    this.collectNavItemIds(items)
  }

  collectNavItemIds(items: NavItem[]) {
    items.forEach((item) => {
      if (item.id) this._navItemIds.add(item.id)
      this.collectNavItemIds(item.subitems)
    })
  }

  nextNavItemId() {
    let id

    do {
      id = `flow-epub-nav-item-${this._generatedNavItemId++}`
    } while (this._navItemIds.has(id))

    this._navItemIds.add(id)
    return id
  }

  assignMissingNavItemIds(items: NavItem[], parent?: string | false) {
    items.forEach((item) => {
      if (!item.id) item.id = this.nextNavItemId()
      item.parent = parent
      this.assignMissingNavItemIds(item.subitems, item.id)
    })
  }

  /**
   * Parses lists in the toc
   * @param  {document} navListHtml
   * @param  {string} parent id
   * @return {array} navigation list
   */
  parseNavList(navListHtml: Element, parent?: string | false): NavItem[] {
    const result: NavItem[] = []

    if (!navListHtml) return result
    if (!navListHtml.children) return result

    for (let i = 0; i < navListHtml.children.length; i++) {
      const child = navListHtml.children[i]!
      const item = this.navItem(child, parent)

      if (item) {
        result.push(item)
      } else if (result.length && isListElement(child)) {
        const previous = result[result.length - 1]!
        const subitems = this.parseNavList(child, previous.id)
        previous.subitems = previous.subitems.concat(subitems)
      }
    }

    return result
  }

  /**
   * Create a navItem
   * @private
   * @param  {element} item
   * @return {object} navItem
   */
  navItem(item: Element, parent?: string | false): NavItem | undefined {
    let id = item.getAttribute('id') || undefined
    let content =
      filterChildren(item, 'a', true) || filterChildren(item, 'span', true)

    if (!content) {
      return
    }

    let src = decodeHref(content.getAttribute('href') || '')

    if (!id) id = src
    if (!id) this._hasMissingNavItemIds = true
    let text = content.textContent || ''

    let subitems: NavItem[] = []
    let nested = filterChildren(item, 'ol', true)
    if (nested) {
      subitems = this.parseNavList(nested, id)
    }

    return {
      id: id,
      href: src,
      label: text,
      subitems: subitems,
      parent: parent,
    }
  }

  /**
   * Parse from a Epub > 3.0 NC
   * @private
   * @param  {document} navHtml
   * @return {array} navigation list
   */
  parseNcx(tocXml: Document) {
    var navPoints = qsa(tocXml, 'navPoint')
    var length = navPoints.length
    var i
    var toc: Record<string, NavItem> = {}
    var list: NavItem[] = []
    var item, parent

    if (!navPoints || length === 0) return list

    for (i = 0; i < length; ++i) {
      item = this.ncxItem(navPoints[i]!)
      if (!item) {
        continue
      }
      toc[item.id as string] = item
      if (!item.parent) {
        list.push(item)
      } else {
        parent = toc[item.parent]
        if (parent) {
          parent.subitems.push(item)
        } else {
          item.parent = undefined
          list.push(item)
        }
      }
    }

    return list
  }

  /**
   * Create a ncxItem
   * @private
   * @param  {element} item
   * @return {object} ncxItem
   */
  ncxItem(item: Element): NavItem | undefined {
    var id = item.getAttribute('id') || false,
      content = directChildByName(item, 'content'),
      navLabel = qs(item, 'navLabel'),
      text = navLabel && navLabel.textContent ? navLabel.textContent : '',
      subitems: NavItem[] = [],
      parentNode = item.parentNode,
      parent

    if (!content || !content.getAttribute('src')) {
      return undefined
    }

    var src = decodeHref(content.getAttribute('src')!)

    if (
      parentNode &&
      (parentNode.nodeName === 'navPoint' ||
        parentNode.nodeName.split(':').slice(-1)[0] === 'navPoint')
    ) {
      parent = (parentNode as Element).getAttribute('id')
    }

    return {
      id: id,
      href: src,
      label: text,
      subitems: subitems,
      parent: parent,
    }
  }

  /**
   * Load Spine Items
   * @param  {object} json the items to be loaded
   * @return {Array} navItems
   */
  load(json: NavigationJsonItem[]): NavItem[] {
    return json.map((item) => {
      item.label = item.title
      item.subitems = item.children ? this.load(item.children) : []
      return item as NavItem
    })
  }

  /**
   * forEach pass through
   * @param  {Function} fn function to run on each item
   * @return {method} forEach loop
   */
  forEach(fn: (item: NavItem, index: number, items: NavItem[]) => void) {
    return this.toc.forEach(fn)
  }
}

export default Navigation
