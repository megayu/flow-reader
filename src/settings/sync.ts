import {
  flushSettingsInStorage,
  getSettingsFromStorage,
  resetTextImportRuleInStorage,
  updateSettingsInStorage,
} from '@/storage/client'

import type { Settings, TextImportRulesConfiguration } from './configuration'

export type TextImportRuleKind = keyof TextImportRulesConfiguration

export interface SettingsBootstrap {
  settings: Partial<Settings>
  textImportRuleDefaults: TextImportRulesConfiguration
}

let revision = 0
let operationQueue = Promise.resolve()

function enqueue<T>(operation: () => Promise<T>) {
  const result = operationQueue.then(operation)
  operationQueue = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}

export function updateNativeSettings(settings: Settings, flush: boolean) {
  if (!flush) revision += 1
  return enqueue(() => updateSettingsInStorage(settings, flush))
}

export function getNativeSettingsBootstrap() {
  return getSettingsFromStorage<SettingsBootstrap>()
}

export function resetNativeTextImportRule(kind: TextImportRuleKind) {
  revision += 1
  return enqueue(() => resetTextImportRuleInStorage(kind))
}

export function currentSettingsRevision() {
  return revision
}

export async function flushSettingsIfChangedSince(openRevision: number) {
  if (revision === openRevision) return false

  await enqueue(flushSettingsInStorage)
  return true
}
