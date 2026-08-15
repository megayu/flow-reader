import { beforeEach, describe, expect, test, vi } from 'vitest'

import { parseFlowReaderDeepLink, setupDeepLinks } from '../../src/deepLink'

const deepLinkPlugin = vi.hoisted(() => ({
  cleanup: vi.fn(),
  handler: undefined as ((values: string[]) => void) | undefined,
}))

vi.mock('@tauri-apps/plugin-deep-link', () => ({
  getCurrent: vi.fn(async () => null),
  onOpenUrl: vi.fn(async (handler: (values: string[]) => void) => {
    deepLinkPlugin.handler = handler
    return deepLinkPlugin.cleanup
  }),
}))

beforeEach(() => {
  deepLinkPlugin.cleanup.mockReset()
  deepLinkPlugin.handler = undefined
})

describe('Flow Reader deep-link contract', () => {
  test('resolves a book with an optional CFI and ignores every other query parameter', () => {
    const cfi = 'epubcfi(/6/4[chapter]!/4/2/8,/1:3,/1:12)'

    expect(parseFlowReaderDeepLink('flow-reader://0123456789abcdef')).toEqual({
      bookId: '0123456789abcdef',
    })
    expect(
      parseFlowReaderDeepLink(
        `flow-reader://0123456789abcdef?ignored=open&cfi=${encodeURIComponent(cfi)}&target=annotation`,
      ),
    ).toEqual({
      bookId: '0123456789abcdef',
      cfi,
    })
    expect(parseFlowReaderDeepLink('https://0123456789abcdef?cfi=epubcfi%28%2F6%2F4%29')).toBeUndefined()
    expect(parseFlowReaderDeepLink('flow-reader://0123456789abcdef/chapter?cfi=epubcfi%28%2F6%2F4%29')).toBeUndefined()
  })

  test('continues delivering links after one handler rejects', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const delivered: string[] = []
    const setup = await setupDeepLinks(async ({ bookId }) => {
      delivered.push(bookId)
      if (bookId === 'first') throw new Error('failed request')
    })

    deepLinkPlugin.handler?.(['flow-reader://first'])
    await new Promise<void>((resolve) => setImmediate(resolve))
    deepLinkPlugin.handler?.(['flow-reader://second'])
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(delivered).toEqual(['first', 'second'])
    setup.cleanup()
    consoleError.mockRestore()
  })
})
