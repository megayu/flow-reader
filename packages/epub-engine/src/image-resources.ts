const MIN_IMAGE_BYTES = 11 * 256 * 1024
const MAX_IMAGE_BYTES = 16 * 1024 * 1024
const BACKGROUND_EXPIRY_MS = 60_000
const LOCAL_RESOURCE_URL = /^(?:https?:\/\/(?:epub|asset)\.localhost\/|(?:epub|asset):\/\/localhost\/)/i
const originalSources = new Map<string, string>()

interface Resource {
  source: string
  refs: number
  loading: number
  controller: AbortController
  ready: Promise<void>
  url?: string
}

interface ViewImage {
  attributes: Attr[]
  resource?: Resource
}

export interface ImageResourceLease {
  readonly ready: Promise<void>
  readonly images: ReadonlyMap<string, ViewImage>
  serialize(render: () => string): string
  loaded(): void
  release(): void
}

/** Recover the authored resource for previews, downloads and image matching. */
export function originalImageResourceUrl(url: string) {
  return originalSources.get(url) ?? url
}

const XLINK_NAMESPACE = 'http://www.w3.org/1999/xlink'

function candidateKey(source: string) {
  const path = source.split(/[?#]/, 1)[0]!
  try {
    return decodeURIComponent(path)
  } catch {
    return path
  }
}

export class ImageResourceScope {
  private readonly resources = new Map<string, Resource>()
  private chapter = new Set<Resource>()
  private readonly candidates: Set<string>
  private backgroundSince?: number
  private closed = false

  constructor(candidates: readonly string[]) {
    this.candidates = new Set(candidates.filter((url) => LOCAL_RESOURCE_URL.test(url)).map(candidateKey))
  }

  private dispose(resource: Resource) {
    if (this.resources.get(resource.source) === resource) {
      this.resources.delete(resource.source)
      resource.controller.abort()
      if (resource.url) URL.revokeObjectURL(resource.url)
    }
    // Loaded views still need the original address for previews and downloads
    // after background expiry revokes the Blob registration.
    if (resource.refs === 0 && resource.url) originalSources.delete(resource.url)
  }

  private finishLoading(resource: Resource) {
    if (--resource.loading === 0 && resource.controller.signal.aborted) this.dispose(resource)
  }

  private release(resource: Resource) {
    if (--resource.refs === 0 && !this.chapter.has(resource)) this.dispose(resource)
  }

  commit(leases: Iterable<ImageResourceLease | undefined>) {
    const next = new Set<Resource>()
    for (const lease of leases) {
      if (!lease) continue
      for (const { resource } of lease.images.values()) {
        if (resource && !resource.controller.signal.aborted) next.add(resource)
      }
    }
    for (const resource of this.chapter) {
      if (!next.has(resource) && resource.refs === 0) this.dispose(resource)
    }
    this.chapter = next
  }

  updateForeground(foreground: boolean, now: number) {
    if (this.backgroundSince !== undefined && now - this.backgroundSince > BACKGROUND_EXPIRY_MS) {
      this.chapter.clear()
      for (const resource of this.resources.values()) {
        if (resource.url && resource.loading) {
          // Keep an assigned URL usable until the iframe load settles, but
          // exclude it from new acquisitions as soon as it expires.
          resource.controller.abort()
        } else {
          this.dispose(resource)
        }
      }
    }
    this.backgroundSince = foreground ? undefined : (this.backgroundSince ?? now)
  }

  private async load(source: string, resource: Resource) {
    try {
      const response = await fetch(source, { signal: resource.controller.signal })
      if (!response.ok) return
      const blob = await response.blob()
      if (resource.controller.signal.aborted) return
      if (blob.size < MIN_IMAGE_BYTES || blob.size > MAX_IMAGE_BYTES ||
          !/^image\/(?:png|jpeg|gif|webp|avif|bmp)$/i.test(blob.type)) return
      resource.url = URL.createObjectURL(blob)
      originalSources.set(resource.url, source)
    } catch {
      // Preserve normal browser loading/error behavior for failed assets.
    }
  }

  private acquire(source: string) {
    let resource = this.resources.get(source)
    if (resource?.controller.signal.aborted) return
    if (!resource) {
      resource = { source, refs: 0, loading: 0, controller: new AbortController(), ready: Promise.resolve() }
      this.resources.set(source, resource)
      resource.ready = this.load(source, resource)
    }
    resource.refs++
    resource.loading++
    return resource
  }

  /** The view owns this borrow immediately, including while ready is pending. */
  borrow(contents: Element): ImageResourceLease | undefined {
    if (this.closed) return
    const images = new Map<string, ViewImage>()
    for (const image of contents.querySelectorAll('img, image')) {
      const htmlImage = image.localName === 'img'
      // Keep responsive selection and lazy fetching in the browser.
      if (htmlImage && (image.hasAttribute('srcset') || image.parentElement?.localName === 'picture' ||
          image.getAttribute('loading')?.toLowerCase() === 'lazy')) continue
      const attribute = htmlImage
        ? image.getAttributeNode('src')
        : (image.getAttributeNode('href') ?? image.getAttributeNodeNS(XLINK_NAMESPACE, 'href'))
      if (!attribute) continue
      const source = attribute.value
      if (!this.candidates.has(candidateKey(source))) continue
      const entry = images.get(source)
      if (entry) entry.attributes.push(attribute)
      else images.set(source, { attributes: [attribute] })
    }
    if (!images.size) return

    let state: 'loading' | 'loaded' | 'released' = 'loading'
    let cancel!: () => void
    const cancelled = new Promise<void>((resolve) => { cancel = resolve })
    const loaded = () => {
      if (state !== 'loading') return
      state = 'loaded'
      for (const { resource } of images.values()) {
        if (resource) this.finishLoading(resource)
      }
    }
    const release = () => {
      if (state === 'released') return
      loaded()
      state = 'released'
      cancel()
      for (const { resource } of images.values()) {
        if (resource) this.release(resource)
      }
      images.clear()
    }
    const remaining = images.entries()
    const ready = Promise.all(Array.from({ length: Math.min(4, images.size) }, async () => {
      for (const [source, entry] of remaining) {
        if (this.closed) return
        const resource = (entry.resource = this.acquire(source))
        if (resource) await Promise.race([resource.ready, cancelled])
        if (state === 'released') return
        if (!resource?.url || this.resources.get(source) !== resource) {
          images.delete(source)
          if (resource) {
            this.finishLoading(resource)
            this.release(resource)
          }
        }
      }
    })).then(() => {
      if (this.closed || !images.size) release()
    })
    return {
      ready,
      images,
      serialize: (render) => {
        const changed: [Attr, string][] = []
        try {
          for (const [source, { resource, attributes }] of images) {
            const url = this.resources.get(source) === resource ? resource?.url : undefined
            if (!url) continue
            for (const attribute of attributes) {
              if (attribute.value !== source) continue
              changed.push([attribute, source])
              attribute.value = url
            }
          }
          return render()
        } finally {
          for (const [attribute, source] of changed) attribute.value = source
        }
      },
      loaded,
      release,
    }
  }

  destroy() {
    this.closed = true
    this.chapter.clear()
    for (const resource of this.resources.values()) this.dispose(resource)
  }
}
