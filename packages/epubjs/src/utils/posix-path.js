function normalizeParts(parts, allowAboveRoot = false) {
  const normalized = []

  parts.forEach((part) => {
    if (!part || part === '.') return

    if (part === '..') {
      if (normalized.length && normalized[normalized.length - 1] !== '..') {
        normalized.pop()
      } else if (allowAboveRoot) {
        normalized.push('..')
      }
      return
    }

    normalized.push(part)
  })

  return normalized
}

function normalize(pathname, { absolute = pathname.startsWith('/') } = {}) {
  const parts = normalizeParts(pathname.split('/'), !absolute)
  const path = parts.join('/')

  return absolute ? `/${path}` : path || '.'
}

function isAbsolute(pathname) {
  return pathname.startsWith('/')
}

function parse(pathname) {
  const lastSlash = pathname.lastIndexOf('/')
  const dir =
    lastSlash > 0 ? pathname.slice(0, lastSlash) : lastSlash === 0 ? '/' : ''
  const base = lastSlash >= 0 ? pathname.slice(lastSlash + 1) : pathname
  const lastDot = base.lastIndexOf('.')
  const ext = lastDot > 0 ? base.slice(lastDot) : ''
  const name = ext ? base.slice(0, -ext.length) : base

  return { root: isAbsolute(pathname) ? '/' : '', dir, base, ext, name }
}

function dirname(pathname) {
  return parse(pathname).dir || '.'
}

function resolve(...segments) {
  let resolved = ''

  segments.filter(Boolean).forEach((segment) => {
    if (isAbsolute(segment)) {
      resolved = segment
    } else {
      resolved = `${resolved}/${segment}`
    }
  })

  return normalize(resolved, { absolute: true })
}

function relative(from, to) {
  const fromParts = normalize(from, { absolute: true })
    .split('/')
    .filter(Boolean)
  const toParts = normalize(to, { absolute: true }).split('/').filter(Boolean)

  while (fromParts.length && toParts.length && fromParts[0] === toParts[0]) {
    fromParts.shift()
    toParts.shift()
  }

  return [...fromParts.map(() => '..'), ...toParts].join('/') || ''
}

export default {
  dirname,
  isAbsolute,
  parse,
  relative,
  resolve,
}
