import type { Annotation } from '../../annotation'
import { db } from '../../storage/client'
import type { BookRecord, BookStateCheckpointInput } from '../../storage/types'

import { AnnotationChanges, normalizedAnnotationNotes, sameSemanticAnnotation } from './annotationChanges'

export const ANNOTATION_CHECKPOINT_NET_LIMIT = 20

export interface BookPersistenceHost {
  getBook: () => BookRecord
  applyBookUpdate: (book: BookRecord, changes: Partial<BookRecord>) => void
  createCurrentPositionUpdate: () => Partial<BookRecord> | undefined
  waitForNavigation: () => Promise<void> | undefined
}

interface CheckpointOptions {
  close?: boolean
  force?: boolean
}

function sameDefinitions(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function sameConfiguration(left: BookRecord['configuration'], right: BookRecord['configuration']) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function cloneConfiguration(configuration: BookRecord['configuration']) {
  if (!configuration) return undefined
  return {
    ...(configuration.typography ? { typography: { ...configuration.typography } } : {}),
    ...(configuration.spread ? { spread: { ...configuration.spread } } : {}),
  }
}

function cloneAnnotations(annotations: readonly Annotation[]) {
  return annotations.map((annotation) => ({
    ...annotation,
    spine: { ...annotation.spine },
  }))
}

export class BookPersistenceController {
  private annotationChanges = new AnnotationChanges([])
  private revision = 0
  private committedRevision = 0
  private checkpointTail: Promise<void> = Promise.resolve()
  private thresholdCheckpointQueued = false

  initialize(book: BookRecord) {
    this.annotationChanges = new AnnotationChanges(book.annotations)
  }

  private apply(host: BookPersistenceHost, changes: Partial<BookRecord>) {
    const book = { ...host.getBook(), ...changes }
    host.applyBookUpdate(book, changes)
  }

  private advanceState(host: BookPersistenceHost, changes: Partial<BookRecord>, eventTime = Date.now()) {
    this.revision += 1
    this.apply(host, { ...changes, updatedAt: eventTime })
    db.books.updateCachedFields(host.getBook().id, { updatedAt: eventTime })
  }

  recordOpened(host: BookPersistenceHost) {
    this.revision += 1
    const lastReadAt = Date.now()
    this.apply(host, { lastReadAt })
    db.books.updateCachedFields(host.getBook().id, { lastReadAt })
  }

  recordPosition(host: BookPersistenceHost, changes: Partial<BookRecord>) {
    const current = host.getBook()
    const nextConfiguration = changes.configuration ?? current.configuration
    if (
      changes.cfi === current.cfi &&
      changes.percentage === current.percentage &&
      sameConfiguration(nextConfiguration, current.configuration)
    ) {
      return
    }

    this.revision += 1
    const lastReadAt = Date.now()
    this.apply(host, { ...changes, lastReadAt })
    db.books.updateCachedFields(host.getBook().id, {
      cfi: changes.cfi,
      percentage: changes.percentage,
      lastReadAt,
    })
  }

  recordDefinitions(host: BookPersistenceHost, definitions: string[]) {
    if (sameDefinitions(host.getBook().definitions, definitions)) return
    this.advanceState(host, { definitions })
  }

  recordConfiguration(host: BookPersistenceHost, configuration: BookRecord['configuration']) {
    if (sameConfiguration(host.getBook().configuration, configuration)) return
    this.advanceState(host, { configuration })
  }

  recordAnnotation(
    host: BookPersistenceHost,
    before: Annotation | undefined,
    after: Annotation | undefined,
    annotations: Annotation[],
    requireCheckpoint = false,
  ) {
    if (sameSemanticAnnotation(before, after)) {
      return requireCheckpoint ? this.checkpoint(host) : Promise.resolve()
    }

    this.advanceState(host, { annotations })
    const id = after?.cfi ?? before?.cfi
    if (!id) return Promise.resolve()
    this.annotationChanges.record(id, after)

    if (requireCheckpoint || normalizedAnnotationNotes(before) !== normalizedAnnotationNotes(after)) {
      return this.checkpoint(host)
    }

    this.maybeCheckpointAnnotationThreshold(host)
    return Promise.resolve()
  }

  private maybeCheckpointAnnotationThreshold(host: BookPersistenceHost) {
    if (this.annotationChanges.size < ANNOTATION_CHECKPOINT_NET_LIMIT || this.thresholdCheckpointQueued) {
      return
    }

    this.thresholdCheckpointQueued = true
    void this.checkpoint(host).then(
      () => {
        this.thresholdCheckpointQueued = false
        this.maybeCheckpointAnnotationThreshold(host)
      },
      (error) => {
        this.thresholdCheckpointQueued = false
        console.error(error)
      },
    )
  }

  private createCheckpoint(book: BookRecord): BookStateCheckpointInput {
    return {
      id: book.id,
      state: {
        annotations: cloneAnnotations(book.annotations),
        definitions: [...book.definitions],
        cfi: book.cfi,
        percentage: book.percentage,
        configuration: cloneConfiguration(book.configuration),
      },
      stateUpdatedAt: book.updatedAt,
      lastReadAt: book.lastReadAt,
    }
  }

  private async executeCheckpoint(host: BookPersistenceHost, force: boolean, close: boolean) {
    if (!force && !close && this.revision === this.committedRevision) return

    const capturedRevision = this.revision
    const checkpoint = this.createCheckpoint(host.getBook())
    await (close ? db.books.persistStateOnClose(checkpoint) : db.books.persistState(checkpoint))

    this.committedRevision = Math.max(this.committedRevision, capturedRevision)
    this.annotationChanges.replaceBaseline(checkpoint.state.annotations, host.getBook().annotations)
  }

  checkpoint(host: BookPersistenceHost, { close = false, force = false }: CheckpointOptions = {}) {
    const checkpoint = this.checkpointTail.then(() => this.executeCheckpoint(host, force, close))
    this.checkpointTail = checkpoint.catch(() => undefined)
    return checkpoint.then(() => {
      this.maybeCheckpointAnnotationThreshold(host)
    })
  }

  checkpointContentEdit(host: BookPersistenceHost) {
    this.revision += 1
    return this.checkpoint(host, { force: true })
  }

  private captureCurrentPosition(host: BookPersistenceHost) {
    const positionUpdate = host.createCurrentPositionUpdate()
    if (positionUpdate) this.recordPosition(host, positionUpdate)
  }

  private async captureStableState(host: BookPersistenceHost) {
    await host.waitForNavigation()
    this.captureCurrentPosition(host)
  }

  async flushForClose(host: BookPersistenceHost, onStateCaptured?: () => void) {
    await this.captureStableState(host)
    onStateCaptured?.()
    await this.checkpoint(host, { close: true })
  }

  async persistCurrentState(host: BookPersistenceHost) {
    await this.captureStableState(host)
    await this.checkpoint(host, { force: true })
  }

  async captureForAppClose(host: BookPersistenceHost) {
    await this.captureStableState(host)
    await this.checkpointTail
    if (this.revision === this.committedRevision) return
    return this.createCheckpoint(host.getBook())
  }
}
