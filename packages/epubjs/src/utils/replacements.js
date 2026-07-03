import { qs, qsa } from './core'
import Path from './path'
import Url from './url'

function isSupportedExternalHref(href) {
  return /^(?:https?:\/\/|mailto:)/i.test(href)
}

function isPrimaryClick(event) {
  return event && event.button === 0
}

function isModifiedClick(event) {
  return (
    event &&
    (event.metaKey || event.ctrlKey) &&
    !event.altKey &&
    !event.shiftKey
  )
}

export function replaceBase(doc, section) {
  var base
  var head
  var url = section.url
  var absolute = url.indexOf('://') > -1

  if (!doc) {
    return
  }

  head = qs(doc, 'head')
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

export function replaceCanonical(doc, section) {
  var head
  var link
  var url = section.canonical

  if (!doc) {
    return
  }

  head = qs(doc, 'head')
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

export function replaceMeta(doc, section) {
  var head
  var meta
  var id = section.idref
  if (!doc) {
    return
  }

  head = qs(doc, 'head')
  meta = qs(head, "link[property='dc.identifier']")

  if (meta) {
    meta.setAttribute('content', id)
  } else {
    meta = doc.createElement('meta')
    meta.setAttribute('name', 'dc.identifier')
    meta.setAttribute('content', id)
    head.appendChild(meta)
  }
}

// TODO: move me to Contents
export function replaceLinks(contents, fn) {
  var links = contents.querySelectorAll('a[href]')

  if (!links.length) {
    return
  }

  var base = qs(contents.ownerDocument, 'base')
  var location = base ? base.getAttribute('href') : undefined
  var replaceLink = function (link) {
    var href = link.getAttribute('href')

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
      var linkUrl
      try {
        linkUrl = new Url(href, location)
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
    replaceLink(links[i])
  }
}

export function substitute(content, urls, replacements) {
  urls.forEach(function (url, i) {
    if (url && replacements[i]) {
      // Account for special characters in the file name.
      // See https://stackoverflow.com/a/6318729.
      url = url.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&')
      content = content.replace(new RegExp(url, 'g'), replacements[i])
    }
  })
  return content
}
