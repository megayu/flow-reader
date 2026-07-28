import { expect, test } from 'vitest'

import { resolveBookSpreadPolicy } from '@/reader/spreadPolicy'
import { RenditionSpread } from '@flow/epubjs/rendition'

test('resolves one book-wide spread policy by explicit precedence', () => {
  const cases = [
    {
      input: {
        temporaryOverride: RenditionSpread.None,
        perBookOverride: RenditionSpread.Auto,
        publicationSpread: 'both',
        applicationDefault: RenditionSpread.Auto,
      },
      expected: RenditionSpread.None,
    },
    {
      input: {
        perBookOverride: RenditionSpread.Auto,
        publicationSpread: 'none',
        applicationDefault: RenditionSpread.None,
      },
      expected: RenditionSpread.Auto,
    },
    {
      input: {
        publicationSpread: 'none',
        applicationDefault: RenditionSpread.Auto,
      },
      expected: RenditionSpread.None,
    },
    ...['auto', 'landscape', 'both', 'portrait'].map((publicationSpread) => ({
      input: {
        publicationSpread,
        applicationDefault: RenditionSpread.None,
      },
      expected: RenditionSpread.Auto,
    })),
    {
      input: {
        publicationSpread: 'unknown',
        applicationDefault: RenditionSpread.None,
      },
      expected: RenditionSpread.None,
    },
    {
      input: {
        applicationDefault: RenditionSpread.Auto,
      },
      expected: RenditionSpread.Auto,
    },
  ]

  for (const { input, expected } of cases) {
    expect(resolveBookSpreadPolicy(input)).toBe(expected)
  }
})
