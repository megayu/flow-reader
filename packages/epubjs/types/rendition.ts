import Annotations from './annotations'
import Book from './book'
import Contents from './contents'
import EpubCFI from './epubcfi'
import View from './managers/view'
import Section from './section'
import Themes from './themes'
import Hook from './utils/hook'
import Queue from './utils/queue'

export enum RenditionSpread {
  Auto = 'auto',
  None = 'none',
  /* @deprecated */
  Always = 'always',
}

export interface RenditionDisplayOptions {
  alignTargetAsSpreadStart?: boolean
}

export interface RenditionOptions {
  width?: number | string
  height?: number | string
  ignoreClass?: string
  manager?: 'default' | Function | object
  view?: 'iframe' | Function | object
  flow?:
    | 'auto'
    | 'paginated'
    | 'scrolled'
    | 'scrolled-continuous'
    | 'scrolled-doc'
  layout?: 'reflowable' | 'pre-paginated'
  spread?: RenditionSpread
  minSpreadWidth?: number
  stylesheet?: string
  resizeOnOrientationChange?: boolean
  script?: string
  infinite?: boolean
  overflow?: string
  defaultDirection?: 'ltr'
  allowScriptedContent?: boolean
  globalLayoutProperties?: {
    flow?: string
  }
}

export interface DisplayedLocation {
  index: number
  href: string
  cfi: string
  location: number
  percentage: number
  displayed: {
    page: number
    total: number
    slot?: 'left' | 'right'
  }
}

export interface Location {
  start: DisplayedLocation
  end: DisplayedLocation
  atStart: boolean
  atEnd: boolean
}

export interface RenditionManagerLayout {
  columnWidth?: number
  divisor?: number
  gap?: number
  name?: string
  pageWidth?: number
}

export interface RenditionManagerPage {
  pageIndex: number
  section: Section
}

export interface RenditionManagerSpread {
  anchor?: 'left' | 'right'
  endsAtSectionEnd?: boolean
  exact?: boolean
  left?: RenditionManagerPage
  right?: RenditionManagerPage
}

export interface RenditionPaginationModel {
  pageProgressionDirection?: 'ltr' | 'rtl'
  spreadSlotOrder?: 'left-first' | 'right-first'
  writingMode?: string
}

export interface RenditionManagerView {
  _contentPageCount?: number
  axis?: string
  contents: Contents
  document?: Document
  element?: HTMLElement
  expand?(): void
  layout?: {
    columnWidth?: number
    format?(contents?: Contents, section?: Section, axis?: string): void
    gap?: number
    height?: number
    name?: string
    width?: number
  }
  section: Section
  window?: Window
}

export interface RenditionManager {
  _stageSize?: {
    height?: number
    width?: number
  }
  container?: HTMLElement
  current?(): RenditionManagerView | undefined
  currentReflowableSpread?: RenditionManagerSpread
  deleteReflowablePageCountCache?(section?: Section): void
  layout?: RenditionManagerLayout
  paginationModel?(): RenditionPaginationModel
  reflowablePageCountCache?: Record<string, number>
  renderReflowableSpread?(spread: unknown): Promise<void>
  canUseLogicalReflowableSpread?(): boolean
  reflowablePageForTarget?(section: Section, target: string): Promise<RenditionManagerPage | undefined>
  reflowableSpreadEarlierPage?(spread: RenditionManagerSpread): RenditionManagerPage | undefined
  scrollHorizontalByReadingDirection?(delta: number, silent?: boolean): boolean
  settings?: {
    axis?: string
  }
  suspendResize?: boolean
  views: {
    displayed?(): RenditionManagerView[]
    _views: RenditionManagerView[]
  }
  viewSettings?: {
    beforeLayout?: (contents?: Contents, view?: RenditionManagerView) => void
    height?: number
    layoutStyleSignature?: string
    width?: number
  }
}

export declare class Rendition {
  constructor(book: Book, options: RenditionOptions)

  settings: RenditionOptions
  book: Book
  hooks: {
    display: Hook
    serialize: Hook
    content: Hook
    unloaded: Hook
    layout: Hook
    render: Hook
    show: Hook
  }
  themes: Themes
  annotations: Annotations
  epubcfi: EpubCFI
  q: Queue
  location: Location
  manager?: RenditionManager
  started: Promise<void>
  _flowSuppressResizeRedisplay?: boolean
  _locationRequestId?: number

  adjustImages(contents: Contents): Promise<void>

  attachTo(element: Element): Promise<void>

  clear(): void

  currentLocation(): DisplayedLocation
  currentLocation(): Promise<DisplayedLocation>

  destroy(): void

  determineLayoutProperties(metadata: object): object

  direction(dir: string): void

  display(target?: string, options?: RenditionDisplayOptions): Promise<void>
  display(target?: number, options?: RenditionDisplayOptions): Promise<void>

  flow(flow: string): void

  getContents(): Contents[]

  getRange(cfi: string, ignoreClass?: string): Range

  handleLinks(contents: Contents): void

  injectIdentifier(doc: Document, section: Section): void

  injectScript(doc: Document, section: Section): void

  injectStylesheet(doc: Document, section: Section): void

  layout(settings: any): any

  located(location: Location): DisplayedLocation

  moveTo(offset: number): void

  next(): Promise<void>

  onOrientationChange(orientation: string): void

  passEvents(contents: Contents): void

  prev(): Promise<void>

  reportLocation(requestId?: number): Promise<void>

  requireManager(manager: string | Function | object): any

  requireView(view: string | Function | object): any

  resize(width?: number, height?: number, epubcfi?: string): void

  setManager(manager: Function): void

  spread(spread: string, min?: number): void

  start(): void

  views(): Array<View>

  // Event emitters
  emit(type: any, ...args: any[]): void

  off(type: any, listener: any): any

  on(type: any, listener: any): any

  once(type: any, listener: any, ...args: any[]): any

  private triggerMarkEvent(
    cfiRange: string,
    data: object,
    contents: Contents,
  ): void

  private triggerSelectedEvent(cfirange: string, contents: Contents): void

  private triggerViewEvent(e: Event, contents: Contents): void

  private onResized(size: { width: number; height: number }): void

  private afterDisplayed(view: any): void

  private afterRemoved(view: any): void
}
