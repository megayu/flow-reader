export type CoverResourceStatus = 'error' | 'loading' | 'queued' | 'ready'

export interface CoverResourceIdentity {
  bookId: string
  cover: string
}

export interface CoverResourceCacheBudget {
  hardEntryCap: number
  highWaterBytes: number
  lowWaterBytes: number
}

interface CoverResourceEntry extends CoverResourceIdentity {
  cached: boolean
  disposed: boolean
  estimatedBytes: number
  image?: HTMLImageElement
  key: string
  lastUsed: number
  listeners: Set<(status: CoverResourceStatus) => void>
  loadingActive: boolean
  presentationLeases: number
  returnLeases: number
  status: CoverResourceStatus
}

const mebibyte = 1024 * 1024
const maxConcurrentLoads = 8
export const libraryReturnGraceMs = 15_000
const defaultBudget: CoverResourceCacheBudget = {
  hardEntryCap: 96,
  highWaterBytes: 224 * mebibyte,
  lowWaterBytes: 160 * mebibyte,
}
const allEntries = new Set<CoverResourceEntry>()
const entries = new Map<string, CoverResourceEntry>()
let accessClock = 0
let activeLoads = 0
let budget = defaultBudget
let loadQueue: CoverResourceEntry[] = []
let disposeTimer: number | undefined

function resourceKey({ bookId, cover }: CoverResourceIdentity) {
  return `${bookId}\u0000${cover}`
}

function isSvgCover(cover: string) {
  return new URL(cover).pathname.toLowerCase().endsWith('.svg')
}

function initialEstimatedBytes(cover: string) {
  return (isSvgCover(cover) ? 4 : 2) * mebibyte
}

function decodedEstimatedBytes(entry: CoverResourceEntry, image: HTMLImageElement) {
  const rgbaBytes = image.naturalWidth * image.naturalHeight * 4
  const multiplier = isSvgCover(entry.cover) ? 6 : 3
  return Math.max(entry.estimatedBytes, rgbaBytes * multiplier)
}

function touch(entry: CoverResourceEntry) {
  accessClock += 1
  entry.lastUsed = accessClock
}

function notify(entry: CoverResourceEntry, status: CoverResourceStatus) {
  if (entry.disposed || entry.status === status) return
  entry.status = status
  for (const listener of entry.listeners) listener(status)
}

function totalEstimatedBytes() {
  let total = 0
  for (const entry of entries.values()) total += entry.estimatedBytes
  return total
}

function finishActiveLoad(entry: CoverResourceEntry) {
  if (!entry.loadingActive) return
  entry.loadingActive = false
  activeLoads = Math.max(0, activeLoads - 1)
}

function disposeEntry(entry: CoverResourceEntry) {
  if (entry.disposed) return
  entry.disposed = true
  finishActiveLoad(entry)
  if (entry.image) {
    entry.image.onload = null
    entry.image.onerror = null
    entry.image.removeAttribute('src')
    entry.image = undefined
  }
  entry.listeners.clear()
  allEntries.delete(entry)
}

function findUnusedEntry() {
  let candidate: CoverResourceEntry | undefined
  for (const entry of entries.values()) {
    if (entry.presentationLeases || entry.returnLeases) continue
    if (!candidate || entry.lastUsed < candidate.lastUsed) candidate = entry
  }
  return candidate
}

function evictEntry(entry: CoverResourceEntry) {
  entries.delete(entry.key)
  disposeEntry(entry)
}

function enforceBudget() {
  let bytes = totalEstimatedBytes()
  const bytesExceeded = bytes > budget.highWaterBytes
  while (entries.size > budget.hardEntryCap || (bytesExceeded && bytes > budget.lowWaterBytes)) {
    const candidate = findUnusedEntry()
    if (!candidate) break
    bytes -= candidate.estimatedBytes
    evictEntry(candidate)
  }
}

function finishLoad(entry: CoverResourceEntry, status: 'error' | 'ready') {
  if (entry.disposed) return
  const image = entry.image
  if (image) {
    image.onload = null
    image.onerror = null
    if (status === 'ready') entry.estimatedBytes = decodedEstimatedBytes(entry, image)
  }
  finishActiveLoad(entry)
  notify(entry, status)
  enforceBudget()
  startQueuedLoads()
}

function startLoad(entry: CoverResourceEntry) {
  if (entry.disposed || entry.status !== 'queued') return
  activeLoads += 1
  entry.loadingActive = true
  notify(entry, 'loading')
  const image = new Image()
  entry.image = image
  image.decoding = 'async'
  image.onload = () => {
    void image
      .decode()
      .catch(() => undefined)
      .then(() => finishLoad(entry, image.complete && image.naturalWidth > 0 ? 'ready' : 'error'))
  }
  image.onerror = () => finishLoad(entry, 'error')
  image.src = entry.cover
}

function startQueuedLoads() {
  while (activeLoads < maxConcurrentLoads && loadQueue.length) {
    const entry = loadQueue.shift()
    if (entry) startLoad(entry)
  }
}

function createEntry(identity: CoverResourceIdentity, cached: boolean): CoverResourceEntry {
  const entry: CoverResourceEntry = {
    ...identity,
    cached,
    disposed: false,
    estimatedBytes: initialEstimatedBytes(identity.cover),
    key: resourceKey(identity),
    lastUsed: 0,
    listeners: new Set(),
    loadingActive: false,
    presentationLeases: 0,
    returnLeases: 0,
    status: 'queued',
  }
  touch(entry)
  allEntries.add(entry)
  loadQueue.push(entry)
  startQueuedLoads()
  return entry
}

function getOrCreateEntry(identity: CoverResourceIdentity, enforceBeforeCreate = true) {
  const key = resourceKey(identity)
  const existing = entries.get(key)
  if (existing) {
    touch(existing)
    return existing
  }

  if (enforceBeforeCreate) enforceBudget()
  const cached = entries.size < budget.hardEntryCap
  const entry = createEntry(identity, cached)
  if (cached) entries.set(key, entry)
  return entry
}

function releaseEntryLease(entry: CoverResourceEntry, lease: 'presentationLeases' | 'returnLeases') {
  if (entry.disposed) return false
  entry[lease] = Math.max(0, entry[lease] - 1)
  touch(entry)
  if (!entry.cached && !entry.presentationLeases && !entry.returnLeases) disposeEntry(entry)
  return true
}

function releaseEntry(entry: CoverResourceEntry, lease: 'presentationLeases' | 'returnLeases') {
  if (!releaseEntryLease(entry, lease)) return
  enforceBudget()
  startQueuedLoads()
}

function releaseEntries(leased: readonly CoverResourceEntry[], lease: 'presentationLeases' | 'returnLeases') {
  for (const entry of leased) releaseEntryLease(entry, lease)
  enforceBudget()
  startQueuedLoads()
}

export function getCoverResourceCacheBudget(protectedEntryCount: number): CoverResourceCacheBudget {
  const protectedEntries = Math.max(0, Math.floor(protectedEntryCount))
  const lowWaterMiB = Math.min(160, Math.max(96, protectedEntries * 4))
  return {
    hardEntryCap: Math.min(96, Math.max(64, Math.ceil(protectedEntries * 2.5))),
    highWaterBytes: Math.min(224, lowWaterMiB + 64) * mebibyte,
    lowWaterBytes: lowWaterMiB * mebibyte,
  }
}

export function configureCoverResourceCache(nextBudget: CoverResourceCacheBudget) {
  budget = nextBudget
  enforceBudget()
}

function cancelDisposeTimer() {
  if (disposeTimer === undefined) return
  window.clearTimeout(disposeTimer)
  disposeTimer = undefined
}

export function disposeCoverResourceCache() {
  cancelDisposeTimer()
  const retained = [...allEntries]
  entries.clear()
  loadQueue = []
  retained.forEach(disposeEntry)
  budget = defaultBudget
}

export function resumeCoverResourceCache() {
  cancelDisposeTimer()
}

export function suspendCoverResourceCache() {
  cancelDisposeTimer()
  if (!allEntries.size) return

  const readyVisibleEntries = new Set(
    [...allEntries].filter((entry) => entry.presentationLeases > 0 && entry.status === 'ready'),
  )
  for (const entry of [...allEntries]) {
    if (!readyVisibleEntries.has(entry)) {
      entries.delete(entry.key)
      disposeEntry(entry)
    }
  }
  loadQueue = []
  if (!allEntries.size) return
  disposeTimer = window.setTimeout(() => {
    disposeTimer = undefined
    disposeCoverResourceCache()
  }, libraryReturnGraceMs)
}

export function isCoverResourceReady(identity: CoverResourceIdentity) {
  return entries.get(resourceKey(identity))?.status === 'ready'
}

export function acquireCoverResource(
  identity: CoverResourceIdentity,
  listener: (status: CoverResourceStatus) => void,
): () => void {
  const entry = getOrCreateEntry(identity)
  entry.presentationLeases += 1
  entry.listeners.add(listener)
  listener(entry.status)
  enforceBudget()
  return () => {
    entry.listeners.delete(listener)
    releaseEntry(entry, 'presentationLeases')
  }
}

export function leaseCoverResources(identities: readonly CoverResourceIdentity[]): () => void {
  enforceBudget()
  const leased = identities.map((identity) => {
    const entry = getOrCreateEntry(identity, false)
    entry.returnLeases += 1
    return entry
  })
  enforceBudget()
  return () => releaseEntries(leased, 'returnLeases')
}
