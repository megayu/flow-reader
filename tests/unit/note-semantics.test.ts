import assert from 'node:assert/strict'

import { test } from 'vitest'

import * as noteSemanticsModule from '../../src/noteSemantics.ts'

const noteSemantics = noteSemanticsModule as Record<string, any>

function testNoteMarkersSupportCjkBrackets() {
  assert.strictEqual(typeof noteSemantics.isNoteMarkerText, 'function', 'Expected note marker recognition to be shared')

  assert.strictEqual(noteSemantics.isNoteMarkerText('[67]'), true)
  assert.strictEqual(noteSemantics.isNoteMarkerText('〚95〛'), true)
  assert.strictEqual(noteSemantics.isNoteMarkerText('〖95〗'), true)
  assert.strictEqual(noteSemantics.isNoteMarkerText('【零】'), true)
  assert.strictEqual(noteSemantics.isNoteMarkerText('【九】'), true)
  assert.strictEqual(noteSemantics.isNoteMarkerText('【壹拾貳】'), true)
  assert.strictEqual(noteSemantics.isNoteMarkerText('〚note〛'), false)
}

test(testNoteMarkersSupportCjkBrackets.name, testNoteMarkersSupportCjkBrackets)
