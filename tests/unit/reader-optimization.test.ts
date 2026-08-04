import assert from 'node:assert/strict'

import { test } from 'vitest'

import * as annotationModule from '../../src/annotation.ts'
import * as readerModelModule from '../../src/models/reader/model.ts'
import * as noteLinksModule from '../../src/noteLinks.ts'
import * as noteSemanticsModule from '../../src/noteSemantics.ts'
import * as contextViewLayoutModule from '../../src/reader/contextViewLayout.ts'
import * as stylesModule from '../../src/styles.ts'

const annotation = annotationModule as Record<string, any>
const contextViewLayout = contextViewLayoutModule as Record<string, any>
const noteLinks = noteLinksModule as Record<string, any>
const noteSemantics = noteSemanticsModule as Record<string, any>
const readerModel = readerModelModule as Record<string, any>
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

function testZoomBodyStylesSkipNonNumericValues() {
  assert.strictEqual(
    typeof styles.createZoomBodyStyles,
    'function',
    'Expected zoom body styles to be built by a testable helper',
  )

  const result = styles.createZoomBodyStyles(
    {
      width: '',
      height: 'auto',
      columnWidth: '640px',
      columnGap: '32px',
      paddingTop: 'not-a-number',
      paddingBottom: '20px',
      paddingLeft: undefined,
      paddingRight: '0px',
    },
    2,
  )

  assert.deepStrictEqual(result, {
    transformOrigin: 'top left',
    transform: 'scale(2)',
    columnWidth: '320px',
    columnGap: '16px',
    paddingBottom: '10px',
    paddingRight: '0px',
  })
  assert.ok(!Object.values(result).some((value) => String(value).includes('NaN')), 'zoom styles must never emit NaNpx')
}

function testZoomBodyStylesCanUseCurrentLayout() {
  assert.strictEqual(
    typeof styles.createZoomLayoutBodyStyleSource,
    'function',
    'Expected zoom body styles to be buildable from the current layout',
  )

  const source = styles.createZoomLayoutBodyStyleSource(
    {
      name: 'reflowable',
      width: 1000,
      height: 800,
      columnWidth: 460,
      gap: 40,
    },
    'horizontal',
  )
  const result = styles.createZoomBodyStyles(source, 2)

  assert.deepStrictEqual(result, {
    transformOrigin: 'top left',
    transform: 'scale(2)',
    width: '500px',
    height: '400px',
    columnWidth: '230px',
    columnGap: '20px',
    paddingTop: '5px',
    paddingBottom: '5px',
    paddingLeft: '10px',
    paddingRight: '10px',
  })
}

function testZoomBodyStylesUseVerticalPhysicalAxes() {
  const source = styles.createZoomLayoutBodyStyleSource(
    {
      name: 'reflowable',
      width: 1000,
      height: 800,
      columnWidth: 460,
      gap: 40,
    },
    'horizontal',
    'vertical-rl',
  )
  const result = styles.createZoomBodyStyles(source, 2, 'vertical-rl')

  assert.deepStrictEqual(result, {
    transformOrigin: 'top right',
    transform: 'scale(2)',
    width: '500px',
    height: '400px',
    columnWidth: '390px',
    columnHeight: '230px',
    columnGap: '0px',
    rowGap: '20px',
    paddingTop: '5px',
    paddingBottom: '5px',
    paddingLeft: '10px',
    paddingRight: '10px',
  })
}

function testZoomBodyStylesUseSinglePageVerticalStride() {
  const source = styles.createZoomLayoutBodyStyleSource(
    {
      name: 'reflowable',
      width: 1000,
      height: 800,
      columnWidth: 1000,
      gap: 40,
    },
    'horizontal',
    'vertical-rl',
  )

  assert.strictEqual(source.columnHeight, '960px')
  assert.strictEqual(source.rowGap, '40px')
}

function testZoomMediaUsesScaledContentColumnWidth() {
  assert.strictEqual(
    typeof styles.createZoomMediaMaxInlineSize,
    'function',
    'Expected zoom media size to be calculated by a testable helper',
  )
  assert.strictEqual(
    typeof styles.createZoomMediaCss,
    'function',
    'Expected zoom media CSS to be generated by a testable helper',
  )

  const source = styles.createZoomLayoutBodyStyleSource(
    {
      name: 'reflowable',
      width: 1000,
      height: 800,
      columnWidth: 460,
      gap: 40,
    },
    'horizontal',
  )

  assert.strictEqual(styles.createZoomMediaMaxInlineSize(source, 2), 210)
  assert.match(
    styles.createZoomMediaCss(source, 2),
    /max-inline-size:\s*210px !important/,
    'zoomed media must fit within the scaled single-page content column',
  )
}

function testZoomPinsExplicitDecorativeBackgroundsToViewport() {
  assert.strictEqual(
    typeof styles.createZoomDecorativeBackgroundStyles,
    'function',
    'Expected zoom background compensation to be testable',
  )

  assert.deepStrictEqual(
    styles.createZoomDecorativeBackgroundStyles(
      {
        backgroundImage: 'url("../Images/back.png")',
        backgroundRepeat: 'no-repeat',
        backgroundPosition: '100% 100%',
        backgroundPositionX: '100%',
        backgroundPositionY: '100%',
        backgroundSize: '50% auto',
      },
      1.5,
    ),
    {
      backgroundAttachment: 'fixed',
    },
    'bottom decorative backgrounds should use the iframe viewport as their zoom anchor',
  )

  assert.deepStrictEqual(
    styles.createZoomDecorativeBackgroundStyles(
      {
        backgroundImage: 'url("../Images/header.png")',
        backgroundRepeat: 'no-repeat',
        backgroundPosition: '0% 0%',
        backgroundPositionX: '0%',
        backgroundPositionY: '0%',
        backgroundSize: '40% auto',
      },
      1.5,
    ),
    {
      backgroundAttachment: 'fixed',
    },
    'top-left decorative backgrounds with explicit positioning should also use the viewport as their zoom anchor',
  )

  assert.deepStrictEqual(
    styles.createZoomDecorativeBackgroundStyles(
      {
        backgroundImage: 'url("../Images/side.png")',
        backgroundRepeat: 'no-repeat',
        backgroundPosition: '100% 50%',
        backgroundPositionX: '100%',
        backgroundPositionY: '50%',
        backgroundSize: '12em auto',
      },
      1.5,
    ),
    {
      backgroundAttachment: 'fixed',
    },
    'right-center decorative backgrounds with explicit positioning should also use the viewport as their zoom anchor',
  )
}

function testZoomLeavesNonDecorativeBackgroundsAlone() {
  assert.deepStrictEqual(
    styles.createZoomDecorativeBackgroundStyles(
      {
        backgroundImage: 'url("../Images/paper.png")',
        backgroundRepeat: 'repeat-y',
        backgroundPosition: '0% 0%',
        backgroundPositionX: '0%',
        backgroundPositionY: '0%',
        backgroundSize: 'contain',
      },
      1.5,
    ),
    {},
    'repeated or fitted page backgrounds must keep authored sizing',
  )

  assert.deepStrictEqual(
    styles.createZoomDecorativeBackgroundStyles(
      {
        backgroundImage: 'url("../Images/header.png")',
        backgroundRepeat: 'no-repeat',
        backgroundPosition: '50% 0%',
        backgroundPositionX: '50%',
        backgroundPositionY: '0%',
        backgroundSize: 'contain',
      },
      1.5,
    ),
    {},
    'fitted page backgrounds must keep authored sizing',
  )
}

function testAnnotationSpineDoesNotRequireNavItem() {
  assert.strictEqual(
    typeof annotation.createAnnotationSpine,
    'function',
    'Expected annotation spine creation to be independent of navitem',
  )

  assert.deepStrictEqual(
    annotation.createAnnotationSpine({
      index: 3,
      href: 'Text/chapter-3.xhtml',
      navitem: { label: 'Chapter 3' },
    }),
    {
      index: 3,
      href: 'Text/chapter-3.xhtml',
      title: 'Chapter 3',
    },
  )

  assert.deepStrictEqual(
    annotation.createAnnotationSpine({
      index: 4,
      href: 'Text/chapter-4.xhtml',
    }),
    {
      index: 4,
      href: 'Text/chapter-4.xhtml',
    },
  )
}

function testEpubHrefComparisonHandlesEncodedSpinePaths() {
  assert.strictEqual(
    typeof noteLinks.sameHref,
    'function',
    'Expected one shared href comparison helper for reader paths',
  )

  assert.strictEqual(
    noteLinks.sameHref('Text/%2A%3Achapter%3Aone.xhtml', 'Text/*:chapter:one.xhtml'),
    true,
    'decoded NCX targets must match encoded OPF spine hrefs',
  )

  assert.strictEqual(
    noteLinks.sameHref('http://localhost:7127/OEBPS/Images/%2A%3Aplate%3A1.jpg', 'Images/*:plate:1.jpg'),
    true,
    'absolute image URLs must match package-relative resource hrefs',
  )
}

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

function testChapterFindUsesTheReadingOrderStartSection() {
  assert.strictEqual(
    typeof readerModel.readingOrderStartSectionIndex,
    'function',
    'Expected chapter find to share the pagination-model reading order',
  )

  const spread = {
    left: { section: { index: 11 } },
    right: { section: { index: 12 } },
  }
  assert.strictEqual(readerModel.readingOrderStartSectionIndex(spread, 'left-first', 20), 11)
  assert.strictEqual(readerModel.readingOrderStartSectionIndex(spread, 'right-first', 20), 12)
  assert.strictEqual(readerModel.readingOrderStartSectionIndex(undefined, undefined, 20), 20)
}

function testClosingBackgroundTabsPreservesTheSelectedTab() {
  const pages = ['A', 'B', 'C', 'D'].map((name) => {
    const Page = () => null
    Page.displayName = name
    return Page
  })
  const group = new readerModel.Group(pages, 2)
  const selectedTab = group.selectedTab

  group.removeTab(0)
  assert.strictEqual(group.selectedTab, selectedTab)

  group.removeTab(group.tabs.length - 1)
  assert.strictEqual(group.selectedTab, selectedTab)
}

for (const run of [
  testTextAlignIsNonPaginationStyle,
  testZoomBodyStylesSkipNonNumericValues,
  testZoomBodyStylesCanUseCurrentLayout,
  testZoomBodyStylesUseVerticalPhysicalAxes,
  testZoomBodyStylesUseSinglePageVerticalStride,
  testZoomMediaUsesScaledContentColumnWidth,
  testZoomPinsExplicitDecorativeBackgroundsToViewport,
  testZoomLeavesNonDecorativeBackgroundsAlone,
  testAnnotationSpineDoesNotRequireNavItem,
  testEpubHrefComparisonHandlesEncodedSpinePaths,
  testNoteMarkersSupportCjkBrackets,
  testChapterFindUsesTheReadingOrderStartSection,
  testClosingBackgroundTabsPreservesTheSelectedTab,
  testVerticalOverlayPlacementStaysInsidePageAndAvoidsSelection,
  testContextViewLayoutClampsOutsideAnchorsToViewport,
  testVerticalRangeRectsFollowReadingOrder,
  testVerticalTypographyCssOverridesAuthorPunctuation,
]) {
  test(run.name, run)
}
