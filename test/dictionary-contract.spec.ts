import { expect, test } from '@playwright/test'

import {
  DictionaryCoordinator,
  type DictionaryProvider,
} from '../src/dictionary/coordinator'
import {
  classifyDictionaryQuery,
  normalizeDictionaryQuery,
} from '../src/dictionary/query'

test.describe('dictionary query contract', () => {
  test('normalizes a short lookup while rejecting selections that are not words', () => {
    expect(normalizeDictionaryQuery('  “天空。”  ')).toEqual({
      language: 'zh',
      text: '天空',
    })
    expect(normalizeDictionaryQuery("  'well-being'  ")).toEqual({
      language: 'en',
      text: 'well-being',
    })
    expect(normalizeDictionaryQuery('first\nsecond')).toBeNull()
    expect(normalizeDictionaryQuery('😀')).toBeNull()
    expect(normalizeDictionaryQuery('a'.repeat(129))).toBeNull()
  })

  test('classifies Chinese, English, mixed, and unknown query text', () => {
    expect(classifyDictionaryQuery('天空')).toBe('zh')
    expect(classifyDictionaryQuery('sky')).toBe('en')
    expect(classifyDictionaryQuery('天空 sky')).toBe('mixed')
    expect(classifyDictionaryQuery('123')).toBe('unknown')
  })
})

test.describe('dictionary coordinator contract', () => {
  test('keeps configured source order when providers finish out of order', async () => {
    const providers: DictionaryProvider[] = [
      provider('first', 'zh', 20, '第一部词典'),
      provider('second', 'zh', 0, '第二部词典'),
      provider('english-only', 'en', 0, 'Excluded'),
    ]
    const coordinator = new DictionaryCoordinator()
    const snapshots: string[][] = []

    const session = coordinator.lookup('天空', providers, (sources) => {
      snapshots.push(
        sources
          .filter((source) => source.status === 'success')
          .map((source) => source.result?.sourceName ?? ''),
      )
    })

    const completed = await session.done

    expect(completed.cancelled).toBe(false)
    expect(completed.sources.map((source) => source.providerId)).toEqual([
      'first',
      'second',
    ])
    expect(completed.sources.map((source) => source.status)).toEqual([
      'success',
      'success',
    ])
    expect(snapshots).toContainEqual(['第二部词典'])
    expect(snapshots.at(-1)).toEqual(['第一部词典', '第二部词典'])
  })

  test('prevents an older lookup from publishing after a new lookup starts', async () => {
    let releaseOldLookup: (() => void) | undefined
    const oldProvider: DictionaryProvider = {
      id: 'old',
      name: 'Old dictionary',
      scope: 'online',
      sourceLanguage: 'zh',
      async lookup(query) {
        await new Promise<void>((resolve) => {
          releaseOldLookup = resolve
        })
        return result('old', 'Old dictionary', query.text)
      },
    }
    const coordinator = new DictionaryCoordinator()
    const oldSnapshots: string[][] = []
    const newSnapshots: string[][] = []

    const oldSession = coordinator.lookup('天空', [oldProvider], (sources) => {
      oldSnapshots.push(sources.map((source) => source.status))
    })
    const newSession = coordinator.lookup(
      'sky',
      [provider('new', 'en', 0, 'New dictionary')],
      (sources) => {
        newSnapshots.push(sources.map((source) => source.status))
      },
    )
    releaseOldLookup?.()

    const [oldCompleted, newCompleted] = await Promise.all([
      oldSession.done,
      newSession.done,
    ])

    expect(oldCompleted.cancelled).toBe(true)
    expect(oldSnapshots).toEqual([['loading']])
    expect(newCompleted.cancelled).toBe(false)
    expect(newSnapshots.at(-1)).toEqual(['success'])
  })
})

function provider(
  id: string,
  sourceLanguage: 'zh' | 'en',
  delayMs: number,
  sourceName: string,
): DictionaryProvider {
  return {
    id,
    name: sourceName,
    scope: 'online',
    sourceLanguage,
    async lookup(query) {
      await new Promise((resolve) => setTimeout(resolve, delayMs))
      return result(id, sourceName, query.text)
    },
  }
}

function result(sourceId: string, sourceName: string, headword: string) {
  return {
    content: {
      entries: [
        {
          headword,
          senses: [
            {
              definition: { kind: 'plain' as const, text: headword },
            },
          ],
        },
      ],
      kind: 'entries' as const,
    },
    sourceId,
    sourceName,
  }
}
