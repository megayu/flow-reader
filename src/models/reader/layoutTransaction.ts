import type { BookTab } from './model'
import { hydrateReflowableSpread } from './pagination'

export class BookLayoutTransactionController {
  private operationId = 0
  private operationPromise = Promise.resolve()
  private operationPending = false

  isCurrent(operationId: number) {
    return operationId === this.operationId
  }

  invalidate() {
    this.operationId++
  }

  waitForPending() {
    if (!this.operationPending) return
    return this.waitForPendingOperations()
  }

  private async waitForPendingOperations() {
    while (true) {
      const operation = this.operationPromise
      try {
        await operation
      } catch {
        // Callers wait for transaction ownership, while the transaction reports its own error.
      }
      if (this.operationPromise === operation) return
    }
  }

  enqueueResize(run: (operationId: number) => Promise<void>) {
    const operationId = ++this.operationId
    const operation = this.operationPromise.catch(() => undefined).then(() => run(operationId))
    this.trackOperation(operation)
  }

  enqueueRelayout(run: (operationId: number) => Promise<void>) {
    const operationId = ++this.operationId
    const operation = this.operationPromise.catch(() => undefined).then(() => run(operationId))

    this.trackOperation(operation)
    return operation
  }

  private trackOperation(operation: Promise<void>) {
    this.operationPending = true
    const settled = operation.then(
      () => undefined,
      () => undefined,
    )
    this.operationPromise = settled
    void settled.then(() => {
      if (this.operationPromise === settled) this.operationPending = false
    })
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
    const rendition = tab.rendition
    const session = rendition?.session
    const layoutKey = tab.layoutAnchorKey(width, height)
    const spread =
      tab.storedSpreadForLayout(width, height) ??
      hydrateReflowableSpread(tab.runtimeSpreadAnchor, tab.sections, tab.layoutStyleSignature)

    if (!rendition || !session) return

    try {
      await tab.commitReaderOperation(session.resize(width, height, target, spread), {
        layoutKey,
        updateAnchor: false,
      })
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
      await tab.commitReaderOperation(tab.rendition?.session.display(resolvedTarget), {
        updateAnchor: false,
      })
    } catch (error) {
      if (generation === tab.renderGeneration) console.error(error)
    }
  }

  async displayInitialPosition(tab: BookTab) {
    const deepLinkTarget = tab.takePendingDeepLinkTarget()
    const contentReloadTarget = tab.contentReloadTarget
    tab.contentReloadTarget = undefined
    const session = tab.rendition?.session
    const spread =
      deepLinkTarget || contentReloadTarget
        ? undefined
        : hydrateReflowableSpread(tab.book.configuration?.spread, tab.sections, tab.layoutStyleSignature)

    if (spread && session?.supportsSpreadNavigation()) {
      await tab.commitReaderOperation(session.restoreSpread(spread), { updateAnchor: true })
      return
    }

    const requestedInitialTarget = contentReloadTarget ?? tab.location?.start.cfi ?? tab.book.cfi ?? undefined
    const initialTarget = tab.resolveDisplayTarget(requestedInitialTarget, 'initial')
    const initialSpread = tab.book.configuration?.spread
    const target = tab.resolveDisplayTarget(deepLinkTarget ?? initialTarget, 'initial')
    await tab.commitReaderOperation(tab.rendition?.session.display(target), {
      anchorTarget: target,
      updateAnchor: true,
      userNavigation: !!deepLinkTarget,
    })
    if (deepLinkTarget && initialTarget && !tab.targetIsInCurrentLocation(initialTarget)) {
      tab.showPrevLocation(initialTarget, initialSpread)
    }
  }
}
