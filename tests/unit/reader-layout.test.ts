import assert from 'node:assert/strict'

import { test } from 'vitest'

import * as annotationModule from '../../src/annotation.ts'
import * as contextViewLayoutModule from '../../src/reader/contextViewLayout.ts'
import * as stylesModule from '../../src/styles.ts'

const annotation = annotationModule as Record<string, any>
const contextViewLayout = contextViewLayoutModule as Record<string, any>
const styles = stylesModule as Record<string, any>

function testTextAlignIsNonPaginationStyle() {
  assert.strictEqual(
    typeof styles.createTypographyStyleSignature,
    'function',
    'Expected a style signature separate from pagination layout signature',
  )

  const layoutBase = {
    fontFamily: 'Serif',
    fontSize: '18px',
    fontWeight: 400,
    lineHeight: 1.6,
    textIndent: 2,
    hideEndnotes: false,
    zoom: 1,
    spread: 'auto',
  }

  assert.strictEqual(
    styles.createTypographyLayoutSignature({
      ...layoutBase,
      textAlign: 'default',
    }),
    styles.createTypographyLayoutSignature({
      ...layoutBase,
      textAlign: 'justify',
    }),
    'textAlign must not invalidate pagination layout cache',
  )

  assert.notStrictEqual(
    styles.createTypographyStyleSignature({ textAlign: 'default' }),
    styles.createTypographyStyleSignature({ textAlign: 'justify' }),
    'textAlign must still update current iframe styles immediately',
  )

  for (const pageAppearance of ['cards', 'book', 'divider']) {
    assert.strictEqual(
      styles.createTypographyLayoutSignature({
        ...layoutBase,
        pageAppearance,
      }),
      styles.createTypographyLayoutSignature(layoutBase),
      'page appearance must not invalidate pagination layout cache',
    )
    assert.strictEqual(
      styles.createTypographyStyleSignature({ pageAppearance }),
      styles.createTypographyStyleSignature({}),
      'page appearance must not inject styles into reader iframes',
    )
  }

  assert.notStrictEqual(
    styles.createTypographyLayoutSignature({
      ...layoutBase,
      spread: 'auto',
    }),
    styles.createTypographyLayoutSignature({
      ...layoutBase,
      spread: 'none',
    }),
    'spread changes must invalidate rendered reflowable views',
  )
}

function testVerticalOverlayPlacementStaysInsidePageAndAvoidsSelection() {
  assert.strictEqual(
    typeof contextViewLayout.layoutBesideRect,
    'function',
    'Expected vertical overlays to share a testable side-placement contract',
  )

  const page = { left: 0, top: 0, width: 500, height: 700 }
  const size = { width: 160, height: 220 }

  assert.deepStrictEqual(
    contextViewLayout.layoutBesideRect(page, { left: 300, top: 200, width: 20, height: 80 }, size, {
      preferredSide: 'left',
      gap: 12,
      margin: 10,
    }),
    { left: 128, top: 130, side: 'left' },
    'note popovers should use the physical left side when it fits',
  )

  assert.deepStrictEqual(
    contextViewLayout.layoutBesideRect(page, { left: 20, top: 200, width: 20, height: 80 }, size, {
      preferredSide: 'left',
      gap: 12,
      margin: 10,
    }),
    { left: 52, top: 130, side: 'right' },
    'note popovers should fall back to the physical right side before clipping',
  )

  assert.deepStrictEqual(
    contextViewLayout.layoutBesideRect(page, { left: 250, top: 240, width: 20, height: 20 }, size, {
      preferredSide: 'right',
      gap: 12,
      margin: 10,
    }),
    { left: 282, top: 140, side: 'right' },
    'selection menus should prefer the right side when both sides fit',
  )

  const avoidingSelection = contextViewLayout.layoutBesideRect(
    page,
    { left: 320, top: 240, width: 1, height: 1 },
    size,
    {
      preferredSide: 'right',
      gap: 12,
      margin: 10,
      avoidRects: [{ left: 325, top: 100, width: 165, height: 300 }],
    },
  )
  assert.deepStrictEqual(avoidingSelection, {
    left: 148,
    top: 130.5,
    side: 'left',
  })
}

function testContextViewLayoutClampsOutsideAnchorsToViewport() {
  const viewportSize = 500
  const viewSize = 160
  const anchors = [
    {
      anchor: {
        offset: -24,
        size: 1,
        mode: contextViewLayout.LayoutAnchorMode.ALIGN,
        position: contextViewLayout.LayoutAnchorPosition.Before,
      },
      expected: 0,
    },
    {
      anchor: {
        offset: 560,
        size: 1,
        mode: contextViewLayout.LayoutAnchorMode.ALIGN,
        position: contextViewLayout.LayoutAnchorPosition.After,
      },
      expected: viewportSize - viewSize,
    },
  ]

  for (const { anchor, expected } of anchors) {
    assert.strictEqual(
      contextViewLayout.layout(viewportSize, viewSize, anchor),
      expected,
      'context views must remain fully inside the viewport when the anchor is outside it',
    )
  }
}

function testVerticalRangeRectsFollowReadingOrder() {
  assert.strictEqual(
    typeof annotation.orderRangeRectsForWritingMode,
    'function',
    'Expected vertical range geometry to have an explicit reading-order contract',
  )

  const ordered = annotation.orderRangeRectsForWritingMode(
    [
      { id: 'left-bottom', left: 100, top: 80, width: 20, height: 40 },
      { id: 'right-bottom', left: 300, top: 80, width: 20, height: 40 },
      { id: 'left-top', left: 100, top: 10, width: 20, height: 40 },
      { id: 'right-top', left: 300, top: 10, width: 20, height: 40 },
    ],
    'vertical-rl',
  )

  assert.deepStrictEqual(
    ordered.map((rect: { id: string }) => rect.id),
    ['right-top', 'right-bottom', 'left-top', 'left-bottom'],
  )
}

function testVerticalTypographyCssOverridesAuthorPunctuation() {
  assert.strictEqual(
    typeof styles.createVerticalWritingCss,
    'function',
    'Expected vertical writing overrides to be generated explicitly',
  )

  const css = styles.createVerticalWritingCss('vertical-rl')
  assert.match(css, /writing-mode:\s*vertical-rl\s*!important/)
  assert.match(css, /text-orientation:\s*mixed\s*!important/)
  assert.match(css, /text-indent:\s*var\(--flow-text-indent\)/)
}

for (const run of [
  testTextAlignIsNonPaginationStyle,
  testVerticalOverlayPlacementStaysInsidePageAndAvoidsSelection,
  testContextViewLayoutClampsOutsideAnchorsToViewport,
  testVerticalRangeRectsFollowReadingOrder,
  testVerticalTypographyCssOverridesAuthorPunctuation,
]) {
  test(run.name, run)
}
