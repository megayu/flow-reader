/* eslint-env mocha */

import assert from 'assert'

import { replaceLinks } from '../src/utils/replacements'

function createDocument(html) {
  return new DOMParser().parseFromString(
    `<html><head></head><body>${html}</body></html>`,
    'text/html',
  )
}

describe('Replacements', function () {
  describe('replaceLinks', function () {
    it('emits modified primary clicks for external http links', function () {
      const doc = createDocument('<a href="https://example.com/path">link</a>')
      const calls = []

      replaceLinks(doc.body, (href, meta) => calls.push({ href, meta }))

      const link = doc.querySelector('a')
      const click = new MouseEvent('click', {
        bubbles: true,
        button: 0,
        cancelable: true,
        metaKey: true,
      })

      assert.equal(link.getAttribute('target'), '_blank')
      assert.equal(link.dispatchEvent(click), false)
      assert.equal(calls.length, 1)
      assert.equal(calls[0].href, 'https://example.com/path')
      assert.deepEqual(calls[0].meta, {
        button: 0,
        ctrlKey: false,
        external: true,
        metaKey: true,
      })
    })

    it('consumes ordinary primary clicks for external http links without emitting', function () {
      const doc = createDocument('<a href="http://example.com/path">link</a>')
      const calls = []
      let bubbled = false

      replaceLinks(doc.body, (href, meta) => calls.push({ href, meta }))
      doc.body.addEventListener('click', () => {
        bubbled = true
      })

      const link = doc.querySelector('a')
      const click = new MouseEvent('click', {
        bubbles: true,
        button: 0,
        cancelable: true,
      })

      assert.equal(link.dispatchEvent(click), false)
      assert.equal(calls.length, 0)
      assert.equal(bubbled, false)
    })

    it('emits ctrl primary clicks for external http links', function () {
      const doc = createDocument('<a href="http://example.com/path">link</a>')
      const calls = []

      replaceLinks(doc.body, (href, meta) => calls.push({ href, meta }))

      const link = doc.querySelector('a')
      const click = new MouseEvent('click', {
        bubbles: true,
        button: 0,
        cancelable: true,
        ctrlKey: true,
      })

      assert.equal(link.dispatchEvent(click), false)
      assert.equal(calls.length, 1)
      assert.equal(calls[0].href, 'http://example.com/path')
      assert.deepEqual(calls[0].meta, {
        button: 0,
        ctrlKey: true,
        external: true,
        metaKey: false,
      })
    })

    it('emits modified primary clicks for mailto links', function () {
      const doc = createDocument(
        '<a href="mailto:bookquestions@oreilly.com">bookquestions@oreilly.com</a>',
      )
      const calls = []

      replaceLinks(doc.body, (href, meta) => calls.push({ href, meta }))

      const link = doc.querySelector('a')
      const click = new MouseEvent('click', {
        bubbles: true,
        button: 0,
        cancelable: true,
        metaKey: true,
      })

      assert.equal(link.dispatchEvent(click), false)
      assert.equal(calls.length, 1)
      assert.equal(calls[0].href, 'mailto:bookquestions@oreilly.com')
      assert.deepEqual(calls[0].meta, {
        button: 0,
        ctrlKey: false,
        external: true,
        metaKey: true,
      })
    })

    it('consumes ordinary primary clicks for mailto links without emitting', function () {
      const doc = createDocument(
        '<a href="mailto:bookquestions@oreilly.com">bookquestions@oreilly.com</a>',
      )
      const calls = []
      let bubbled = false

      replaceLinks(doc.body, (href, meta) => calls.push({ href, meta }))
      doc.body.addEventListener('click', () => {
        bubbled = true
      })

      const link = doc.querySelector('a')
      const click = new MouseEvent('click', {
        bubbles: true,
        button: 0,
        cancelable: true,
      })

      assert.equal(link.dispatchEvent(click), false)
      assert.equal(calls.length, 0)
      assert.equal(bubbled, false)
    })
  })
})
