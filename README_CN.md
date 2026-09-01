<p align="center">
  <img src="src-tauri/icons/128x128@2x.png" width="128" alt="Flow Reader 图标">
</p>

<h1 align="center">
  Flow Reader
  <br>
  <sub><a href="README.md">English</a> · 简体中文</sub>
</h1>

Flow Reader 是一款快速、流畅和轻便的 EPUB 与 TXT 桌面阅读器。它专为长时间、沉浸式的连续阅读而打造：书籍内容始终居于视觉核心，界面紧凑克制，常用操作即时响应，不打断阅读节奏。

长按方向键连续高速翻页依然完全跟手，连续快速切换标签页也能立刻响应。数百万字的长篇仍能在毫秒级完成全文检索；即使书架超过上千本、同时打开多本书，使用依然流畅，内存占用也保持克制。

## 亮点

### 多书无缝切换，随时继续阅读

- 书架和所有已打开的书籍都整合在一个紧凑的标签页窗口中，返回书架、切换书籍或继续阅读都无需打开额外窗口。
- 切换到其他书籍时，非活动标签会原样保留当前的精确页面与版式。标签页支持拖拽和快捷键调整顺序，任何时候切回都能立刻继续阅读。
- 无论快速翻页、缩放窗口、开闭侧栏还是调整显示设置，页面内容、章节、页码与阅读进度始终保持同步。

### 广泛兼容，忠实呈现原书风貌

- 无论是普通小说、固定版式画册、文字从右向左，还是传统竖排书籍，都能按照原书本身的方式呈现。
- 响应式单双页视图可在阅读区域变化时自适应调整，同时保持页序、左右页位置与当前阅读位置。
- 智能导入机制会在入库时自动修复目录错乱、章节过大、固定布局书籍页面尺寸缺失和字体失效等问题 EPUB。
- 支持多层嵌套文件夹批量导入，自动识别其中的 EPUB 与 TXT 书籍，并能将原有的文件夹层级直接转换为书架标签。
- 自动识别 TXT 编码，从文件名智能提取书名与作者，并配合分卷与章节识别规则，将其重建为结构规范的书籍。

### 实用工具随手即得，不离阅读上下文

- 选中文字即可复制、全书搜索、查词、翻译、添加高亮和笔记、开启全书同词高亮。
- 支持全书搜索和当前章节内查找，点击搜索结果即可直达对应原文。
- 在线词典可与本地 StarDict、MDict 词典混合查询，也可调用系统语音朗读，或在 Google 与 Azure 翻译引擎之间切换，全程无需离开当前书页。
- 图片库默认滤除装饰图和重复图片，同时保留查看全部图片的入口，并支持预览、缩放、适应窗口、旋转和下载。
- 高亮和笔记不只停留在应用内，还可导出为便于阅读的 Markdown 或结构化 JSON；Markdown 中的链接可随时返回对应的标注位置。
- EPUB 日常阅读无需在速度与磁盘空间之间取舍，边读边改时也同样快速流畅；EPUB 与 TXT 均可直接在书页内修改，并在完成后导出修订版。

### 海量藏书从容管理，阅读环境随心定制

- 专为大体量藏书优化：在超过 1200 本书的实测中，书架滚动、搜索、多维筛选与排序依旧丝滑跟手。
- 书名搜索可与阅读状态、作者、标签等多种筛选条件自由组合；常用筛选可置顶，筛选出的书籍可批量修改标签和阅读状态，也可批量删除。
- 内置多款精心搭配的浅色与深色主题，也支持通过背景色与强调色自由搭配专属配色；调整时可实时预览，方便比较和切换。
- 在应用排版前会智能识别正文文本，最大程度保留原书精心设计的字体、章节标题与特殊样式等，在个性化排版的同时不破坏原书的美感。
- 可设定全局默认的单双页视图与页面对齐方式，亦可针对单本书籍单独调整缩放比例，应用卡片、书本拟真或分割线等多种页面外观风格。
- 全屏与禅模式可收起其他界面元素，让您专注阅读。

## 截图

![Library](./.github/assets/library.jpg)

![Annotation](./.github/assets/annotation.jpg)

![Note](./.github/assets/note.jpg)

![Vertical](./.github/assets/vertical.jpg)

![Theme](./.github/assets/theme.jpg)

## 项目结构

- `src/`：React 前端，包括书架、阅读器和设置等界面
- `src-tauri/`：Tauri 桌面外壳、原生命令、存储、导入和搜索
- `packages/epubjs/`：项目内部维护的 EPUB 渲染引擎
- `crates/`：共享的 EPUB 封面与缩略图库
- `native/shell-thumbnails/`：Windows 和 macOS EPUB 缩略图集成
- `scripts/`：构建、打包和发布脚本
- `tests/`：单元测试与浏览器集成测试

## 开发

### 环境要求

- [Node.js](https://nodejs.org/)
- [pnpm](https://pnpm.io/installation)
- [Rust](https://www.rust-lang.org/tools/install)
- [Tauri](https://v2.tauri.app/start/prerequisites/)

### 安装依赖

```bash
pnpm install
```

### 启动开发环境

```bash
pnpm tauri:dev
```

### 检查与测试

运行常规源码检查、单元测试和前端生产构建：

```bash
pnpm check
```

单独运行某一层测试：

```bash
pnpm test:unit
pnpm test:integration
```

运行一个集成测试文件：

```bash
pnpm test:integration tests/integration/app-shell.spec.ts
```

按标题匹配并运行单个集成测试：

```bash
pnpm test:integration tests/integration/app-shell.spec.ts -g "loads without client exceptions"
```

运行完整的浏览器测试、EPUB 引擎测试、原生代码检查与测试：

```bash
pnpm check:full
```

### 构建

构建应用，但不生成可分发安装包：

```bash
pnpm tauri:build
```

为当前平台生成完整安装包，产物会移动到 `release/`：

```bash
pnpm bundle:windows:installed
pnpm bundle:macos:installed
pnpm bundle:linux:installed
```

Windows 会生成 NSIS 安装程序，macOS 会生成应用程序包，Linux 会生成 AppImage。

## 许可证

Flow Reader 以 [GNU Affero General Public License v3.0](LICENSE) 开源。

## 致谢

- [pacexy/flow](https://github.com/pacexy/flow)
- [epub.js](https://github.com/futurepress/epub.js/)
- [Tauri](https://tauri.app/)
- [React](https://github.com/facebook/react)
