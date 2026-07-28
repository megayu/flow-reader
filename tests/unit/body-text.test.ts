import assert from 'node:assert/strict'
import fs from 'node:fs'
import Module, { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'

type DynamicModule = Module & {
  exports: Record<string, any>
  filename: string
  paths: string[]
  require: (id: string) => any
  _compile(source: string, filename: string): void
}

const NodeModule = Module as typeof Module & {
  _nodeModulePaths(path: string): string[]
}
const loadDependency = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))

const sourcePath = path.join(__dirname, '..', '..', 'src', 'bodyText.ts')
const source = fs.readFileSync(sourcePath, 'utf8')
const { outputText } = ts.transpileModule(source, {
  compilerOptions: {
    esModuleInterop: true,
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2019,
  },
  fileName: sourcePath,
})

const requireShim = (id: string): any => {
  if (id === '@flow/epubjs') return {}
  if (id === './noteIndex') return loadSourceModule('src/noteIndex.ts')
  if (id === './noteSemantics') {
    const isMarker = (text: string) => /^\[?\d+\]?$/.test((text || '').trim())
    return {
      isNoteMarkerText: isMarker,
    }
  }
  return loadDependency(id)
}

function loadSourceModule(relativePath: string) {
  const localSourcePath = path.join(__dirname, '..', '..', relativePath)
  const localSource = fs.readFileSync(localSourcePath, 'utf8')
  const { outputText: localOutputText } = ts.transpileModule(localSource, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2019,
    },
    fileName: localSourcePath,
  })
  const compiled = new Module(localSourcePath) as DynamicModule
  compiled.filename = localSourcePath
  compiled.paths = NodeModule._nodeModulePaths(path.dirname(localSourcePath))
  compiled.require = requireShim
  compiled._compile(localOutputText, localSourcePath)
  return compiled.exports
}

const compiledModule = new Module(sourcePath) as DynamicModule
compiledModule.filename = sourcePath
compiledModule.paths = NodeModule._nodeModulePaths(path.dirname(sourcePath))
compiledModule.require = requireShim
compiledModule._compile(outputText, sourcePath)

const { findReciprocalNoteItem, getNoteIndex } = loadSourceModule('src/noteIndex.ts')

const {
  bodyTextAttribute,
  bodyTextInlineWrapperAttribute,
  bodyTextPreserveFontAttribute,
  detectBodyTextIndexes,
  ensureBodyTextMarkers,
  getBodyTextCandidates,
  noteContentAttribute,
  noteTextAttribute,
} = compiledModule.exports

class FakeTextNode {
  readonly nodeType = 3
  textContent: string

  constructor(text: string) {
    this.textContent = text
  }
}

class FakeClassList {
  values: string[]

  constructor(value: string) {
    this.values = value ? value.split(/\s+/).filter(Boolean) : []
  }

  [Symbol.iterator]() {
    return this.values[Symbol.iterator]()
  }
}

class FakeElement {
  readonly nodeType = 1
  tagName: string
  className: string
  classList: FakeClassList
  attributes: Record<string, string>
  style: Record<string, string>
  childNodes: Array<FakeElement | FakeTextNode>
  parentElement: FakeElement | undefined
  ownerDocument?: any

  constructor(
    tagName: string,
    options: {
      attributes?: Record<string, string>
      className?: string
      style?: Record<string, string>
    } = {},
  ) {
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
      fontStyle: 'normal',
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

  append(...nodes: Array<string | FakeElement | FakeTextNode>) {
    nodes.forEach((node) => {
      const child = typeof node === 'string' ? new FakeTextNode(node) : node
      if (child.nodeType === 1) child.parentElement = this
      this.childNodes.push(child)
    })
    return this
  }

  get textContent(): string {
    return this.childNodes.map((node) => node.textContent || '').join('')
  }

  get id() {
    return this.getAttribute('id') || ''
  }

  getAttribute(name: string) {
    return this.attributes[name] || null
  }

  removeAttribute(name: string) {
    delete this.attributes[name]
  }

  setAttribute(name: string, value: unknown) {
    this.attributes[name] = String(value)
  }

  closest(selector: string): FakeElement | undefined {
    if (matchesAnySelector(this, selector)) return this

    for (let node = this.parentElement; node; node = node.parentElement) {
      if (matchesAnySelector(node, selector)) return node
    }
  }

  contains(target: FakeElement | FakeTextNode): boolean {
    if (target === this) return true

    return this.childNodes.some((node) => node === target || (node.nodeType === 1 && node.contains(target)))
  }

  get previousElementSibling() {
    const siblings = this.parentElement?.childNodes.filter((node) => node.nodeType === 1)
    const index = siblings?.indexOf(this) ?? -1
    return index > 0 ? (siblings?.[index - 1] ?? null) : null
  }

  get nextElementSibling() {
    const siblings = this.parentElement?.childNodes.filter((node) => node.nodeType === 1)
    const index = siblings?.indexOf(this) ?? -1
    return index >= 0 ? (siblings?.[index + 1] ?? null) : null
  }

  compareDocumentPosition(target: FakeElement) {
    const root = getRootElement(this)
    const elements: FakeElement[] = []
    walkElements(root, (el) => elements.push(el))
    const sourceIndex = elements.indexOf(this)
    const targetIndex = elements.indexOf(target)

    if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) {
      return 0
    }

    return targetIndex > sourceIndex ? 4 : 2
  }

  querySelector(selector: string) {
    return this.querySelectorAll(selector)[0]
  }

  querySelectorAll(selector: string) {
    const result: FakeElement[] = []
    walkElements(this, (el) => {
      if (el !== this && matchesAnySelector(el, selector)) result.push(el)
    })
    return result
  }
}

function getRootElement(el: FakeElement) {
  let root = el
  while (root.parentElement) root = root.parentElement
  return root
}

function walkElements(root: FakeElement, visit: (element: FakeElement) => void) {
  root.childNodes.forEach((node) => {
    if (node.nodeType !== 1) return
    visit(node)
    walkElements(node, visit)
  })
}

function matchesAnySelector(el: FakeElement, selector: string) {
  return selector
    .split(',')
    .map((part) => part.trim())
    .some((part) => matchesSelector(el, part))
}

function matchesSelector(el: FakeElement, selector: string) {
  if (!selector) return false
  const tagName = el.tagName.toLowerCase()

  if (selector === 'blockquote > p') {
    return tagName === 'p' && el.parentElement?.tagName.toLowerCase() === 'blockquote'
  }

  if (selector.startsWith('.')) {
    return el.classList.values.includes(selector.slice(1))
  }

  const attrContains = selector.match(/^\[(.+)\*="(.+)"\]$/)
  if (attrContains) {
    const [, attrName = '', expected = ''] = attrContains
    return (el.getAttribute(attrName.replace('\\:', ':')) || '').includes(expected)
  }

  const attrEquals = selector.match(/^\[(.+)="(.+)"\]$/)
  if (attrEquals) {
    const [, attrName = '', expected = ''] = attrEquals
    return el.getAttribute(attrName.replace('\\:', ':')) === expected
  }

  const attrExists = selector.match(/^\[(.+)\]$/)
  if (attrExists) {
    const [, attrName = ''] = attrExists
    return el.getAttribute(attrName.replace('\\:', ':')) !== null
  }

  const tagAttrExists = selector.match(/^([a-z]+)\[(.+)\]$/)
  if (tagAttrExists) {
    const [, expectedTag = '', attrName = ''] = tagAttrExists
    return tagName === expectedTag && el.getAttribute(attrName.replace('\\:', ':')) !== null
  }

  return selector === tagName
}

function paragraph(className: string, text: string, child?: FakeElement) {
  const p = new FakeElement('p', { className })
  p.append(text)
  if (child) p.append(child)
  return p
}

function styledParagraph(className: string, text: string, style: Record<string, string>, child?: FakeElement) {
  const p = new FakeElement('p', { className, style })
  p.append(text)
  if (child) p.append(child)
  return p
}

function span(className: string, text: string) {
  return new FakeElement('span', { className }).append(text)
}

function anchor(href: string, text: string, attributes: Record<string, string> = {}) {
  return new FakeElement('a', { attributes: { href, ...attributes } }).append(text)
}

function createContents(body: FakeElement) {
  const document = {
    body,
    getElementById: (id: string) => {
      let result: FakeElement | undefined
      walkElements(body, (el) => {
        if (!result && el.getAttribute('id') === id) result = el
      })
      return result
    },
    querySelectorAll: (selector: string) => body.querySelectorAll(selector),
  }
  walkElements(body, (el) => {
    el.ownerDocument = document
  })
  body.ownerDocument = document

  return {
    document,
    window: {
      getComputedStyle: (el: FakeElement) => el.style,
    },
  }
}

function testInlineClassAnnotationPayloadIsNotCountedAsParentBodyText() {
  const body = new FakeElement('body')
  const bodyParagraphs = [
    paragraph('main', '这是第一段正文内容，包含足够多的连续叙述文字，用来代表普通正文段落。'),
    paragraph('main', '这是第二段正文内容，仍然是普通正文，应当被识别为主体文字。'),
    paragraph('main', '这是第三段正文内容，和前面段落保持相同的标签、class 与样式。'),
  ]
  const annotationParagraphs = [
    styledParagraph(
      'commentary-title',
      '校记',
      { fontWeight: '700' },
      span(
        'commentary-body',
        '这里是一大段夹在子元素里的说明文字，它属于注释正文，不应该让父级短标题段落被识别为正文。',
      ),
    ),
    styledParagraph(
      'commentary-title',
      '笺注',
      { fontWeight: '700' },
      span('commentary-body', '这里还是一大段夹在子元素里的说明文字，用来模拟注释文本数量很多但父级本身很短的结构。'),
    ),
    styledParagraph(
      'commentary-title',
      '考订',
      { fontWeight: '700' },
      span('commentary-body', '这段说明继续提供大量子元素文本，如果统计父级 textContent 就会错误压过真正正文。'),
    ),
    styledParagraph(
      'commentary-title',
      '补注',
      { fontWeight: '700' },
      span('commentary-body', '最后一段说明仍然只应该属于子元素，不应该参与父级段落的正文聚类。'),
    ),
  ]

  body.append(...bodyParagraphs, ...annotationParagraphs)

  const contents = createContents(body)
  const candidates = getBodyTextCandidates(contents.document)
  const bodyIndexes = detectBodyTextIndexes(contents, candidates)

  const selectedClasses = bodyIndexes.map((index: number) => candidates[index]!.className)

  assert.deepStrictEqual(selectedClasses, ['main', 'main', 'main'])
}

function testSameBaseStyleParagraphsAreCountedAsBodyText() {
  const body = new FakeElement('body')
  const firstParagraph = styledParagraph('first', '这是第一段正文内容。', { textIndent: '0px' }, span('first', '一'))
  const bodyParagraphs = [
    styledParagraph('', '这是第二段正文内容，仍然是普通正文，应当被识别为主体文字。', { textIndent: '32px' }),
    styledParagraph('', '这是第三段正文内容，和前面段落保持相同的基础字体样式。', { textIndent: '32px' }),
  ]

  body.append(firstParagraph, ...bodyParagraphs)

  const contents = createContents(body)
  const candidates = getBodyTextCandidates(contents.document)
  const bodyIndexes = detectBodyTextIndexes(contents, candidates)

  const selectedClasses = bodyIndexes.map((index: number) => candidates[index]!.className)

  assert.deepStrictEqual(selectedClasses, ['first', '', ''])
}

function testBodyTextIgnoresClassNameWhenComputedStyleMatches() {
  const body = new FakeElement('body')
  const dominantText = '这是正文主段落，内容较长，用来形成当前聚类算法中的明显赢家。'.repeat(4)
  const paragraphs = [
    paragraph('calibre1', dominantText),
    paragraph('calibre1', dominantText),
    paragraph('calibre2', '这是第三段正文，class 名称不同，但不应该因此被拆成另一个正文候选族群。'),
    paragraph('calibre2', '这是第四段正文，继续使用第二个 class，用来避免单例兜底掩盖问题。'),
    paragraph('calibre3', '这是第五段正文，视觉特征才应该决定正文聚类，而不是 class 命名。'),
    paragraph('calibre3', '这是第六段正文，继续使用第三个 class，但 computed CSS 与其他段落一致。'),
    paragraph('calibre4', '这是第七段正文，用来保证多个不同 class 的同样式段落都能被识别。'),
    paragraph('calibre4', '这是第八段正文，继续使用第四个 class，防止只选前三个聚类。'),
  ]

  body.append(...paragraphs)

  const contents = createContents(body)
  const candidates = getBodyTextCandidates(contents.document)
  const bodyIndexes = detectBodyTextIndexes(contents, candidates)

  assert.deepStrictEqual(
    bodyIndexes.map((index: number) => candidates[index]!.className),
    ['calibre1', 'calibre1', 'calibre2', 'calibre2', 'calibre3', 'calibre3', 'calibre4', 'calibre4'],
  )
}

function testBodyTextIgnoresBlockMarginsWhenComputedStyleMatches() {
  const body = new FakeElement('body')
  const dominantText = '这是正文主段落，内容较长，用来形成当前聚类算法中的明显赢家。'.repeat(4)
  const paragraphs = [
    styledParagraph('main', dominantText, {
      marginTop: '24px',
      marginBottom: '0px',
    }),
    styledParagraph('main', dominantText, {
      marginTop: '24px',
      marginBottom: '0px',
    }),
    styledParagraph('main', '这是第三段正文，段间距可能来自出版样式，不应该拆分正文聚类。', {
      marginTop: '0px',
      marginBottom: '12px',
    }),
    styledParagraph('main', '这是第四段正文，继续使用第二组上下 margin，但仍然是同一类正文。', {
      marginTop: '0px',
      marginBottom: '12px',
    }),
    styledParagraph('main', '这是第五段正文，保持相同字体和排版，只改变块方向 margin。', {
      marginTop: '8px',
      marginBottom: '8px',
    }),
    styledParagraph('main', '这是第六段正文，继续使用第三组上下 margin，视觉文本特征不变。', {
      marginTop: '8px',
      marginBottom: '8px',
    }),
    styledParagraph('main', '这是第七段正文，末段也可能有额外下边距，但仍然是正文。', {
      marginTop: '0px',
      marginBottom: '24px',
    }),
    styledParagraph('main', '这是第八段正文，继续使用末段式下边距，应该仍然被标为正文。', {
      marginTop: '0px',
      marginBottom: '24px',
    }),
  ]

  body.append(...paragraphs)

  const contents = createContents(body)
  const candidates = getBodyTextCandidates(contents.document)
  const bodyIndexes = detectBodyTextIndexes(contents, candidates)

  assert.deepStrictEqual(bodyIndexes, [0, 1, 2, 3, 4, 5, 6, 7])
}

function testBodyTextIncludesSameFontStyleVariants() {
  const body = new FakeElement('body')
  const normalParagraphs = [
    styledParagraph(
      'main',
      '这是普通正文第一段，包含足够长的叙述内容，用来形成稳定的正文主聚类，避免短文本造成误判。',
      { fontStyle: 'normal' },
    ),
    styledParagraph('main', '这是普通正文第二段，继续提供较长的主体文本，让普通正文在总字数和数量上明显占优。', {
      fontStyle: 'normal',
    }),
    styledParagraph('main', '这是普通正文第三段，仍然保持普通字体样式，应该被识别为主体正文。', {
      fontStyle: 'normal',
    }),
  ]
  const italicParagraphs = [
    styledParagraph('main', '短斜体题词。', { fontStyle: 'italic' }),
    styledParagraph('main', '短斜体引语。', { fontStyle: 'italic' }),
    styledParagraph('main', '短斜体注记。', { fontStyle: 'italic' }),
  ]

  body.append(...normalParagraphs, ...italicParagraphs)

  const contents = createContents(body)
  const candidates = getBodyTextCandidates(contents.document)
  const bodyIndexes = detectBodyTextIndexes(contents, candidates)

  assert.deepStrictEqual(bodyIndexes, [0, 1, 2, 3, 4, 5])
}

function testBodyTextIncludesLeadingDifferentFontCandidates() {
  const body = new FakeElement('body')
  const mainText = '这是主正文段落，包含连续叙述内容，用来形成稳定的正文赢家。'.repeat(4)
  const variantText = '这是另一组正文段落，出版样式略有不同，但仍然应当获得正文排版。'.repeat(3)
  const paragraphs = [
    styledParagraph('main', mainText, { fontFamily: 'serif' }),
    styledParagraph('main', mainText, { fontFamily: 'serif' }),
    styledParagraph('main', mainText, { fontFamily: 'serif' }),
    styledParagraph('quote', '短引。', {
      fontFamily: 'fantasy',
      marginLeft: '64px',
      marginRight: '64px',
    }),
    styledParagraph('quote', '短注。', {
      fontFamily: 'fantasy',
      marginLeft: '64px',
      marginRight: '64px',
    }),
    styledParagraph('quote', '落款。', {
      fontFamily: 'fantasy',
      marginLeft: '64px',
      marginRight: '64px',
    }),
    styledParagraph('quote', '题记。', {
      fontFamily: 'fantasy',
      marginLeft: '64px',
      marginRight: '64px',
    }),
    styledParagraph('variant', variantText, { fontFamily: 'monospace' }),
    styledParagraph('variant', variantText, { fontFamily: 'monospace' }),
  ]

  body.append(...paragraphs)

  const contents = createContents(body)
  const candidates = getBodyTextCandidates(contents.document)
  const bodyIndexes = detectBodyTextIndexes(contents, candidates)

  assert.deepStrictEqual(bodyIndexes, [0, 1, 2, 3, 4, 5, 6, 7, 8])
}

function testBodyTextVariantsPreserveOriginalFontFamily() {
  const body = new FakeElement('body')
  const mainText = '这是主正文段落，承载大部分连续叙述内容，用来确定完整字体排版的字体来源。'.repeat(4)
  const variantText = '这是另一组正文段落，使用不同字体承载正文内容，字号行高等阅读排版仍应生效。'.repeat(3)
  const sameFontVariantText = '这是同字体但缩进不同的正文段落，应当和主正文一样允许应用用户选择的字体。'.repeat(3)
  const paragraphs = [
    styledParagraph('main', mainText, { fontFamily: 'serif' }),
    styledParagraph('main', mainText, { fontFamily: 'serif' }),
    styledParagraph('main', mainText, { fontFamily: 'serif' }),
    styledParagraph('variant', variantText, { fontFamily: 'fantasy' }),
    styledParagraph('variant', variantText, { fontFamily: 'fantasy' }),
    styledParagraph('same-font', sameFontVariantText, {
      fontFamily: 'serif',
      textIndent: '32px',
    }),
    styledParagraph('same-font', sameFontVariantText, {
      fontFamily: 'serif',
      textIndent: '32px',
    }),
  ]

  body.append(...paragraphs)

  const contents = createContents(body)
  ensureBodyTextMarkers(contents)

  paragraphs.slice(0, 3).forEach((el) => {
    assert.strictEqual(el.getAttribute(bodyTextAttribute), 'true')
    assert.strictEqual(el.getAttribute(bodyTextPreserveFontAttribute), null)
  })
  paragraphs.slice(3, 5).forEach((el) => {
    assert.strictEqual(el.getAttribute(bodyTextAttribute), 'true')
    assert.strictEqual(el.getAttribute(bodyTextPreserveFontAttribute), 'true')
  })
  paragraphs.slice(5).forEach((el) => {
    assert.strictEqual(el.getAttribute(bodyTextAttribute), 'true')
    assert.strictEqual(el.getAttribute(bodyTextPreserveFontAttribute), null)
  })
}

function testInlineWrappedBodyParagraphsAreMarkedForTypographyPiercing() {
  const body = new FakeElement('body')
  const paragraphs = [
    new FakeElement('p', { className: 'calibre7' }).append(
      span('calibre10', '这是第一段由直接子级行内容器承载的正文文本，用来模拟转换工具生成的段落结构。'),
    ),
    new FakeElement('p', { className: 'calibre7' }).append(
      span('calibre10', '这是第二段由直接子级行内容器承载的正文文本，父级段落本身没有直接文本。'),
    ),
  ]

  body.append(...paragraphs)

  const contents = createContents(body)
  ensureBodyTextMarkers(contents)

  assert.strictEqual(paragraphs[0]!.getAttribute(bodyTextAttribute), 'true')
  assert.strictEqual(paragraphs[0]!.getAttribute(bodyTextInlineWrapperAttribute), 'true')
  assert.strictEqual(paragraphs[1]!.getAttribute(bodyTextAttribute), 'true')
  assert.strictEqual(paragraphs[1]!.getAttribute(bodyTextInlineWrapperAttribute), 'true')
}

function testReciprocalNoteContentIsMarkedStructurally() {
  const body = new FakeElement('body')
  const source = anchor('notes.html#note-1', '1', { id: 'back-note-1' })
  const bodyParagraph = new FakeElement('p').append(
    '这是普通正文内容，正文里的脚注引用不应该让整段被标记成注释内容。',
    new FakeElement('sup').append(source),
  )
  const linkedNote = new FakeElement('p', {
    attributes: { id: 'note-1' },
    className: 'footnote',
  }).append(anchor('chapter.html#back-note-1', '[1]'), ' 这是通过结构识别出来的注释内容。')
  const classOnlyFootnote = paragraph('footnote', '这段只有 footnote class，没有链接关系，不应该被当作可操作注释。')

  body.append(bodyParagraph, linkedNote, classOnlyFootnote)

  const contents = createContents(body)
  ensureBodyTextMarkers(contents)

  assert.strictEqual(linkedNote.getAttribute(noteContentAttribute), 'true')
  assert.strictEqual(linkedNote.getAttribute(noteTextAttribute), 'true')
  assert.strictEqual(classOnlyFootnote.getAttribute(noteContentAttribute), null)
  assert.strictEqual(bodyParagraph.getAttribute(noteContentAttribute), null)
}

function testSemanticNoteFallbackMarksNamedNoteContent() {
  const body = new FakeElement('body')
  const source = new FakeElement('a', {
    attributes: {
      class: 'duokan-footnote',
      href: 'notes.html#semantic-note',
    },
    className: 'duokan-footnote',
  }).append(new FakeElement('img'))
  const bodyParagraph = new FakeElement('p').append('正文图片脚注', source)
  const footnoteList = new FakeElement('ol', {
    className: 'duokan-footnote-content',
  })
  const footnoteItem = new FakeElement('li', {
    attributes: { id: 'semantic-note' },
    className: 'duokan-footnote-item',
  }).append(new FakeElement('p').append('这是没有回链的命名兜底脚注内容。'))

  footnoteList.append(footnoteItem)
  body.append(bodyParagraph, footnoteList)

  const contents = createContents(body)
  ensureBodyTextMarkers(contents)

  assert.strictEqual(findReciprocalNoteItem(source, footnoteItem), footnoteItem)
  assert.strictEqual(footnoteItem.getAttribute(noteTextAttribute), 'true')
  assert.strictEqual(footnoteList.getAttribute(noteContentAttribute), 'true')
  assert.strictEqual(bodyParagraph.getAttribute(noteContentAttribute), null)
}

function testLinkedNoteResolutionUsesHashTargetItem() {
  const body = new FakeElement('body')
  const chapter = new FakeElement('div', { className: 'chapter' })
  const heading = new FakeElement('h1').append(
    '第5卷　比例',
    anchor('part0007.xhtml#ft1_142', '[1]', { id: 'fn1_142' }),
  )
  const bodyParagraph = paragraph('', '这是章节正文内容，正文容器不应该被当作尾注隐藏。')
  const footnotes = new FakeElement('div', { className: 'footnotes' })
  const footnote = new FakeElement('p', { className: 'footnote' }).append(
    anchor('part0007.xhtml#fn1_142', '[1]', { id: 'ft1_142' }),
    ' 这是标题脚注正文。',
  )

  footnotes.append(footnote)
  chapter.append(heading, bodyParagraph, footnotes)
  body.append(chapter)

  const contents = createContents(body)
  ensureBodyTextMarkers(contents)

  assert.strictEqual(chapter.getAttribute(noteContentAttribute), null)
  assert.strictEqual(heading.getAttribute(noteContentAttribute), null)
  assert.strictEqual(bodyParagraph.getAttribute(noteContentAttribute), null)
  assert.strictEqual(footnotes.getAttribute(noteContentAttribute), 'true')
  assert.strictEqual(footnote.getAttribute(noteTextAttribute), 'true')
}

function testReciprocalNoteItemRequiresBacklinkToSourceAnchor() {
  const body = new FakeElement('body')
  const source = anchor('notes.html#note-1', '[1]', { id: 'back-note-1' })
  const sourceParagraph = new FakeElement('p').append('正文带有注释引用', source)
  const noteLink = anchor('chapter.html#back-note-1', '[1]', { id: 'note-1' })
  const noteItem = new FakeElement('p').append(noteLink, ' 这是双向链接确认后的注释。')
  const wrongBacklink = anchor('chapter.html#other-ref', '[2]', {
    id: 'note-2',
  })
  const wrongNoteItem = new FakeElement('p').append(wrongBacklink, ' 这条没有指回正文引用。')
  const definitionSource = anchor('notes.html#note-3', '3')
  const definitionMarker = new FakeElement('sup', {
    attributes: { id: 'back-note-3' },
  }).append(definitionSource)
  const definitionSourceParagraph = new FakeElement('p').append('正文里的定义列表注释引用', definitionMarker)
  const definitionNote = new FakeElement('dl', {
    attributes: { id: 'note-3' },
  }).append(
    new FakeElement('dt').append('[', anchor('chapter.html#back-note-3', '←3'), ']'),
    new FakeElement('dd').append(new FakeElement('p').append('定义列表注释。')),
  )

  body.append(sourceParagraph, noteItem, wrongNoteItem, definitionSourceParagraph, definitionNote)
  createContents(body)

  assert.strictEqual(findReciprocalNoteItem(source, noteLink), noteItem)
  assert.strictEqual(findReciprocalNoteItem(source, wrongBacklink), undefined)
  assert.strictEqual(findReciprocalNoteItem(definitionSource, definitionNote), definitionNote)
}

function testReciprocalNoteItemUsesBoundedTargetStructures() {
  const body = new FakeElement('body')
  const kindleSource = anchor('chapter.html#note-span', '[1]')
  const kindleSourceMarker = new FakeElement('sup').append(
    new FakeElement('span', { attributes: { id: 'back-span' } }),
    new FakeElement('small').append(kindleSource),
  )
  const kindleSourceParagraph = new FakeElement('p').append('正文里的 Kindle filepos 形式注释引用', kindleSourceMarker)
  const kindleTarget = new FakeElement('span', {
    attributes: { id: 'note-span' },
  })
  const kindleNote = new FakeElement('p').append(
    new FakeElement('sup').append(
      kindleTarget,
      new FakeElement('small').append(anchor('chapter.html#back-span', '[1]')),
    ),
    ' 这是空 span 目标后面的尾注正文。',
  )

  const tableSource = anchor('chapter.html#note-table', '[2]')
  const tableSourceParagraph = new FakeElement('p', {
    attributes: { id: 'back-table' },
  }).append('正文里的表格注释引用', tableSource)
  const tableTarget = new FakeElement('a', {
    attributes: { id: 'note-table' },
  })
  const chapterWrapper = new FakeElement('div', { className: 'chapter-like' })
  const tableNote = new FakeElement('table').append(
    new FakeElement('tr').append(
      new FakeElement('td').append(anchor('chapter.html#back-table', '[2]')),
      new FakeElement('td').append('这是表格尾注正文。'),
    ),
  )
  chapterWrapper.append(paragraph('', '章节包装里还有普通正文，不能被当作尾注。'), tableTarget, tableNote)

  const formulaSource = anchor('chapter.html#formula-1', '(1)')
  const formulaSourceParagraph = new FakeElement('p').append('正文里的公式编号引用', formulaSource)
  const formula = paragraph('', '(1) 这是公式内容，不是尾注。')
  formula.setAttribute('id', 'formula-1')

  body.append(kindleSourceParagraph, kindleNote, tableSourceParagraph, chapterWrapper, formulaSourceParagraph, formula)
  createContents(body)

  assert.strictEqual(findReciprocalNoteItem(kindleSource, kindleTarget), kindleNote)
  assert.strictEqual(findReciprocalNoteItem(tableSource, tableTarget), tableNote)
  assert.notStrictEqual(findReciprocalNoteItem(tableSource, tableTarget), chapterWrapper)
  assert.strictEqual(findReciprocalNoteItem(formulaSource, formula), undefined)
}

function testNoteIndexMapsBacklinksOnlyInsideRecognizedNoteItems() {
  const body = new FakeElement('body')
  const source = anchor('chapter.html#note-table', '[1]')
  const sourceParagraph = new FakeElement('p', {
    attributes: { id: 'back-table' },
  }).append('正文', source)
  const tableTarget = new FakeElement('a', {
    attributes: { id: 'note-table' },
  })
  const wrapper = new FakeElement('div', { className: 'chapter-like' })
  const backlink = anchor('chapter.html#back-table', '[1]')
  const tableNote = new FakeElement('table').append(
    new FakeElement('tr').append(
      new FakeElement('td').append(backlink),
      new FakeElement('td').append('表格注释正文。'),
    ),
  )

  wrapper.append(paragraph('', '普通正文。'), tableTarget, tableNote)
  body.append(sourceParagraph, wrapper)
  const contents = createContents(body)

  const index = getNoteIndex(contents.document)

  assert.strictEqual(index.getItemForAnchor(backlink), tableNote)
  assert.strictEqual(index.getHideTargets().includes(wrapper), false)
  assert.strictEqual(index.getHideTargets().includes(tableNote), true)
}

function testReciprocalLinksDoNotDependOnNoteMarkerText() {
  const body = new FakeElement('body')
  const source = new FakeElement('a', {
    attributes: {
      class: 'duokan-footnote',
      href: 'chapter.html#note-duokan',
      id: 'noteref-duokan',
    },
    className: 'duokan-footnote',
  }).append(new FakeElement('img'))
  const sourceParagraph = new FakeElement('p').append('正文图片脚注', source)
  const footnoteList = new FakeElement('ol', {
    className: 'duokan-footnote-content',
  })
  const footnoteItem = new FakeElement('li', {
    attributes: { id: 'note-duokan' },
    className: 'duokan-footnote-item',
  }).append(
    new FakeElement('p', { className: 'footnote' }).append(
      anchor('chapter.html#noteref-duokan', '※'),
      ' 这是多看图片脚注正文。',
    ),
  )
  footnoteList.append(footnoteItem)
  body.append(sourceParagraph, footnoteList)
  const contents = createContents(body)

  const index = getNoteIndex(contents.document)
  const backlink = footnoteItem.querySelector('a[href]')

  assert.strictEqual(findReciprocalNoteItem(source, footnoteItem), footnoteItem)
  assert.strictEqual(index.getItemForAnchor(backlink), footnoteItem)
  assert.strictEqual(index.getHideTargets().includes(footnoteList), true)
}

function testReciprocalLinkContentMayLiveInsideBacklinkAnchor() {
  const body = new FakeElement('body')
  const source = anchor('chapter.html#piano-note', '入口', {
    id: 'piano-ref',
  })
  const sourceParagraph = new FakeElement('p').append('正文注释入口', source)
  const noteLink = anchor('chapter.html#piano-ref', '回到正文。整条尾注正文都在这个链接里。', { id: 'piano-note' })
  const noteItem = new FakeElement('p').append(noteLink)
  body.append(sourceParagraph, noteItem)
  const contents = createContents(body)

  const index = getNoteIndex(contents.document)

  assert.strictEqual(findReciprocalNoteItem(source, noteLink), noteItem)
  assert.strictEqual(index.getItemForAnchor(noteLink), noteItem)
  assert.strictEqual(index.getHideTargets().includes(noteItem), true)
}

testInlineClassAnnotationPayloadIsNotCountedAsParentBodyText()
testSameBaseStyleParagraphsAreCountedAsBodyText()
testBodyTextIgnoresClassNameWhenComputedStyleMatches()
testBodyTextIgnoresBlockMarginsWhenComputedStyleMatches()
testBodyTextIncludesSameFontStyleVariants()
testBodyTextIncludesLeadingDifferentFontCandidates()
testBodyTextVariantsPreserveOriginalFontFamily()
testInlineWrappedBodyParagraphsAreMarkedForTypographyPiercing()
testReciprocalNoteContentIsMarkedStructurally()
testSemanticNoteFallbackMarksNamedNoteContent()
testLinkedNoteResolutionUsesHashTargetItem()
testReciprocalNoteItemRequiresBacklinkToSourceAnchor()
testReciprocalNoteItemUsesBoundedTargetStructures()
testNoteIndexMapsBacklinksOnlyInsideRecognizedNoteItems()
testReciprocalLinksDoNotDependOnNoteMarkerText()
testReciprocalLinkContentMayLiveInsideBacklinkAnchor()
console.log('body-text tests passed')
