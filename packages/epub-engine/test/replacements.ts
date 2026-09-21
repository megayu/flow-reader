import { assert } from 'vitest'

import { replaceLinks } from '../src/utils/replacements'

function createDocument(html: string) {
  return new DOMParser().parseFromString(`<html><head></head><body>${html}</body></html>`, 'text/html')
}

describe('Replacements', function () {
  describe('replaceLinks', function () {
    it('applies the external-link click policy across supported links and modifiers', function () {
      const cases: ReadonlyArray<{ ctrlKey?: boolean; href: string; metaKey?: boolean }> = [
        { href: 'https://example.com/path', metaKey: true },
        { href: 'http://example.com/path' },
        { ctrlKey: true, href: 'http://example.com/path' },
        { href: 'mailto:bookquestions@oreilly.com', metaKey: true },
        { href: 'mailto:bookquestions@oreilly.com' },
      ]

      for (const { href, ctrlKey = false, metaKey = false } of cases) {
        const doc = createDocument(`<a href="${href}">link</a>`)
        const calls: {
          href: string
          meta: Parameters<Parameters<typeof replaceLinks>[1]>[1]
        }[] = []
        let bubbled = false

        replaceLinks(doc.body, (emittedHref, meta) => calls.push({ href: emittedHref, meta }))
        doc.body.addEventListener('click', () => {
          bubbled = true
        })

        const link = doc.querySelector('a')!
        const emitted = ctrlKey || metaKey
        const click = new MouseEvent('click', {
          bubbles: true,
          button: 0,
          cancelable: true,
          ctrlKey,
          metaKey,
        })

        if (emitted && href.startsWith('http')) assert.equal(link.getAttribute('target'), '_blank')
        assert.equal(link.dispatchEvent(click), false)
        assert.equal(bubbled, false)
        assert.equal(calls.length, emitted ? 1 : 0)
        if (emitted) {
          assert.deepEqual(calls[0], {
            href,
            meta: { button: 0, ctrlKey, external: true, metaKey },
          })
        }
      }
    })
  })
})
