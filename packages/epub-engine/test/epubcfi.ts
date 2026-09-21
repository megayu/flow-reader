import { assert } from 'vitest'

import EpubCFI from '../src/epubcfi'
import chapterHighlights from './fixtures/chapter1-highlights.xhtml?raw'
import chapter from './fixtures/chapter1.xhtml?raw'
import highlight from './fixtures/highlight.xhtml?raw'

describe('EpubCFI', function () {
  describe('#parse()', function () {
    it('parses supported CFI forms through the constructor and parser', function () {
      const cfi = new EpubCFI()
      assert.equal(new EpubCFI('epubcfi(/6/2[cover]!/6)').spinePos, 0)
      assert.equal(new EpubCFI('epubcfi(/6/2[cover]!/6)', '/6/6[end]').spinePos, 0)
      assert.equal(cfi.parse('epubcfi(/6/2[cover]!/6)').spinePos, 0)
      assert.equal(Reflect.apply(cfi.parse, cfi, ['epubcfi(/6/2[cover]!/6)', '/6/6[end]']).spinePos, 0)

      const offset = cfi.parse('epubcfi(/6/4[chap01ref]!/4[body01]/10[para05]/2/1:3)') as Extract<
        ReturnType<EpubCFI['parse']>,
        { path: unknown }
      >
      assert.equal(offset.path.terminal!.offset, 3)

      const range = cfi.parse('epubcfi(/6/4[chap01ref]!/4[body01]/10[para05],/2/1:1,/3:4)') as Extract<
        ReturnType<EpubCFI['parse']>,
        { path: unknown }
      >
      assert.equal(range.range, true)
      assert.equal(range.start!.steps.length, 2)
      assert.equal(range.end!.steps.length, 1)
      assert.equal(range.start!.terminal!.offset, 1)
      assert.equal(range.end!.terminal!.offset, 4)
    })
  })

  describe('#toString()', function () {
    it('parse a cfi and write it back', function () {
      assert.equal(
        new EpubCFI('epubcfi(/6/2[cover]!/6)').toString(),
        'epubcfi(/6/2[cover]!/6)',
        'output cfi string is same as input',
      )
      assert.equal(
        new EpubCFI('epubcfi(/6/4[chap01ref]!/4[body01]/10[para05]/2/1:3)').toString(),
        'epubcfi(/6/4[chap01ref]!/4[body01]/10[para05]/2/1:3)',
        'output cfi string is same as input',
      )
      assert.equal(
        new EpubCFI('epubcfi(/6/4[chap01ref]!/4[body01]/10[para05],/2/1:1,/3:4)').toString(),
        'epubcfi(/6/4[chap01ref]!/4[body01]/10[para05],/2/1:1,/3:4)',
        'output cfi string is same as input',
      )
    })
  })

  describe('#checkType()', function () {
    it('determines supported CFI input types', function () {
      const cfi = new EpubCFI()
      assert.equal(cfi.checkType('epubcfi(/6/2[cover]!/6)'), 'string')
      assert.equal(cfi.checkType('/6/2[cover]!/6'), false)
      assert.equal(cfi.checkType(new EpubCFI('epubcfi(/6/4[chap01ref]!/4[body01]/10[para05]/2/1:3)')), 'EpubCFI')
      assert.equal(cfi.checkType(document.createElement('div')), 'node')
      assert.equal(cfi.checkType(document.createRange()), 'range')
    })
  })

  describe('#compare()', function () {
    it('compare CFIs', function () {
      var epubcfi = new EpubCFI()

      // Spines
      assert.equal(epubcfi.compare('epubcfi(/6/4[cover]!/4)', 'epubcfi(/6/2[cover]!/4)'), 1, 'First spine is greater')
      assert.equal(epubcfi.compare('epubcfi(/6/4[cover]!/4)', 'epubcfi(/6/6[cover]!/4)'), -1, 'Second spine is greater')

      // First is deeper
      assert.equal(
        epubcfi.compare('epubcfi(/6/2[cover]!/8/2)', 'epubcfi(/6/2[cover]!/6)'),
        1,
        'First Element is after Second',
      )
      assert.equal(
        epubcfi.compare('epubcfi(/6/2[cover]!/4/2)', 'epubcfi(/6/2[cover]!/6)'),
        -1,
        'First Element is before Second',
      )

      // Second is deeper
      assert.equal(
        epubcfi.compare('epubcfi(/6/2[cover]!/8/2)', 'epubcfi(/6/2[cover]!/6/4/2/2)'),
        1,
        'First Element is after Second',
      )
      assert.equal(
        epubcfi.compare('epubcfi(/6/2[cover]!/4/4)', 'epubcfi(/6/2[cover]!/6/4/2/2)'),
        -1,
        'First Element is before Second',
      )
      assert.equal(
        epubcfi.compare('epubcfi(/6/2[cover]!/4/6)', 'epubcfi(/6/2[cover]!/4/6/8/1:0)'),
        -1,
        'First is less specific, so is before Second',
      )

      // Same Depth
      assert.equal(
        epubcfi.compare('epubcfi(/6/2[cover]!/6/8)', 'epubcfi(/6/2[cover]!/6/2)'),
        1,
        'First Element is after Second',
      )
      assert.equal(
        epubcfi.compare('epubcfi(/6/2[cover]!/4/20)', 'epubcfi(/6/2[cover]!/6/10)'),
        -1,
        'First Element is before Second',
      )

      // Text nodes
      assert.equal(
        epubcfi.compare('epubcfi(/6/2[cover]!/4/5)', 'epubcfi(/6/2[cover]!/4/3)'),
        1,
        'First TextNode is after Second',
      )
      assert.equal(
        epubcfi.compare('epubcfi(/6/2[cover]!/4/7)', 'epubcfi(/6/2[cover]!/4/13)'),
        -1,
        'First TextNode is before Second',
      )

      // Char offset
      assert.equal(
        epubcfi.compare('epubcfi(/6/2[cover]!/4/5:1)', 'epubcfi(/6/2[cover]!/4/5:0)'),
        1,
        'First Char Offset after Second',
      )
      assert.equal(
        epubcfi.compare('epubcfi(/6/2[cover]!/4/5:2)', 'epubcfi(/6/2[cover]!/4/5:30)'),
        -1,
        'Second Char Offset before Second',
      )

      // Normal example
      assert.equal(
        epubcfi.compare('epubcfi(/6/2[cover]!/4/8/5:1)', 'epubcfi(/6/2[cover]!/4/6/15:2)'),
        1,
        'First Element after Second',
      )
      assert.equal(epubcfi.compare('epubcfi(/6/2[cover]!/4/8/1:0)', 'epubcfi(/6/2[cover]!/4/8/1:0)'), 0, 'All Equal')

      // Different Lengths
      assert.equal(
        epubcfi.compare(
          'epubcfi(/6/16[id42]!/4[5N3C0-8c483216e03a4ff49927fc1a97dc7b2c]/10/1:317)',
          'epubcfi(/6/16[id42]!/4[5N3C0-8c483216e03a4ff49927fc1a97dc7b2c]/10/2[page18]/1:0)',
        ),
        -1,
        'First CFI is before Second',
      )
      assert.equal(
        epubcfi.compare(
          'epubcfi(/6/16[id42]!/4[5N3C0-8c483216e03a4ff49927fc1a97dc7b2c]/12/1:0)',
          'epubcfi(/6/16[id42]!/4[5N3C0-8c483216e03a4ff49927fc1a97dc7b2c]/12/2/1:9)',
        ),
        -1,
        'First CFI is before Second',
      )
      assert.equal(
        epubcfi.compare('epubcfi(/6/16!/4/12/1:0)', 'epubcfi(/6/16!/4/12/2/1:9)'),
        -1,
        'First CFI is before Second',
      )
    })
  })

  describe('#fromNode()', function () {
    var base = '/6/4[chap01ref]'
    // var contents = fs.readFileSync(__dirname + '/fixtures/chapter1-highlights.xhtml', 'utf8');
    var contents = chapterHighlights

    // var serializer = new XMLSerializer();
    // var doc = serializer.serializeToString(contents);
    var doc = new DOMParser().parseFromString(contents, 'application/xhtml+xml')

    it('creates CFIs from supported element and text nodes', function () {
      const cases = [
        [doc.getElementById('c001p0004')!, undefined, 'epubcfi(/6/4[chap01ref]!/4/2/10/2[c001p0004])'],
        [doc.getElementById('c001p0004')!.childNodes[0]!, undefined, 'epubcfi(/6/4[chap01ref]!/4/2/10/2[c001p0004]/1)'],
        [
          doc.getElementById('highlight-1')!.childNodes[0]!,
          'annotator-hl',
          'epubcfi(/6/4[chap01ref]!/4/2/32/2[c001p0017]/1)',
        ],
        [doc.getElementById('highlight-1')!, 'annotator-hl', 'epubcfi(/6/4[chap01ref]!/4/2/32/2[c001p0017])'],
      ] as const

      for (const [node, ignoreClass, expected] of cases) {
        assert.equal(new EpubCFI(node, base, ignoreClass).toString(), expected)
      }
    })
  })

  describe('#fromRange()', function () {
    var base = '/6/4[chap01ref]'

    // var contentsClean = fs.readFileSync(__dirname + '/fixtures/chapter1.xhtml', 'utf8');
    var contentsClean = chapter

    var doc = new DOMParser().parseFromString(contentsClean, 'application/xhtml+xml')

    // var contentsHighlights = fs.readFileSync(__dirname + '/fixtures/chapter1-highlights.xhtml', 'utf8');
    var contentsHighlights = chapterHighlights
    var docHighlights = new DOMParser().parseFromString(contentsHighlights, 'application/xhtml+xml')

    // var highlightContents = fs.readFileSync(__dirname + '/fixtures/highlight.xhtml', 'utf8');
    var highlightContents = highlight
    var docHighlightsAlice = new DOMParser().parseFromString(highlightContents, 'application/xhtml+xml')

    it('creates CFIs from supported range forms', function () {
      {
        var t1 = doc.getElementById('c001p0004')!.childNodes[0]
        var t2 = doc.getElementById('c001p0007')!.childNodes[0]
        var range = doc.createRange()
        var cfi

        range.setStart(t1!, 6)

        cfi = new EpubCFI(range, base)

        assert.equal(cfi.range, false)
        assert.equal(cfi.toString(), 'epubcfi(/6/4[chap01ref]!/4/2/10/2[c001p0004]/1:6)')
      }

      {
        var t1 = doc.getElementById('c001p0004')!.childNodes[0]
        var t2 = doc.getElementById('c001p0007')!.childNodes[0]
        var range = doc.createRange()
        var cfi

        range.setStart(t1!, 6)
        range.setEnd(t2!, 27)

        cfi = new EpubCFI(range, base)

        assert.equal(cfi.range, true)
        assert.equal(cfi.toString(), 'epubcfi(/6/4[chap01ref]!/4/2,/10/2[c001p0004]/1:6,/16/2[c001p0007]/1:27)')
      }

      {
        var t1 = doc.getElementById('c001p0004')!.childNodes[0]
        var range = doc.createRange()
        var cfi

        range.setStart(t1!, 0)
        range.setEnd(t1!, 1)

        cfi = new EpubCFI(range, base)

        assert.equal(cfi.range, true)
        assert.equal(cfi.toString(), 'epubcfi(/6/4[chap01ref]!/4/2/10/2[c001p0004],/1:0,/1:1)')
      }

      {
        var t1 = docHighlights.getElementById('highlight-1')!.childNodes[0]
        var range = docHighlights.createRange()
        var cfi

        range.setStart(t1!, 6)

        cfi = new EpubCFI(range, base, 'annotator-hl')

        assert.equal(cfi.toString(), 'epubcfi(/6/4[chap01ref]!/4/2/32/2[c001p0017]/1:43)')
      }
      {
        var t1 = docHighlights.getElementById('c001s0001')!.childNodes[1]
        var range = docHighlights.createRange()
        var cfi

        range.setStart(t1!, 25)

        cfi = new EpubCFI(range, base, 'annotator-hl')

        assert.equal(cfi.toString(), 'epubcfi(/6/4[chap01ref]!/4/2/4/2[c001s0001]/1:41)')
      }

      {
        var t1 = docHighlightsAlice.getElementById('p2')!.childNodes[1]
        var range = docHighlightsAlice.createRange()
        var cfi

        range.setStart(t1!, 4)

        cfi = new EpubCFI(range, base, 'annotator-hl')

        assert.equal(cfi.toString(), 'epubcfi(/6/4[chap01ref]!/4/4[p2]/1:123)')
      }

      {
        var t1 = docHighlightsAlice.getElementById('p3')!.childNodes[2]
        var range = docHighlightsAlice.createRange()
        var cfi

        range.setStart(t1!, 4)

        cfi = new EpubCFI(range, base)

        assert.equal(cfi.toString(), 'epubcfi(/6/4[chap01ref]!/4/6[p3]/3:4)')
      }
    })
  })

  describe('#toRange()', function () {
    var base = '/6/4[chap01ref]'
    // var contents = fs.readFileSync(__dirname + '/fixtures/chapter1-highlights.xhtml', 'utf8');
    var contents = chapterHighlights

    var doc = new DOMParser().parseFromString(contents, 'application/xhtml+xml')

    // var serializer = new XMLSerializer();
    // console.log(serializer.serializeToString(doc));

    it('restores supported DOM ranges from CFIs', function () {
      {
        var t1 = doc.getElementById('c001p0004')!.childNodes[0]
        var t2 = doc.getElementById('c001p0007')!.childNodes[0]
        var ogRange = doc.createRange()
        var cfi
        var newRange

        ogRange.setStart(t1!, 6)

        cfi = new EpubCFI(ogRange, base)

        // Check it was parse correctly
        assert.equal(cfi.toString(), 'epubcfi(/6/4[chap01ref]!/4/2/10/2[c001p0004]/1:6)')

        // Check the range
        newRange = cfi.toRange(doc)

        assert.equal(newRange!.startContainer, t1)
        assert.equal(newRange!.startOffset, 6)
        assert.equal(newRange!.collapsed, true)
      }

      {
        var t1 = doc.getElementById('c001p0004')!.childNodes[0]
        var t2 = doc.getElementById('c001p0007')!.childNodes[0]
        var ogRange = doc.createRange()
        var cfi
        var newRange

        ogRange.setStart(t1!, 6)
        ogRange.setEnd(t2!, 27)

        cfi = new EpubCFI(ogRange, base)

        // Check it was parse correctly
        assert.equal(cfi.toString(), 'epubcfi(/6/4[chap01ref]!/4/2,/10/2[c001p0004]/1:6,/16/2[c001p0007]/1:27)')

        // Check the range
        newRange = cfi.toRange(doc)

        assert.equal(newRange!.startContainer, t1)
        assert.equal(newRange!.startOffset, 6)

        assert.equal(newRange!.endContainer, t2)
        assert.equal(newRange!.endOffset, 27)

        assert.equal(newRange!.collapsed, false)
      }

      {
        var t1 = doc.getElementById('highlight-1')!.childNodes[0]
        var ogRange = doc.createRange()
        var cfi
        var newRange

        ogRange.setStart(t1!, 6)

        cfi = new EpubCFI(ogRange, base, 'annotator-hl')

        assert.equal(cfi.toString(), 'epubcfi(/6/4[chap01ref]!/4/2/32/2[c001p0017]/1:43)')

        // Check the range
        newRange = cfi.toRange(doc, 'annotator-hl')

        assert.ok(newRange!.startContainer)

        assert.equal(newRange!.startContainer, t1)
        assert.equal(newRange!.startOffset, 6)
      }

      {
        var t1 = doc.getElementById('highlight-2')!.childNodes[0]
        var t2 = doc.getElementById('c001s0001')!.childNodes[1]
        var ogRange = doc.createRange()
        var cfi
        var newRange

        ogRange.setStart(t1!, 5)
        ogRange.setEnd(t2!, 25)

        cfi = new EpubCFI(ogRange, base, 'annotator-hl')

        assert.equal(cfi.toString(), 'epubcfi(/6/4[chap01ref]!/4/2/4/2[c001s0001],/1:5,/1:41)')

        // Check the range
        newRange = cfi.toRange(doc, 'annotator-hl')

        assert.strictEqual(newRange!.startContainer.textContent, t1!.textContent)
        // assert.strictEqual( newRange.startContainer, t1);
        // assert.equal( newRange.startOffset, 5);
      }
    })
  })
})
