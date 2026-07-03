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
  if (id === './noteSemantics') {
    return {
      isNoteMarkerText: () => false,
      noteContentBlockSelector: '[data-flow-note-content]',
      noteContentContainerSelector: '[data-flow-note-container]',
    }
  }
  return require(id)
}

const compiledModule = new Module(sourcePath, module)
compiledModule.filename = sourcePath
compiledModule.paths = Module._nodeModulePaths(path.dirname(sourcePath))
compiledModule.require = requireShim
compiledModule._compile(outputText, sourcePath)
moduleShim.exports = compiledModule.exports

const {
  bodyTextAttribute,
  bodyTextInlineWrapperAttribute,
  detectBodyTextIndexes,
  ensureBodyTextMarkers,
  getBodyTextCandidates,
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

function createContents(body) {
  const document = {
    body,
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

testInlineClassAnnotationPayloadIsNotCountedAsParentBodyText()
testSameBaseStyleParagraphsAreCountedAsBodyText()
testInlineWrappedBodyParagraphsAreMarkedForTypographyPiercing()
console.log('body-text tests passed')
