const assert = require('assert')
const fs = require('fs')
const Module = require('module')
const path = require('path')

const ts = require('typescript')

const sourcePath = path.join(__dirname, '..', 'src', 'bodyText.ts')
const source = fs.readFileSync(sourcePath, 'utf8')
const { outputText } = ts.transpileModule(source, {
  compilerOptions: {
    esModuleInterop: true,
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2019,
  },
  fileName: sourcePath,
})

const moduleShim = { exports: {} }
const requireShim = (id) => {
  if (id === '@flow/epubjs') return {}
  if (id === './noteIndex') return loadSourceModule('src/noteIndex.ts')
  if (id === './noteSemantics') {
    const isMarker = (text) => /^\[?\d+\]?$/.test((text || '').trim())
    return {
      isNoteBacklinkMarkerText: (text) =>
        isMarker((text || '').replace(/[←↩]/g, '')),
      isNoteMarkerText: isMarker,
    }
  }
  return require(id)
}

function loadSourceModule(relativePath) {
  const localSourcePath = path.join(__dirname, '..', relativePath)
  const localSource = fs.readFileSync(localSourcePath, 'utf8')
  const { outputText: localOutputText } = ts.transpileModule(localSource, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2019,
    },
    fileName: localSourcePath,
  })
  const compiled = new Module(localSourcePath, module)
  compiled.filename = localSourcePath
  compiled.paths = Module._nodeModulePaths(path.dirname(localSourcePath))
  compiled.require = requireShim
  compiled._compile(localOutputText, localSourcePath)
  return compiled.exports
}

const compiledModule = new Module(sourcePath, module)
compiledModule.filename = sourcePath
compiledModule.paths = Module._nodeModulePaths(path.dirname(sourcePath))
compiledModule.require = requireShim
compiledModule._compile(outputText, sourcePath)
moduleShim.exports = compiledModule.exports

const { findReciprocalNoteItem } = loadSourceModule('src/noteIndex.ts')

const {
  bodyTextAttribute,
  bodyTextInlineWrapperAttribute,
  detectBodyTextIndexes,
  ensureBodyTextMarkers,
  getBodyTextCandidates,
  noteContentAttribute,
  noteTextAttribute,
} = moduleShim.exports

class FakeTextNode {
  constructor(text) {
    this.nodeType = 3
    this.textContent = text
  }
}

class FakeClassList {
  constructor(value) {
    this.values = value ? value.split(/\s+/).filter(Boolean) : []
  }

  [Symbol.iterator]() {
    return this.values[Symbol.iterator]()
  }
}

class FakeElement {
  constructor(tagName, options = {}) {
    this.nodeType = 1
    this.tagName = tagName.toUpperCase()
    this.className = options.className || ''
    this.classList = new FakeClassList(this.className)
    this.attributes = options.attributes || {}
    this.style = {
      backgroundColor: 'rgba(0, 0, 0, 0)',
      color: 'rgb(0, 0, 0)',
      display: 'block',
      fontFamily: 'serif',
      fontSize: '16px',
      fontWeight: '400',
      lineHeight: '24px',
      marginBottom: '0px',
      marginTop: '0px',
      textAlign: 'start',
      textIndent: '0px',
      visibility: 'visible',
      ...(options.style || {}),
    }
    this.childNodes = []
    this.parentElement = undefined
  }

  append(...nodes) {
    nodes.forEach((node) => {
      const child = typeof node === 'string' ? new FakeTextNode(node) : node
      if (child.nodeType === 1) child.parentElement = this
      this.childNodes.push(child)
    })
    return this
  }

  get textContent() {
    return this.childNodes.map((node) => node.textContent || '').join('')
  }

  getAttribute(name) {
    return this.attributes[name] || null
  }

  removeAttribute(name) {
    delete this.attributes[name]
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value)
  }

  closest(selector) {
    if (matchesAnySelector(this, selector)) return this

    for (let node = this.parentElement; node; node = node.parentElement) {
      if (matchesAnySelector(node, selector)) return node
    }
  }

  contains(target) {
    if (target === this) return true

    return this.childNodes.some(
      (node) =>
        node === target || (node.nodeType === 1 && node.contains(target)),
    )
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0]
  }

  querySelectorAll(selector) {
    const result = []
    walkElements(this, (el) => {
      if (el !== this && matchesAnySelector(el, selector)) result.push(el)
    })
    return result
  }
}

function walkElements(root, visit) {
  root.childNodes.forEach((node) => {
    if (node.nodeType !== 1) return
    visit(node)
    walkElements(node, visit)
  })
}

function matchesAnySelector(el, selector) {
  return selector
    .split(',')
    .map((part) => part.trim())
    .some((part) => matchesSelector(el, part))
}

function matchesSelector(el, selector) {
  if (!selector) return false
  const tagName = el.tagName.toLowerCase()

  if (selector === 'blockquote > p') {
    return (
      tagName === 'p' &&
      el.parentElement?.tagName.toLowerCase() === 'blockquote'
    )
  }

  if (selector.startsWith('.')) {
    return el.classList.values.includes(selector.slice(1))
  }

  const attrContains = selector.match(/^\[(.+)\*="(.+)"\]$/)
  if (attrContains) {
    const [, attrName, expected] = attrContains
    return (el.getAttribute(attrName.replace('\\:', ':')) || '').includes(
      expected,
    )
  }

  const attrEquals = selector.match(/^\[(.+)="(.+)"\]$/)
  if (attrEquals) {
    const [, attrName, expected] = attrEquals
    return el.getAttribute(attrName.replace('\\:', ':')) === expected
  }

  const attrExists = selector.match(/^\[(.+)\]$/)
  if (attrExists) {
    const [, attrName] = attrExists
    return el.getAttribute(attrName.replace('\\:', ':')) !== null
  }

  const tagAttrExists = selector.match(/^([a-z]+)\[(.+)\]$/)
  if (tagAttrExists) {
    const [, expectedTag, attrName] = tagAttrExists
    return (
      tagName === expectedTag &&
      el.getAttribute(attrName.replace('\\:', ':')) !== null
    )
  }

  return selector === tagName
}

function paragraph(className, text, child) {
  const p = new FakeElement('p', { className })
  p.append(text)
  if (child) p.append(child)
  return p
}

function styledParagraph(className, text, style, child) {
  const p = new FakeElement('p', { className, style })
  p.append(text)
  if (child) p.append(child)
  return p
}

function span(className, text) {
  return new FakeElement('span', { className }).append(text)
}

function anchor(href, text, attributes = {}) {
  return new FakeElement('a', { attributes: { href, ...attributes } }).append(
    text,
  )
}

function createContents(body) {
  const document = {
    body,
    getElementById: (id) => {
      let result
      walkElements(body, (el) => {
        if (!result && el.getAttribute('id') === id) result = el
      })
      return result
    },
    querySelectorAll: (selector) => body.querySelectorAll(selector),
  }
  walkElements(body, (el) => {
    el.ownerDocument = document
  })
  body.ownerDocument = document

  return {
    document,
    window: {
      getComputedStyle: (el) => el.style,
    },
  }
}

function testInlineClassAnnotationPayloadIsNotCountedAsParentBodyText() {
  const body = new FakeElement('body')
  const bodyParagraphs = [
    paragraph(
      'main',
      '这是第一段正文内容，包含足够多的连续叙述文字，用来代表普通正文段落。',
    ),
    paragraph(
      'main',
      '这是第二段正文内容，仍然是普通正文，应当被识别为主体文字。',
    ),
    paragraph(
      'main',
      '这是第三段正文内容，和前面段落保持相同的标签、class 与样式。',
    ),
  ]
  const annotationParagraphs = [
    paragraph(
      'commentary-title',
      '校记',
      span(
        'commentary-body',
        '这里是一大段夹在子元素里的说明文字，它属于注释正文，不应该让父级短标题段落被识别为正文。',
      ),
    ),
    paragraph(
      'commentary-title',
      '笺注',
      span(
        'commentary-body',
        '这里还是一大段夹在子元素里的说明文字，用来模拟注释文本数量很多但父级本身很短的结构。',
      ),
    ),
    paragraph(
      'commentary-title',
      '考订',
      span(
        'commentary-body',
        '这段说明继续提供大量子元素文本，如果统计父级 textContent 就会错误压过真正正文。',
      ),
    ),
    paragraph(
      'commentary-title',
      '补注',
      span(
        'commentary-body',
        '最后一段说明仍然只应该属于子元素，不应该参与父级段落的正文聚类。',
      ),
    ),
  ]

  body.append(...bodyParagraphs, ...annotationParagraphs)

  const contents = createContents(body)
  const candidates = getBodyTextCandidates(contents.document)
  const bodyIndexes = detectBodyTextIndexes(contents, candidates)

  const selectedClasses = bodyIndexes.map(
    (index) => candidates[index].className,
  )

  assert.deepStrictEqual(selectedClasses, ['main', 'main', 'main'])
}

function testSameBaseStyleParagraphsAreCountedAsBodyText() {
  const body = new FakeElement('body')
  const firstParagraph = styledParagraph(
    'first',
    '这是第一段正文内容。',
    { textIndent: '0px' },
    span('first', '一'),
  )
  const bodyParagraphs = [
    styledParagraph(
      '',
      '这是第二段正文内容，仍然是普通正文，应当被识别为主体文字。',
      { textIndent: '32px' },
    ),
    styledParagraph(
      '',
      '这是第三段正文内容，和前面段落保持相同的基础字体样式。',
      { textIndent: '32px' },
    ),
  ]

  body.append(firstParagraph, ...bodyParagraphs)

  const contents = createContents(body)
  const candidates = getBodyTextCandidates(contents.document)
  const bodyIndexes = detectBodyTextIndexes(contents, candidates)

  const selectedClasses = bodyIndexes.map(
    (index) => candidates[index].className,
  )

  assert.deepStrictEqual(selectedClasses, ['first', '', ''])
}

function testInlineWrappedBodyParagraphsAreMarkedForTypographyPiercing() {
  const body = new FakeElement('body')
  const paragraphs = [
    new FakeElement('p', { className: 'calibre7' }).append(
      span(
        'calibre10',
        '这是第一段由直接子级行内容器承载的正文文本，用来模拟转换工具生成的段落结构。',
      ),
    ),
    new FakeElement('p', { className: 'calibre7' }).append(
      span(
        'calibre10',
        '这是第二段由直接子级行内容器承载的正文文本，父级段落本身没有直接文本。',
      ),
    ),
  ]

  body.append(...paragraphs)

  const contents = createContents(body)
  ensureBodyTextMarkers(contents)

  assert.strictEqual(paragraphs[0].getAttribute(bodyTextAttribute), 'true')
  assert.strictEqual(
    paragraphs[0].getAttribute(bodyTextInlineWrapperAttribute),
    'true',
  )
  assert.strictEqual(paragraphs[1].getAttribute(bodyTextAttribute), 'true')
  assert.strictEqual(
    paragraphs[1].getAttribute(bodyTextInlineWrapperAttribute),
    'true',
  )
}

function testLinkedNoteContentIsMarkedStructurally() {
  const body = new FakeElement('body')
  const bodyParagraph = paragraph(
    'main',
    '这是普通正文内容，正文里的脚注引用不应该让整段被标记成注释内容。',
    new FakeElement('sup').append(anchor('notes.html#note-1', '1')),
  )
  const linkedNote = new FakeElement('p', { className: 'footnote' }).append(
    anchor('chapter.html#back-note-1', '[1]'),
    ' 这是通过结构识别出来的注释内容。',
  )
  const classOnlyFootnote = paragraph(
    'footnote',
    '这段只有 footnote class，没有链接关系，不应该被当作可操作注释。',
  )
  const definitionNote = new FakeElement('dl', {
    className: 'footnote',
  }).append(
    new FakeElement('dt').append(
      '[',
      anchor('chapter.html#back-note-2', '←2'),
      ']',
    ),
    new FakeElement('dd').append(
      new FakeElement('p').append('这是定义列表形式的注释内容。'),
    ),
  )

  body.append(bodyParagraph, linkedNote, classOnlyFootnote, definitionNote)

  const contents = createContents(body)
  ensureBodyTextMarkers(contents)

  assert.strictEqual(linkedNote.getAttribute(noteContentAttribute), 'true')
  assert.strictEqual(linkedNote.getAttribute(noteTextAttribute), 'true')
  assert.strictEqual(definitionNote.getAttribute(noteContentAttribute), 'true')
  assert.strictEqual(definitionNote.getAttribute(noteTextAttribute), 'true')
  assert.strictEqual(classOnlyFootnote.getAttribute(noteContentAttribute), null)
  assert.strictEqual(bodyParagraph.getAttribute(noteContentAttribute), null)
}

function testReciprocalNoteItemRequiresBacklinkToSourceAnchor() {
  const body = new FakeElement('body')
  const source = anchor('notes.html#note-1', '[1]', { id: 'back-note-1' })
  const sourceParagraph = new FakeElement('p').append(
    '正文带有注释引用',
    source,
  )
  const noteLink = anchor('chapter.html#back-note-1', '[1]', { id: 'note-1' })
  const noteItem = new FakeElement('p').append(
    noteLink,
    ' 这是双向链接确认后的注释。',
  )
  const wrongBacklink = anchor('chapter.html#other-ref', '[2]', {
    id: 'note-2',
  })
  const wrongNoteItem = new FakeElement('p').append(
    wrongBacklink,
    ' 这条没有指回正文引用。',
  )
  const definitionSource = anchor('notes.html#note-3', '3')
  const definitionMarker = new FakeElement('sup', {
    attributes: { id: 'back-note-3' },
  }).append(definitionSource)
  const definitionSourceParagraph = new FakeElement('p').append(
    '正文里的定义列表注释引用',
    definitionMarker,
  )
  const definitionNote = new FakeElement('dl', {
    attributes: { id: 'note-3' },
  }).append(
    new FakeElement('dt').append(
      '[',
      anchor('chapter.html#back-note-3', '←3'),
      ']',
    ),
    new FakeElement('dd').append(new FakeElement('p').append('定义列表注释。')),
  )

  body.append(
    sourceParagraph,
    noteItem,
    wrongNoteItem,
    definitionSourceParagraph,
    definitionNote,
  )
  createContents(body)

  assert.strictEqual(findReciprocalNoteItem(source, noteLink), noteItem)
  assert.strictEqual(findReciprocalNoteItem(source, wrongBacklink), undefined)
  assert.strictEqual(
    findReciprocalNoteItem(definitionSource, definitionNote),
    definitionNote,
  )
}

testInlineClassAnnotationPayloadIsNotCountedAsParentBodyText()
testSameBaseStyleParagraphsAreCountedAsBodyText()
testInlineWrappedBodyParagraphsAreMarkedForTypographyPiercing()
testLinkedNoteContentIsMarkedStructurally()
testReciprocalNoteItemRequiresBacklinkToSourceAnchor()
console.log('body-text tests passed')
