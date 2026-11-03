// Blob URLs are shared across views, but owned by the book that loaded them.
// The budget includes retired URLs still held by loading views. Those URLs
// cannot be revoked until loading finishes, and must not free budget early.
const BYTE_LIMIT = 64 * 1024 * 1024
const ENTRY_LIMIT = 128
const entries = new Map<Entry, true>()
const originalSources = new Map<string, string>()
let bytes = 0
let registeredEntries = 0

interface Entry {
  scope: ImageResourceScope
  source: string
  url: string
  size: number
  users: number
  loadingUsers: number
  retired: boolean
  revoked: boolean
}

export interface ImageResourceLease {
  content: string
  loaded(): void
  release(): void
}

function revoke(entry: Entry) {
  if (!entry.users) originalSources.delete(entry.url)
  if (!entry.revoked) {
    URL.revokeObjectURL(entry.url)
    entry.revoked = true
    bytes -= entry.size
    registeredEntries--
  }
}

/** Recover the authored resource for previews, downloads and image matching. */
export function originalImageResourceUrl(url: string) {
  return originalSources.get(url) ?? url
}

function retire(entry: Entry) {
  if (entry.retired) return
  entry.retired = true
  entries.delete(entry)
  entry.scope.forget(entry)
  if (!entry.loadingUsers) revoke(entry)
}

function makeRoom(size: number) {
  for (const entry of entries.keys()) {
    if (bytes + size <= BYTE_LIMIT && registeredEntries < ENTRY_LIMIT) break
    if (!entry.loadingUsers) retire(entry)
  }
  return bytes + size <= BYTE_LIMIT && registeredEntries < ENTRY_LIMIT
}

const scopes = new Set<ImageResourceScope>()

/** Release reusable images on an OS memory warning, without polling. */
export function releaseImageResourceCaches() {
  for (const scope of scopes) scope.releaseCache()
}

// Attribute scanning preserves the original serialized document and its CFIs.
// Preserve comments/raw text and quoted '>' characters rather than treating
// authored image-looking strings as actual resource references.
const IMAGE_TAG = /<!--[\s\S]*?-->|<(?:[\w-]+:)?(script|style|textarea|title)\b(?:[^<>"']|"[^"]*"|'[^']*')*>[\s\S]*?<\/(?:[\w-]+:)?\1\s*>|<(?:[\w-]+:)?(?:img|image)\b(?:[^<>"']|"[^"]*"|'[^']*')*>/gi
const IS_IMAGE_TAG = /^<(?:[\w-]+:)?(?:img|image)\b/i
const ATTRIBUTE = /([\w:-]+\s*=\s*)(["'])(.*?)\2/g
const LOCAL_IMAGE =
  /^(?:https?:\/\/(?:epub|asset)\.localhost\/|(?:epub|asset):\/\/localhost\/)[^?#]+\.(?:png|jpe?g|gif|webp|avif|bmp)(?:[?#].*)?$/i

function attributeValue(value: string) {
  return value.replace(/&(?:amp|quot|apos|lt|gt|#\d+|#x[\da-f]+);/gi, (entity) => {
    const named: Record<string, string> = { '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>' }
    if (entity[1] !== '#') return named[entity.toLowerCase()] ?? entity
    const hex = entity[2]?.toLowerCase() === 'x'
    const point = Number.parseInt(entity.slice(hex ? 3 : 2, -1), hex ? 16 : 10)
    return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : entity
  })
}

export class ImageResourceScope {
  private readonly cached = new Map<string, Entry>()
  private readonly live = new Set<Entry>()
  private readonly pending = new Map<string, { controller: AbortController; result: Promise<Entry | undefined> }>()
  private closed = false
  private generation = 0

  constructor() {
    scopes.add(this)
  }

  forget(entry: Entry) {
    if (this.cached.get(entry.source) === entry) this.cached.delete(entry.source)
    if (!entry.users) this.live.delete(entry)
  }

  private async acquire(source: string): Promise<Entry | undefined> {
    if (this.closed) return
    let entry = this.cached.get(source)
    if (!entry) {
      let pending = this.pending.get(source)
      if (!pending) {
        const controller = new AbortController()
        const generation = this.generation
        const result = (async () => {
          try {
            const response = await fetch(source, { signal: controller.signal })
            if (!response.ok) return
            const blob = await response.blob()
            if (this.closed || generation !== this.generation || controller.signal.aborted) return
            // Fall back to the authored URL when loading leases occupy the
            // budget; never retain another Blob outside the capacity limit.
            if (blob.size > BYTE_LIMIT || !/^image\/(?:png|jpeg|gif|webp|avif|bmp)$/i.test(blob.type)) return
            if (!makeRoom(blob.size)) return
            const loaded: Entry = {
              scope: this,
              source,
              url: URL.createObjectURL(blob),
              size: blob.size,
              users: 0,
              loadingUsers: 0,
              retired: false,
              revoked: false,
            }
            this.live.add(loaded)
            originalSources.set(loaded.url, source)
            this.cached.set(source, loaded)
            entries.set(loaded, true)
            bytes += loaded.size
            registeredEntries++
            return loaded
          } catch {
            // Preserve normal browser loading/error behavior for failed assets.
            return undefined
          }
        })()
        pending = { controller, result }
        this.pending.set(source, pending)
        void result.finally(() => {
          if (this.pending.get(source) === pending) this.pending.delete(source)
        })
      }
      entry = await pending.result
    }
    if (!entry || this.closed || entry.revoked) return
    entry.users++
    entry.loadingUsers++
    if (!entry.retired) {
      entries.delete(entry)
      entries.set(entry, true)
    }
    return entry
  }

  async prepare(content: string): Promise<ImageResourceLease> {
    const sources = new Set<string>()
    for (const match of content.matchAll(IMAGE_TAG)) {
      if (!IS_IMAGE_TAG.test(match[0])) continue
      // Let the browser choose responsive candidates; do not fetch an unused src.
      if (/\bsrcset\s*=/i.test(match[0])) continue
      for (const attribute of match[0].matchAll(ATTRIBUTE)) {
        if (!/^(?:src|(?:xlink:)?href)\s*=/i.test(attribute[1]!)) continue
        const source = attributeValue(attribute[3]!)
        if (LOCAL_IMAGE.test(source)) sources.add(source)
      }
    }
    const acquired = new Map<string, Entry>()
    const remaining = sources.values()
    // Bound concurrent fetches in image-heavy chapters without a task per image.
    await Promise.all(
      Array.from({ length: Math.min(4, sources.size) }, async () => {
        for (const source of remaining) {
          const entry = await this.acquire(source)
          if (entry) acquired.set(source, entry)
        }
      }),
    )
    let loading = true
    const loaded = () => {
      if (!loading) return
      loading = false
      for (const entry of acquired.values()) {
        entry.loadingUsers--
        // Loaded elements retain their image resource independently of the URL
        // registry. Future documents always resolve from the canonical source.
        if (entry.retired && !entry.loadingUsers) revoke(entry)
      }
    }
    const release = () => {
      loaded()
      for (const entry of acquired.values()) {
        entry.users--
        if (!entry.users && entry.retired) {
          revoke(entry)
          this.live.delete(entry)
        }
      }
      acquired.clear()
    }
    if (this.closed) {
      release()
      return { content, loaded, release }
    }
    return {
      content: content.replace(IMAGE_TAG, (tag) =>
        !IS_IMAGE_TAG.test(tag) || /\bsrcset\s*=/i.test(tag)
          ? tag
          : tag.replace(ATTRIBUTE, (attribute, prefix: string, quote: string, value: string) => {
              if (!/^(?:src|(?:xlink:)?href)\s*=/i.test(prefix)) return attribute
              const entry = acquired.get(attributeValue(value))
              return entry ? `${prefix}${quote}${entry.url}${quote}` : attribute
            }),
      ),
      loaded,
      release,
    }
  }

  releaseCache() {
    this.generation++
    for (const pending of this.pending.values()) pending.controller.abort()
    this.pending.clear()
    for (const entry of this.cached.values()) retire(entry)
  }

  destroy() {
    this.closed = true
    this.releaseCache()
    for (const entry of this.live) revoke(entry)
    this.live.clear()
    scopes.delete(this)
  }
}
