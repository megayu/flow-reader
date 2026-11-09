import { expect, it, vi } from 'vitest'

import { ImageResourceScope, originalImageResourceUrl } from '../../packages/epub-engine/src/image-resources'

const chapter = (...attributes: Attr[]) =>
  ({
    querySelectorAll: () =>
      attributes.map((attribute) => ({
        localName: 'img',
        hasAttribute: () => false,
        getAttribute: () => null,
        getAttributeNode: () => attribute,
      })),
  }) as unknown as Element

it('keeps committed chapter images across view replacement and releases images unused by the next chapter', async () => {
  const attribute = (name: string) => ({ value: `http://epub.localhost/book/${name}.png` }) as Attr
  const shared = attribute('shared')
  const old = attribute('old')
  const failed = attribute('failed')
  const scope = new ImageResourceScope([shared.value, old.value, failed.value])
  const fetchResource = globalThis.fetch.bind(globalThis)
  const payload = new Blob([new Uint8Array(11 * 256 * 1024)], { type: 'image/png' })
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) =>
    String(input).startsWith('http://epub.localhost/')
      ? Promise.resolve(new Response(payload))
      : fetchResource(input, init),
  )
  try {
    const outgoing = scope.borrow(chapter(shared, old))!
    await outgoing.ready
    const [sharedUrl, oldUrl] = outgoing.serialize(() => [shared.value, old.value].join(' ')).split(' ')
    outgoing.loaded()
    scope.commit([outgoing])
    outgoing.release()
    expect((await fetchResource(sharedUrl!)).ok).toBe(true)

    const incomplete = scope.borrow(chapter(failed))!
    await incomplete.ready
    const failedUrl = incomplete.serialize(() => failed.value)
    incomplete.release()
    await expect(fetchResource(failedUrl)).rejects.toThrow()

    const incoming = scope.borrow(chapter(shared))!
    await incoming.ready
    expect(incoming.serialize(() => shared.value)).toBe(sharedUrl)
    incoming.loaded()
    scope.commit([incoming])
    await expect(fetchResource(oldUrl!)).rejects.toThrow()

    incoming.release()
    scope.commit([])
    await expect(fetchResource(sharedUrl!)).rejects.toThrow()
  } finally {
    scope.destroy()
    vi.restoreAllMocks()
  }
})
it('expires background reuse without revoking an image that is still loading', async () => {
  const source = 'http://epub.localhost/book/opening.png'
  const scope = new ImageResourceScope([source])
  const attribute = { value: source } as Attr
  const fetchResource = globalThis.fetch.bind(globalThis)
  const payload = new Blob([new Uint8Array(11 * 256 * 1024)], { type: 'image/png' })
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) =>
    String(input) === source ? Promise.resolve(new Response(payload)) : fetchResource(input, init),
  )
  try {
    const loading = scope.borrow(chapter(attribute))!
    await loading.ready
    const openingUrl = loading.serialize(() => attribute.value)
    scope.updateForeground(false, 1000)
    scope.updateForeground(false, 61_000)
    expect((await fetchResource(openingUrl)).ok).toBe(true)
    scope.updateForeground(true, 61_001)
    expect((await fetchResource(openingUrl)).ok).toBe(true)
    loading.loaded()
    await expect(fetchResource(openingUrl)).rejects.toThrow()
    expect(originalImageResourceUrl(openingUrl)).toBe(source)

    const resumed = scope.borrow(chapter(attribute))!
    await resumed.ready
    const resumedUrl = resumed.serialize(() => attribute.value)
    expect(resumedUrl).not.toBe(openingUrl)
    expect((await fetchResource(resumedUrl)).ok).toBe(true)
    scope.destroy()
    await expect(fetchResource(resumedUrl)).rejects.toThrow()
    loading.release()
    resumed.release()
    expect(originalImageResourceUrl(openingUrl)).toBe(openingUrl)
  } finally {
    scope.destroy()
    vi.restoreAllMocks()
  }
})
