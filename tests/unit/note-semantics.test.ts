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
  assert.strictEqual(noteSemantics.startsWithNoteMarkerText('零、注释'), true)
  assert.strictEqual(noteSemantics.startsWithNoteMarkerText('壹拾貳、注释'), true)
  assert.strictEqual(noteSemantics.startsWithNoteMarkerText('[1].译者注'), true)
  assert.strictEqual(noteSemantics.startsWithNoteMarkerText('[12]. Translator note'), true)
  assert.strictEqual(noteSemantics.startsWithNoteMarkerText('[1]. 原作者在邮件中指出'), true)
  assert.strictEqual(noteSemantics.isNoteMarkerText('〚note〛'), false)
  assert.strictEqual(noteSemantics.startsWithNoteMarkerText('[note].正文'), false)
}

test(testNoteMarkersSupportCjkBrackets.name, testNoteMarkersSupportCjkBrackets)
