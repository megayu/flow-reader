import type { DictionaryRichDocument } from '../types'

const MAX_STYLESHEETS = 4
const BLOCKED_ELEMENTS = new Set([
  'applet',
  'audio',
  'base',
  'button',
  'canvas',
  'embed',
  'form',
  'frame',
  'frameset',
  'iframe',
  'input',
  'link',
  'math',
  'meta',
  'object',
  'script',
  'select',
  'source',
  'style',
  'svg',
  'textarea',
  'video',
])

interface SanitizeMdictOptions {
  html: string
  loadStylesheet: (key: string) => Promise<string | null>
  resourceUrlPrefix: string
}

export async function sanitizeMdictContent({
  html,
  loadStylesheet,
  resourceUrlPrefix,
}: SanitizeMdictOptions): Promise<DictionaryRichDocument> {
  const source = new DOMParser().parseFromString(html, 'text/html')
  const stylesheetKeys = Array.from(
    source.querySelectorAll<HTMLLinkElement>('link[rel~="stylesheet"][href]'),
  )
    .map((link) => normalizeResourceKey(link.getAttribute('href') ?? ''))
    .filter((key): key is string => Boolean(key))
    .filter((key, index, keys) => keys.indexOf(key) === index)
    .slice(0, MAX_STYLESHEETS)
  const resourceKeys = new Set<string>(stylesheetKeys)
  sanitizeChildren(source.body, resourceUrlPrefix, resourceKeys)

  const sanitizedCss = (
    await Promise.all(
      stylesheetKeys.map(async (key) => {
        try {
          const css = await loadStylesheet(key)
          return css ? sanitizeCss(css, resourceUrlPrefix, resourceKeys) : null
        } catch {
          return null
        }
      }),
    )
  ).filter((css): css is string => Boolean(css))

  return {
    resourceKeys: Array.from(resourceKeys),
    sanitizedCss,
    sanitizedHtml: source.body.innerHTML,
  }
}

function sanitizeChildren(
  root: ParentNode,
  resourceUrlPrefix: string,
  resourceKeys: Set<string>,
) {
  for (const element of Array.from(root.children)) {
    const tag = element.tagName.toLowerCase()
    if (BLOCKED_ELEMENTS.has(tag)) {
      element.remove()
      continue
    }

    const attributes = new Map(
      Array.from(element.attributes).map((attribute) => [
        attribute.name.toLowerCase(),
        attribute.value,
      ]),
    )
    for (const attribute of Array.from(element.attributes)) {
      element.removeAttribute(attribute.name)
    }
    restoreCommonAttributes(element, attributes)

    if (tag === 'a') {
      const entry = internalEntry(attributes.get('href'))
      if (entry) {
        element.setAttribute('href', '#')
        element.setAttribute('data-mdict-entry', entry)
      }
    } else if (tag === 'img') {
      const key = normalizeResourceKey(attributes.get('src') ?? '')
      if (!key || !isBinaryResourceKey(key)) {
        element.remove()
        continue
      }
      resourceKeys.add(key)
      element.setAttribute('src', resourceUrl(resourceUrlPrefix, key))
      element.setAttribute(
        'style',
        'width:auto!important;height:auto!important;max-width:100%!important;cursor:default!important',
      )
      const alt = attributes.get('alt')?.trim()
      if (alt) element.setAttribute('alt', alt.slice(0, 256))
      restoreDimension(element, 'height', attributes.get('height'))
      restoreDimension(element, 'width', attributes.get('width'))
      element.setAttribute('loading', 'lazy')
    } else if (tag === 'td' || tag === 'th') {
      restoreInteger(element, 'colspan', attributes.get('colspan'))
      restoreInteger(element, 'rowspan', attributes.get('rowspan'))
    }

    sanitizeChildren(element, resourceUrlPrefix, resourceKeys)
  }
}

function restoreCommonAttributes(
  element: Element,
  attributes: Map<string, string>,
) {
  const className = attributes
    .get('class')
    ?.split(/\s+/)
    .filter((value) => /^[\w-]{1,64}$/u.test(value))
    .slice(0, 16)
    .join(' ')
  if (className) element.setAttribute('class', className)
  const id = attributes.get('id')
  if (id && /^[\w-]{1,64}$/u.test(id)) element.setAttribute('id', id)
  const lang = attributes.get('lang')
  if (lang && /^[a-z0-9-]{1,32}$/i.test(lang)) {
    element.setAttribute('lang', lang)
  }
  const title = attributes.get('title')?.trim()
  if (title) element.setAttribute('title', title.slice(0, 256))
}

function restoreDimension(
  element: Element,
  name: 'height' | 'width',
  value?: string,
) {
  if (value && /^\d{1,4}$/.test(value)) element.setAttribute(name, value)
}

function restoreInteger(element: Element, name: string, value?: string) {
  if (value && /^(?:[1-9]|1\d|20)$/.test(value)) {
    element.setAttribute(name, value)
  }
}

function internalEntry(href?: string) {
  if (!href?.toLowerCase().startsWith('entry://')) return
  try {
    const entry = decodeURIComponent(href.slice('entry://'.length)).trim()
    if (!entry || entry.length > 128 || /[\u0000-\u001f\u007f]/.test(entry)) {
      return
    }
    return entry
  } catch {
    return
  }
}

function sanitizeCss(
  source: string,
  resourceUrlPrefix: string,
  resourceKeys: Set<string>,
) {
  let css = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/@import\b[\s\S]*?;/gi, '')
    .replace(/(^|[;{])\s*(?:behavior|-moz-binding)\s*:[^;}]*/gi, '$1')
    .replace(/expression\s*\([^)]*\)/gi, '')

  css = css.replace(
    /url\(\s*(["']?)(.*?)\1\s*\)/gi,
    (_match, _quote: string, value: string) => {
      const key = normalizeResourceKey(value)
      if (!key || !isBinaryResourceKey(key)) return 'url("")'
      resourceKeys.add(key)
      return `url("${resourceUrl(resourceUrlPrefix, key)}")`
    },
  )
  return css.trim()
}

function normalizeResourceKey(value: string) {
  const source = value.trim()
  if (!source || source.length > 1024) return
  try {
    const decoded = decodeURIComponent(source)
    if (decoded.includes('%') && decodeURIComponent(decoded) !== decoded) {
      return
    }
    const normalized = decoded.replaceAll('\\', '/').replace(/^\/+/, '')
    if (
      !normalized ||
      /^[a-z][a-z0-9+.-]*:/i.test(normalized) ||
      /[\u0000-\u001f\u007f]/.test(normalized)
    ) {
      return
    }
    const segments = normalized.split('/').filter((segment) => segment !== '.')
    if (
      !segments.length ||
      segments.some(
        (segment) => !segment || segment === '.' || segment === '..',
      )
    ) {
      return
    }
    return segments.join('/')
  } catch {
    return
  }
}

function isBinaryResourceKey(key: string) {
  return /\.(?:gif|jpe?g|otf|png|ttf|webp|woff2?)$/i.test(key)
}

function resourceUrl(prefix: string, key: string) {
  return `${prefix}${key.split('/').map(encodeURIComponent).join('/')}`
}
