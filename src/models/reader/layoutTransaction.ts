import type { BookTab } from './model'
import { hydrateReflowableSpread } from './pagination'

export class BookLayoutTransactionController {
  private operationId = 0
  private operationPromise = Promise.resolve()

  isCurrent(operationId: number) {
    return operationId === this.operationId
  }

  invalidate() {
    this.operationId++
  }

  enqueueResize(run: (operationId: number) => Promise<void>) {
    const operationId = ++this.operationId

    this.operationPromise = this.operationPromise.catch(() => undefined).then(() => run(operationId))
  }

  enqueueRelayout(run: (operationId: number) => Promise<void>) {
    const operationId = ++this.operationId
    const operation = this.operationPromise.catch(() => undefined).then(() => run(operationId))

    this.operationPromise = operation.then(
      () => undefined,
      () => undefined,
    )
    return operation
  }

  resize(tab: BookTab, width: number, height: number) {
    this.enqueueResize((operationId) => this.runResize(tab, operationId, width, height))
  }

  private async runResize(tab: BookTab, operationId: number, width: number, height: number) {
    try {
      await tab.waitForPendingNavigation()
    } catch {
      // A failed navigation must not let a stale resize commit.
    }
    if (!this.isCurrent(operationId)) return

    const target = tab.committedDisplayTarget()
    if (!target) return

    tab.rememberCurrentLayoutSpread()
    tab.allowLocationJump = false
    tab.navigationDirection = undefined
    tab.relayoutAnchorSectionIndexes = [...tab.visibleSectionIndexes]
    const rendition = tab.rendition as any
    const manager = rendition?.manager
    const layoutKey = tab.layoutAnchorKey(width, height)
    const spread =
      tab.storedSpreadForLayout(width, height) ??
      hydrateReflowableSpread(tab.runtimeSpreadAnchor, tab.sections, tab.layoutStyleSignature)

    if (!rendition || !manager) return

    rendition._flowSuppressResizeRedisplay = true
    try {
      rendition.resize(width, height, target)
    } finally {
      rendition._flowSuppressResizeRedisplay = false
    }

    try {
      if (spread && manager.renderReflowableSpread) {
        const requestId = tab.createManualLocationRequest({
          layoutKey,
          updateAnchor: false,
        })
        await manager.renderReflowableSpread(spread)
        await (tab.rendition as any)?.reportLocation(requestId)
        tab.commitPendingRenditionLocation(requestId)
        return
      }

      const previousRequestId = tab.currentRenditionLocationRequestId()
      const display = tab.rendition?.display(target)
      const requestId = tab.trackRenditionLocationRequest(previousRequestId, {
        layoutKey,
        updateAnchor: false,
      })
      await display
      tab.commitPendingRenditionLocation(requestId)
    } catch (error) {
      console.error(error)
    }
  }

  relayout(tab: BookTab, target?: string) {
    return this.enqueueRelayout((operationId) => this.runRelayout(tab, operationId, target))
  }

  private async runRelayout(tab: BookTab, operationId: number, target: string | undefined) {
    try {
      await tab.waitForPendingNavigation()
    } catch {
      // A failed navigation must not let a stale relayout commit.
    }
    if (!this.isCurrent(operationId)) return

    const generation = tab.renderGeneration
    const resolvedTarget = tab.resolveDisplayTarget(target)
    if (!resolvedTarget) return

    tab.resetLayoutPageState()
    tab.allowLocationJump = false
    tab.navigationDirection = undefined
    tab.relayoutAnchorSectionIndexes = [...tab.visibleSectionIndexes]

    try {
      const previousRequestId = tab.currentRenditionLocationRequestId()
      const display = tab.rendition?.display(resolvedTarget)
      const requestId = tab.trackRenditionLocationRequest(previousRequestId, {
        updateAnchor: false,
      })
      await display
      tab.commitPendingRenditionLocation(requestId)
    } catch (error) {
      if (generation === tab.renderGeneration) console.error(error)
    }
  }

  async displayInitialPosition(tab: BookTab) {
    const contentReloadTarget = tab.contentReloadTarget
    tab.contentReloadTarget = undefined
    const manager = tab.rendition?.manager
    const spread = contentReloadTarget
      ? undefined
      : hydrateReflowableSpread(tab.book.configuration?.spread, tab.sections, tab.layoutStyleSignature)

    if (spread && manager?.canUseLogicalReflowableSpread?.() && manager.renderReflowableSpread) {
      const requestId = tab.createManualLocationRequest({ updateAnchor: true })
      await manager.renderReflowableSpread(spread)
      await (tab.rendition as any)?.reportLocation(requestId)
      tab.commitPendingRenditionLocation(requestId)
      return
    }

    const target = tab.resolveDisplayTarget(
      contentReloadTarget ?? tab.location?.start.cfi ?? tab.book.cfi ?? undefined,
      'initial',
    )
    const previousRequestId = tab.currentRenditionLocationRequestId()
    const display = tab.rendition?.display(target)
    const requestId = tab.trackRenditionLocationRequest(previousRequestId, {
      anchorTarget: target,
      updateAnchor: true,
    })
    await display
    tab.commitPendingRenditionLocation(requestId)
  }
}
