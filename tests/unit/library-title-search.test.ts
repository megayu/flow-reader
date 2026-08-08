import assert from 'node:assert/strict'

import { test } from 'vitest'

import { createLibraryTitleSearchCandidates, matchesLibraryTitleSearch } from '../../src/library/titleSearch.ts'

function testLibraryTitleSearchNormalizationAndMatching() {
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
    const actualCandidates = createLibraryTitleSearchCandidates(title)
    assert.deepEqual(actualCandidates, candidates)
    for (const query of matchingQueries) {
      assert.equal(matchesLibraryTitleSearch(actualCandidates, query), true)
    }
  }

  assert.equal(matchesLibraryTitleSearch(createLibraryTitleSearchCandidates('Building Systems'), 'bui network'), false)
}

test(testLibraryTitleSearchNormalizationAndMatching.name, testLibraryTitleSearchNormalizationAndMatching)
