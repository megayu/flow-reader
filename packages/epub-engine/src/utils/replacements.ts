export interface ExternalLinkEvent {
  button: number
  ctrlKey: boolean
  external: true
  metaKey: boolean
}
export type LinkHandler = (href: string, event?: ExternalLinkEvent) => void

import { qs } from './core'
import Url from './url'

function isSupportedExternalHref(href: string) {
  return /^(?:https?:\/\/|mailto:)/i.test(href)
}

function isPrimaryClick(event: MouseEvent) {
  return event && event.button === 0
}

function isModifiedClick(event: MouseEvent) {
  return (
    event &&
    (event.metaKey || event.ctrlKey) &&
    !event.altKey &&
    !event.shiftKey
  )
}

/** HTML metadata hooks do not apply to standalone SVG spine documents. */
export function ensureHtmlHead(doc: Document) {
  const root = doc?.documentElement
  if (!root || root.localName?.toLowerCase() !== 'html') return
  let head = Array.from(root.children).find(
    (child) => child.localName.toLowerCase() === 'head',
  )
  if (!head) {
    head = doc.createElementNS(
      root.namespaceURI || 'http://www.w3.org/1999/xhtml',
      'head',
    )
    root.insertBefore(head, root.firstChild)
  }
  return head
}

export function replaceBase(doc: Document, section: { url: string }) {
  var base
  var head
  var url = section.url
  var absolute = url.indexOf('://') > -1

  if (!doc) {
    return
  }

  head = ensureHtmlHead(doc)
  if (!head) return
  base = qs(head, 'base')

  if (!base) {
    base = doc.createElement('base')
    head.insertBefore(base, head.firstChild)
  }

  // Fix for Safari crashing if the url doesn't have an origin
  if (!absolute && window && window.location) {
    url = window.location.origin + url
  }

  base.setAttribute('href', url)
}

export function replaceCanonical(
  doc: Document,
  section: { canonical: string },
) {
  var head
  var link
  var url = section.canonical

  if (!doc) {
    return
  }

  head = ensureHtmlHead(doc)
  if (!head) return
  link = qs(head, "link[rel='canonical']")

  if (link) {
    link.setAttribute('href', url)
  } else {
    link = doc.createElement('link')
    link.setAttribute('rel', 'canonical')
    link.setAttribute('href', url)
    head.appendChild(link)
  }
}

export function replaceMeta(doc: Document, section: { idref: string | null }) {
  var head
  var meta
  var id = section.idref
  if (!doc) {
    return
  }

  head = ensureHtmlHead(doc)
  if (!head) return
  meta = qs(head, "link[property='dc.identifier']")

  if (meta) {
    meta.setAttribute('content', id as string)
  } else {
    meta = doc.createElement('meta')
    meta.setAttribute('name', 'dc.identifier')
    meta.setAttribute('content', id as string)
    head.appendChild(meta)
  }
}

export function replaceLinks(
  this: unknown,
  contents: Element,
  fn: LinkHandler,
) {
  var links = contents.querySelectorAll<HTMLAnchorElement>('a[href]')

  if (!links.length) {
    return
  }

  var base = qs(contents.ownerDocument!, 'base')
  var location = base ? base.getAttribute('href') : undefined
  var replaceLink = function (link: HTMLAnchorElement) {
    var href = link.getAttribute('href')!

    var absolute = href.indexOf('://') > -1
    var supportedExternal = isSupportedExternalHref(href)

    if (absolute || supportedExternal) {
      if (absolute) {
        link.setAttribute('target', '_blank')
      }
      link.onclick = function (event) {
        if (!supportedExternal || !isPrimaryClick(event)) {
          return
        }

        event.preventDefault()
        event.stopPropagation()
        if (event.stopImmediatePropagation) {
          event.stopImmediatePropagation()
        }

        if (isModifiedClick(event)) {
          fn(href, {
            button: event.button,
            ctrlKey: event.ctrlKey,
            external: true,
            metaKey: event.metaKey,
          })
        }

        return false
      }
    } else {
      var linkUrl: Url | undefined
      try {
        linkUrl = new Url(href, location as string | undefined)
      } catch (error) {
        // NOOP
      }

      link.onclick = function () {
        if (linkUrl && linkUrl.hash) {
          fn(linkUrl.Path.path + linkUrl.hash)
        } else if (linkUrl) {
          fn(linkUrl.Path.path)
        } else {
          fn(href)
        }

        return false
      }
    }
  }.bind(this)

  for (var i = 0; i < links.length; i++) {
    replaceLink(links[i]!)
  }
}

export function substitute(
  content: string,
  urls: string[],
  replacements: (string | null | undefined)[],
) {
  urls.forEach(function (url, i) {
    if (url && replacements[i]) {
      // Account for special characters in the file name.
      // See https://stackoverflow.com/a/6318729.
      url = url.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&')
      content = content.replace(new RegExp(url, 'g'), replacements[i]!)
    }
  })
  return content
}
