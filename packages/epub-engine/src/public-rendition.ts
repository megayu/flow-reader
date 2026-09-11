import InternalRendition, { RenditionSpread } from './rendition'
import type InternalBook from './book'
import type InternalSession from './reader-session'
import type IframeView from './managers/views/iframe'
import type Hook from './utils/hook'
import type Contents from './contents'
import type { RenditionEvents, RenditionOptions } from './rendition'
export { RenditionSpread }
export type RenditionSpread =
  (typeof RenditionSpread)[keyof typeof RenditionSpread]
export type {
  Location,
  DisplayedLocation,
  RenditionDisplayOptions,
  RenditionOptions,
} from './rendition'
export type { ReaderOperation } from './reader-session'
export type { ReaderPage, ReaderSpread } from './managers/default'
export type ReaderView = Readonly<
  Pick<
    IframeView,
    | 'writingMode'
    | 'createZoomCss'
    | 'axis'
    | 'contents'
    | 'document'
    | 'element'
    | 'section'
  >
> & {
  readonly layout: Pick<
    IframeView['layout'],
    'columnWidth' | 'gap' | 'height' | 'name' | 'width'
  >
  readonly window?: Window | null
}
export type ReaderLayout = NonNullable<InternalSession['layout']>
export type RenditionPaginationModel = ReturnType<
  InternalSession['paginationModel']
>
export type ReaderSession = Omit<
  InternalSession,
  | 'destroy'
  | 'getViews'
  | 'getDisplayedViews'
  | 'currentView'
  | 'viewForWindow'
  | 'setBeforeLayout'
> & {
  getViews(): ReaderView[]
  getDisplayedViews(): ReaderView[]
  currentView(): ReaderView | undefined
  viewForWindow(
    ...args: Parameters<InternalSession['viewForWindow']>
  ): ReaderView | undefined
  setBeforeLayout(
    callback: (contents?: Contents, view?: ReaderView) => void,
    signature?: string,
  ): void
}
type PublicHook<Args extends unknown[]> = Pick<
  Hook<Args>,
  'register' | 'deregister'
>
type PublicEvents = Omit<RenditionEvents, 'rendered' | 'removed'> & {
  rendered: [IframeView['section'], ReaderView]
  removed: [IframeView['section'], ReaderView]
}
export type Rendition = Readonly<
  Pick<
    InternalRendition,
    | 'settings'
    | 'themes'
    | 'annotations'
    | 'epubcfi'
    | 'location'
    | 'started'
    | 'destroy'
    | 'getContents'
  >
> & {
  spread(spread: NonNullable<RenditionOptions['spread']>, min?: number): void
  on<K extends keyof PublicEvents>(
    type: K,
    listener: (...args: PublicEvents[K]) => unknown,
  ): void
  off<K extends keyof PublicEvents>(
    type: K,
    listener?: (...args: PublicEvents[K]) => unknown,
  ): void
  emit<K extends keyof PublicEvents>(type: K, ...args: PublicEvents[K]): boolean
} & {
  readonly book: Book
  readonly session: ReaderSession
  readonly hooks: {
    content: PublicHook<[Contents, Rendition]>
    unloaded: PublicHook<[ReaderView, Rendition]>
    render: PublicHook<[ReaderView, Rendition]>
  }
}
export type Book = Omit<
  InternalBook,
  'rendition' | 'renderTo' | 'opened' | 'opening' | 'on' | 'off'
> & {
  on(type: 'openFailed', listener: (error: Error) => unknown): void
  off(type: 'openFailed', listener?: (error: Error) => unknown): void
  readonly rendition: Rendition | undefined
  readonly opened: Promise<Book>
  renderTo(...args: Parameters<InternalBook['renderTo']>): Promise<Rendition>
}
export const Rendition: new (
  book: Book,
  options?: RenditionOptions,
) => Rendition = InternalRendition
export default Rendition
