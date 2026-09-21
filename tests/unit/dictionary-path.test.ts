import { expect, test } from 'vitest'

import { formatLocalPathForDisplay } from '../../src/dictionary/path'

test('formats native dictionary paths for display without changing portable paths', () => {
  const cases = [
    [
      '\\\\?\\C:\\Users\\reader\\Dictionaries\\Oxford\\oxford.ifo',
      'C:\\Users\\reader\\Dictionaries\\Oxford\\oxford.ifo',
    ],
    [
      '\\\\?\\UNC\\dictionary-server\\shared\\Chinese\\source.mdx',
      '\\\\dictionary-server\\shared\\Chinese\\source.mdx',
    ],
    ['/home/reader/dictionaries/english/source.ifo', '/home/reader/dictionaries/english/source.ifo'],
  ] as const

  for (const [path, expected] of cases) {
    expect(formatLocalPathForDisplay(path)).toBe(expected)
  }
})
