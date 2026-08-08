import assert from 'node:assert/strict'

import { test } from 'vitest'

import { createTextSearchIndex, matchesTextSearch } from '../../src/search/textSearch.ts'

function testTextSearchNormalizationAndMatching() {
  const cases = [
    {
      candidates: ['buildingsystems', 'bs'],
      matchingQueries: ['bui     sys'],
      title: 'Building Systems',
    },
    {
      candidates: ['数据结构', 'sjjg'],
      matchingQueries: ['数据', 'sj'],
      title: '数据结构',
    },
    {
      candidates: ['rust数据结构', 'rustsjjg', 'rsjjg'],
      matchingQueries: ['rust sj', 'rsjj'],
      title: 'Rust 数据结构',
    },
  ]

  for (const { candidates, matchingQueries, title } of cases) {
    const actualCandidates = createTextSearchIndex([title])
    assert.deepEqual(actualCandidates, candidates)
    for (const query of matchingQueries) {
      assert.equal(matchesTextSearch(actualCandidates, query), true)
    }
  }

  const fontAliases = createTextSearchIndex(['思源宋体', 'Source Han Serif'])
  assert.equal(matchesTextSearch(fontAliases, 'syst source'), true)
  assert.equal(matchesTextSearch(createTextSearchIndex(['Building Systems']), 'bui network'), false)
}

test(testTextSearchNormalizationAndMatching.name, testTextSearchNormalizationAndMatching)
