import type Rendition from './rendition'
import type { Location, RenditionDisplayOptions } from './rendition'
import type Section from './section'
import type { ReaderSpread } from './managers/default'
import type { ViewSettings } from './managers/views/iframe'
export interface ReaderOperation {
  requestId: number
  finished: Promise<Location | undefined>
}
/** Application-facing operations. Manager state and layout sequencing stay inside the engine. */
export default class ReaderSession {
  private declare rendition: Rendition | undefined
  private declare pending: Set<() => void>
  constructor(rendition: Rendition) {
    this.rendition = rendition
    this.pending = new Set()
  }

  get container() {
    return this.rendition?.manager?.container
  }
  get layout() {
    const layout = this.rendition?.manager?.layout
    if (!layout) return undefined
    return {
      name: layout.name,
      width: layout.width,
      height: layout.height,
      columnWidth: layout.columnWidth,
      pageWidth: layout.pageWidth,
      gap: layout.gap,
      divisor: layout.divisor,
    }
  }
  get currentSpread() {
    const spread = this.rendition?.manager?.currentReflowableSpread
    if (!spread) return undefined
    return {
      ...spread,
      left: spread.left && { ...spread.left },
      right: spread.right && { ...spread.right },
    }
  }
  get axis() {
    return this.rendition?.manager?.settings.axis
  }
  captureSpread(location = this.rendition?.location): ReaderSpread | undefined {
    if (!this.supportsSpreadNavigation()) return
    const spread = this.currentSpread
    if (!spread) return
    const { left, right } = spread
    const displayed = location?.end?.displayed
    const endsAtSectionEnd =
      Boolean(spread.endsAtSectionEnd) ||
      (typeof displayed?.page === 'number' &&
        typeof displayed.total === 'number' &&
        displayed.total > 0 &&
        displayed.page >= displayed.total)
    const rightFirst = this.paginationModel().spreadSlotOrder === 'right-first'
    const terminalSlot = endsAtSectionEnd
      ? rightFirst
        ? left
          ? 'left'
          : 'right'
        : right
          ? 'right'
          : 'left'
      : undefined
    const anchor =
      terminalSlot ??
      (spread.anchor === 'right' && right
        ? 'right'
        : spread.anchor === 'left' && left
          ? 'left'
          : left
            ? 'left'
            : 'right')
    if (!(anchor === 'right' ? right : left)) return
    return { anchor, exact: !endsAtSectionEnd, left, right, endsAtSectionEnd }
  }
  paginationModel(): Partial<
    ReturnType<Rendition['manager']['paginationModel']>
  > {
    return this.rendition?.manager?.paginationModel() ?? {}
  }
  supportsSpreadNavigation() {
    return this.rendition?.manager?.canUseLogicalReflowableSpread() ?? false
  }
  getViews() {
    const views = this.rendition?.manager?.views
    return views ? views.all().slice() : []
  }
  getDisplayedViews() {
    return this.rendition?.manager?.views?.displayed() ?? []
  }
  currentView() {
    return this.rendition?.manager?.current() ?? this.getViews()[0]
  }
  viewForWindow(win: Window | null) {
    return this.getViews().find((view) => view.window === win)
  }
  viewportSize() {
    const manager = this.rendition?.manager
    return {
      width:
        manager?._stageSize?.width ??
        manager?.viewSettings?.width ??
        this.container?.getBoundingClientRect().width,
      height:
        manager?._stageSize?.height ??
        manager?.viewSettings?.height ??
        this.container?.getBoundingClientRect().height,
    }
  }
  setBeforeLayout(
    beforeLayout: ViewSettings['beforeLayout'],
    layoutStyleSignature?: string,
  ) {
    const manager = this.rendition?.manager
    if (!manager) return
    manager.viewSettings.beforeLayout = beforeLayout
    manager.viewSettings.layoutStyleSignature = layoutStyleSignature
  }
  setAutomaticResize(enabled: boolean) {
    if (this.rendition?.manager) this.rendition.manager.suspendResize = !enabled
  }
  invalidateLayout() {
    this.rendition?.manager?.resetReflowablePageState(true)
  }

  private operation(work: (rendition: Rendition) => unknown) {
    const rendition = this.rendition
    if (!rendition) throw new Error('Reader session is closed')
    const pending = work(rendition)
    const requestId = rendition._locationRequestId
    const finished = new Promise<Location | undefined>((resolve, reject) => {
      const cancel = () => resolve(undefined)
      this.pending.add(cancel)
      Promise.resolve(pending).then(
        () => {
          this.pending.delete(cancel)
          resolve(
            this.rendition && requestId === rendition._locationRequestId
              ? rendition.location
              : undefined,
          )
        },
        (error) => {
          this.pending.delete(cancel)
          if (this.rendition) reject(error)
          else resolve(undefined)
        },
      )
    })
    return { requestId, finished }
  }
  display(target?: string | number, options?: RenditionDisplayOptions) {
    return this.operation((rendition) => rendition.display(target, options))
  }
  next() {
    return this.operation((rendition) => rendition.next())
  }
  prev() {
    return this.operation((rendition) => rendition.prev())
  }
  restoreSpread(spread: ReaderSpread) {
    return this.operation((rendition) => {
      const requestId = rendition.beginLocationRequest()
      return rendition.manager
        .renderReflowableSpread(spread)
        .then(() => rendition.reportLocation(requestId))
    })
  }
  resize(
    width: number,
    height: number,
    target?: string,
    spread?: ReaderSpread,
  ) {
    const rendition = this.rendition
    if (!rendition) throw new Error('Reader session is closed')
    rendition._flowSuppressResizeRedisplay = true
    try {
      rendition.resize(width, height, target)
    } finally {
      rendition._flowSuppressResizeRedisplay = false
    }
    return spread ? this.restoreSpread(spread) : this.display(target)
  }
  refreshSection(section: Section) {
    return this.operation((rendition) => {
      rendition.manager.refreshSection(section)
      return rendition.reportLocation(rendition.beginLocationRequest())
    })
  }
  sectionLayoutKey(section: Section) {
    return this.rendition?.manager?.sectionMeasurements.layoutKey(section)
  }
  pageForTarget(section: Section, target?: string) {
    return (
      this.rendition?.manager?.reflowablePageForTarget(section, target) ??
      Promise.resolve(undefined)
    )
  }
  findInDisplayedSection(section: Section, query: string, signal: AbortSignal) {
    return (
      this.rendition?.manager?.findInDisplayedSection(section, query, signal) ??
      Promise.resolve([])
    )
  }
  firstSpreadPage(spread: ReaderSpread) {
    return this.rendition?.manager?.reflowableSpreadEarlierPage(spread)
  }
  scrollHorizontalByReadingDirection(delta: number, silent?: boolean) {
    return (
      this.rendition?.manager?.scrollHorizontalByReadingDirection(
        delta,
        silent,
      ) ?? false
    )
  }
  destroy() {
    this.rendition = undefined
    for (const cancel of this.pending) cancel()
    this.pending.clear()
  }
}
