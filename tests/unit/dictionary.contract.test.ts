import { expect, test } from 'vitest'

import { DictionaryCoordinator, type DictionaryProvider } from '../../src/dictionary/coordinator'
import { DICTIONARY_DETAIL_HISTORY_LIMIT, pushDictionaryDetailHistory } from '../../src/dictionary/detailHistory'
import {
  MerriamWebsterParseError,
  merriamWebsterExternalUrl,
  parseMerriamWebsterResponse,
} from '../../src/dictionary/providers/merriamWebster'
import { classifyDictionaryQuery, normalizeDictionaryQuery } from '../../src/dictionary/query'

test.describe('dictionary query contract', () => {
  test('trims before validation while preserving internal punctuation and spacing', () => {
    expect(normalizeDictionaryQuery('  “合成词条。”  ')).toEqual({
      language: 'zh',
      text: '“合成词条。”',
    })
    expect(normalizeDictionaryQuery("  'well-being'  ")).toEqual({
      language: 'en',
      text: "'well-being'",
    })
    expect(normalizeDictionaryQuery(`  ${'a'.repeat(16)}  `)).toEqual({
      language: 'en',
      text: 'a'.repeat(16),
    })
    expect(normalizeDictionaryQuery('first\nsecond')).toBeNull()
    expect(normalizeDictionaryQuery('first\tsecond')).toBeNull()
    expect(normalizeDictionaryQuery('a'.repeat(17))).toBeNull()
    expect(normalizeDictionaryQuery(`“${'a'.repeat(16)}${'，'.repeat(7)}”`)).toBeNull()
  })

  test('ignores numbers and punctuation for language analysis but rejects neutral-only text', () => {
    expect(normalizeDictionaryQuery('第，一')).toEqual({
      language: 'zh',
      text: '第，一',
    })
    expect(normalizeDictionaryQuery('word-2')).toEqual({
      language: 'en',
      text: 'word-2',
    })
    expect(normalizeDictionaryQuery('123，。')).toBeNull()
    expect(normalizeDictionaryQuery('😀')).toBeNull()
  })

  test('uses metadata as a candidate and corrects obvious script conflicts', () => {
    expect(classifyDictionaryQuery('词条', 'zh-CN')).toBe('zh')
    expect(classifyDictionaryQuery('entry', '中文')).toBe('en')
    expect(classifyDictionaryQuery('词条entry', 'zh')).toBe('mixed')
    expect(classifyDictionaryQuery('空を見る', 'ja')).toBe('ja')
    expect(classifyDictionaryQuery('été', 'fr')).toBe('fr')
    expect(classifyDictionaryQuery('e\u0301te\u0301', 'fr')).toBe('fr')
    expect(classifyDictionaryQuery('123，。', 'en')).toBe('unknown')
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
        sources.filter((source) => source.status === 'success').map((source) => source.result?.sourceName ?? ''),
      )
    })

    const completed = await session.done

    expect(completed.cancelled).toBe(false)
    expect(completed.sources.map((source) => source.providerId)).toEqual(['first', 'second'])
    expect(completed.sources.map((source) => source.status)).toEqual(['success', 'success'])
    expect(snapshots).toContainEqual(['第二部词典'])
    expect(snapshots.at(-1)).toEqual(['第一部词典', '第二部词典'])
  })

  test('prevents an older lookup from publishing after a new lookup starts', async () => {
    let releaseOldLookup: (() => void) | undefined
    const oldProvider: DictionaryProvider = {
      id: 'old',
      name: 'Old dictionary',
      scope: 'online',
      sourceLanguages: ['zh'],
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
    const newSession = coordinator.lookup('sky', [provider('new', 'en', 0, 'New dictionary')], (sources) => {
      newSnapshots.push(sources.map((source) => source.status))
    })
    releaseOldLookup?.()

    const [oldCompleted, newCompleted] = await Promise.all([oldSession.done, newSession.done])

    expect(oldCompleted.cancelled).toBe(true)
    expect(oldSnapshots).toEqual([['loading']])
    expect(newCompleted.cancelled).toBe(false)
    expect(newSnapshots.at(-1)).toEqual(['success'])
  })

  test('limits local lookups to two without serializing online providers', async () => {
    const localHarness = deferredLocalProviders(3)
    let onlineStarted = false
    const onlineProvider: DictionaryProvider = {
      id: 'online',
      name: 'Online dictionary',
      scope: 'online',
      sourceLanguages: ['en'],
      async lookup(query) {
        onlineStarted = true
        return result('online', 'Online dictionary', query.text)
      },
    }
    const coordinator = new DictionaryCoordinator()

    const session = coordinator.lookup('sky', [...localHarness.providers, onlineProvider])

    await expect.poll(() => localHarness.started).toBe(2)
    expect(localHarness.maxActive).toBe(2)
    expect(onlineStarted).toBe(true)
    localHarness.releaseNext()
    await expect.poll(() => localHarness.started).toBe(3)
    expect(localHarness.maxActive).toBe(2)
    localHarness.releaseAll()

    const completed = await session.done
    expect(completed.cancelled).toBe(false)
    expect(completed.sources.map((source) => source.status)).toEqual(['success', 'success', 'success', 'success'])
    session.cancel()
  })

  test('does not start a queued local lookup after cancellation', async () => {
    const localHarness = deferredLocalProviders(3)
    const coordinator = new DictionaryCoordinator()

    const session = coordinator.lookup('sky', localHarness.providers)
    await expect.poll(() => localHarness.started).toBe(2)

    session.cancel()
    localHarness.releaseAll()

    const completed = await session.done
    expect(completed.cancelled).toBe(true)
    expect(localHarness.started).toBe(2)
    expect(localHarness.active).toBe(0)
  })

  test('isolates provider errors and empty results from successful sources', async () => {
    const providers: DictionaryProvider[] = [
      {
        id: 'failure',
        name: 'Failed dictionary',
        scope: 'online',
        sourceLanguages: ['en'],
        async lookup() {
          throw new Error('provider failed')
        },
      },
      {
        id: 'empty',
        name: 'Empty dictionary',
        scope: 'online',
        sourceLanguages: ['en'],
        async lookup() {
          return null
        },
      },
      provider('success', 'en', 0, 'Successful dictionary'),
    ]

    const completed = await new DictionaryCoordinator().lookup('sky', providers).done

    expect(completed.sources.map((source) => source.status)).toEqual(['error', 'empty', 'success'])
    expect(completed.sources[0]?.error).toBe('provider failed')
  })
})

test.describe('dictionary detail history contract', () => {
  test('ignores the current entry and bounds cyclic internal navigation', () => {
    let history = pushDictionaryDetailHistory([], {
      providerId: 'mdict',
      query: 'root',
    })
    const unchanged = pushDictionaryDetailHistory(history, {
      providerId: 'mdict',
      query: 'root',
    })
    expect(unchanged).toBe(history)

    for (let index = 1; index <= DICTIONARY_DETAIL_HISTORY_LIMIT + 4; index += 1) {
      history = pushDictionaryDetailHistory(history, {
        providerId: 'mdict',
        query: `entry-${index}`,
      })
    }

    expect(history).toHaveLength(DICTIONARY_DETAIL_HISTORY_LIMIT)
    expect(history.at(-1)?.query).toBe(`entry-${DICTIONARY_DETAIL_HISTORY_LIMIT + 4}`)
    expect(history[0]?.query).toBe('entry-5')
  })
})

test.describe('Merriam-Webster response contract', () => {
  test('flattens official sense, bs, pseq, and divided-sense structures', () => {
    const result = parseMerriamWebsterResponse(
      JSON.stringify([
        {
          meta: { id: 'sky:1', stems: ['sky', 'skies'] },
          hom: 1,
          hwi: { hw: 'sky' },
          fl: 'noun',
          shortdef: ['must not be used as the primary definition'],
          def: [
            {
              sseq: [
                [
                  [
                    'sense',
                    {
                      sn: '10 a (1)',
                      dt: [
                        ['text', '{bc}the upper atmosphere {it}seen{/it} from earth'],
                        ['vis', [{ t: 'the {wi}sky{/wi} grew dark before rain' }]],
                      ],
                      sdsense: {
                        sd: 'specifically',
                        dt: [['text', '{bc}the region of clouds']],
                      },
                    },
                  ],
                  [
                    'bs',
                    {
                      sense: {
                        sn: '2',
                        sls: ['informal'],
                        dt: [['text', '{bc}{d_link|heaven|heaven}']],
                      },
                    },
                  ],
                ],
                [
                  [
                    'pseq',
                    [
                      [
                        'sense',
                        {
                          sn: '(1)',
                          dt: [['text', '{bc}weather conditions']],
                        },
                      ],
                    ],
                  ],
                ],
              ],
            },
          ],
        },
        {
          meta: { id: 'sky:2', stems: ['sky', 'skied', 'skying'] },
          hom: 2,
          hwi: { hw: 'sky' },
          fl: 'verb',
          def: [
            {
              sseq: [[['sense', { sn: '1', dt: [['text', '{bc}to hit high into the air']] }]]],
            },
          ],
        },
        {
          meta: { id: 'sky blue', stems: ['sky blue'] },
          hwi: { hw: 'sky blue' },
          fl: 'adjective',
          def: [
            {
              sseq: [[['sense', { dt: [['text', '{bc}a phrase that must be excluded']] }]]],
            },
          ],
        },
      ]),
      'sky',
    )

    expect(result).not.toBeNull()
    if (!result) throw new Error('Expected parsed dictionary entries')
    expect(result.externalUrl).toBe('https://www.merriam-webster.com/dictionary/sky')
    expect(result.content.kind).toBe('entries')
    if (result.content.kind !== 'entries') return
    expect(result.content.entries).toHaveLength(2)
    const firstEntry = result.content.entries[0]
    if (!firstEntry) throw new Error('Expected the first dictionary entry')
    expect(firstEntry).toMatchObject({
      headword: 'sky',
      homograph: 1,
      partOfSpeech: 'noun',
    })
    expect(firstEntry.senses.map((sense) => sense.marker)).toEqual(['10 a (1)', '2', '(1)'])
    expect(firstEntry.senses.map((sense) => sense.markerParts)).toEqual([
      { letter: 'a', number: '10', subnumber: '(1)' },
      { number: '2' },
      { subnumber: '(1)' },
    ])
    expect(firstEntry.senses[0]!.definition).toEqual({
      kind: 'runs',
      runs: [
        { kind: 'plain', text: 'the upper atmosphere ' },
        { kind: 'emphasis', text: 'seen' },
        { kind: 'plain', text: ' from earth; ' },
        { kind: 'label', text: 'specifically' },
        { kind: 'plain', text: ' the region of clouds' },
      ],
    })
    expect(firstEntry.senses[0]!.examples).toEqual([
      {
        kind: 'runs',
        runs: [
          { kind: 'plain', text: 'the ' },
          { kind: 'emphasis', text: 'sky' },
          { kind: 'plain', text: ' grew dark before rain' },
        ],
      },
    ])
    expect(firstEntry.senses[1]!.definition).toEqual({
      kind: 'runs',
      runs: [
        { kind: 'label', text: 'informal' },
        { kind: 'plain', text: ' ' },
        { kind: 'reference', text: 'heaven' },
      ],
    })
    expect(firstEntry.senses[2]).toMatchObject({
      level: 1,
      marker: '(1)',
    })
  })

  test('keeps exact and inflected headword entries while excluding returned phrases', () => {
    const response = (headword: string, stems: string[]) => ({
      meta: { id: headword, stems },
      hwi: { hw: headword.replaceAll(' ', '* ') },
      def: [
        {
          sseq: [[['sense', { dt: [['text', `{bc}definition of ${headword}`]] }]]],
        },
      ],
    })
    const body = JSON.stringify([
      response('company', ['company', 'companies']),
      response('company man', ['company man', 'company men']),
      response('company officer', ['company officer', 'company officers']),
    ])
    const result = parseMerriamWebsterResponse(body, 'companies')

    if (result?.content.kind !== 'entries') return
    expect(result.content.entries.map((entry) => entry.headword)).toEqual(['company'])
    const phraseResult = parseMerriamWebsterResponse(body, 'company man')
    if (phraseResult?.content.kind !== 'entries') return
    expect(phraseResult.content.entries.map((entry) => entry.headword)).toEqual(['company man'])
  })

  test('preserves controlled formatting and cross-reference token text', () => {
    const result = parseMerriamWebsterResponse(
      JSON.stringify([
        {
          hwi: { hw: 'act' },
          def: [
            {
              sseq: [
                [
                  [
                    'sense',
                    {
                      dt: [['text', '{bc}to {it}do{/it}; {dx}see also {dxt|perform||}{/dx}']],
                    },
                  ],
                ],
              ],
            },
          ],
        },
      ]),
      'act',
    )

    expect(result).not.toBeNull()
    if (!result) throw new Error('Expected parsed dictionary entries')
    if (result.content.kind !== 'entries') return
    expect(result.content.entries[0]!.senses[0]!.definition).toEqual({
      kind: 'runs',
      runs: [
        { kind: 'plain', text: 'to ' },
        { kind: 'emphasis', text: 'do' },
        { kind: 'plain', text: '; see also ' },
        { kind: 'reference', text: 'perform' },
      ],
    })
  })

  test('degrades suggestions and malformed entries without using shortdef', () => {
    expect(parseMerriamWebsterResponse(JSON.stringify(['skies', 'sky']), 'ski')).toBeNull()
    expect(
      parseMerriamWebsterResponse(
        JSON.stringify([
          { hwi: { hw: 'broken' }, shortdef: ['fallback is forbidden'] },
          {
            hwi: { hw: 'valid' },
            def: [
              {
                sseq: [[['sense', { dt: [['text', '{bc}a valid definition']] }]]],
              },
            ],
          },
        ]),
        'valid',
      )?.content,
    ).toMatchObject({ entries: [{ headword: 'valid' }] })
    expect(() => parseMerriamWebsterResponse('{', 'sky')).toThrow(MerriamWebsterParseError)
    expect(() => parseMerriamWebsterResponse('x'.repeat(2_000_001), 'sky')).toThrow(MerriamWebsterParseError)
    expect(merriamWebsterExternalUrl('blue sky')).toBe('https://www.merriam-webster.com/dictionary/blue%20sky')
  })
})

function provider(id: string, sourceLanguage: 'zh' | 'en', delayMs: number, sourceName: string): DictionaryProvider {
  return {
    id,
    name: sourceName,
    scope: 'online',
    sourceLanguages: [sourceLanguage],
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

function deferredLocalProviders(count: number) {
  let active = 0
  let maxActive = 0
  let started = 0
  const releases: Array<() => void> = []
  const providers = Array.from({ length: count }, (_, index) => {
    const id = `local-${index + 1}`
    const sourceName = `Local dictionary ${index + 1}`
    return {
      id,
      name: sourceName,
      scope: 'local' as const,
      sourceLanguages: ['en'] as const,
      async lookup(query: { text: string }) {
        started += 1
        active += 1
        maxActive = Math.max(maxActive, active)
        await new Promise<void>((resolve) => releases.push(resolve))
        active -= 1
        return result(id, sourceName, query.text)
      },
    }
  })

  return {
    get active() {
      return active
    },
    get maxActive() {
      return maxActive
    },
    providers,
    releaseAll() {
      releases.splice(0).forEach((release) => release())
    },
    releaseNext() {
      releases.shift()?.()
    },
    get started() {
      return started
    },
  }
}
