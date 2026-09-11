import { normalizeThemeConfiguration } from '../styles/theme'
import { normalizeUiFontSize } from '../styles/ui'
import { TRANSLATION_LANGUAGES } from '../translation/languages'

import {
  createDefaultTranslationSettings,
  type DictionarySettingsConfiguration,
  defaultDictionarySettings,
  defaultLibraryBookCardWidth,
  defaultLibrarySort,
  defaultSettings,
  type LibraryDisplayConfiguration,
  type LibrarySortConfiguration,
  type LibrarySortField,
  libraryBookCardWidthMax,
  libraryBookCardWidthMin,
  libraryBookCardWidthStep,
  librarySortFieldOptions,
  type Settings,
  type TranslationSettingsConfiguration,
} from './configuration'

export function normalizeSettings(value: Partial<Settings>): Settings {
  const settings = { ...defaultSettings, ...value }

  return {
    ...settings,
    theme: normalizeThemeConfiguration(settings.theme),
    libraryDisplay: normalizeLibraryDisplay(settings.libraryDisplay),
    librarySort: normalizeLibrarySort(settings.librarySort),
    textImportRules: settings.textImportRules,
    directTextImport: settings.directTextImport === true,
    dictionary: normalizeDictionarySettings(settings.dictionary),
    translation: normalizeTranslationSettings(value.translation, settings.locale),
    importSourceStorage: settings.importSourceStorage === 'referenced' ? 'referenced' : 'managed',
    defaultEpubMode: settings.defaultEpubMode === 'unpacked' ? 'unpacked' : 'archive',
    copyTextImports: settings.copyTextImports === true,
    ui: {
      ...defaultSettings.ui,
      ...settings.ui,
      fontSize: normalizeUiFontSize(settings.ui?.fontSize),
    },
  }
}

function normalizeTranslationSettings(
  value: Partial<TranslationSettingsConfiguration> | undefined,
  locale: Settings['locale'],
): TranslationSettingsConfiguration {
  const defaults = createDefaultTranslationSettings(locale)
  const supported = new Set<string>(TRANSLATION_LANGUAGES.map(({ id }) => id))
  const mainLanguage = supported.has(value?.mainLanguage ?? '') ? value!.mainLanguage! : defaults.mainLanguage
  let secondaryLanguage = supported.has(value?.secondaryLanguage ?? '')
    ? value!.secondaryLanguage!
    : mainLanguage === 'en'
      ? 'zh-Hans'
      : 'en'
  if (secondaryLanguage === mainLanguage) {
    secondaryLanguage = mainLanguage === 'en' ? 'zh-Hans' : 'en'
  }
  return {
    mainLanguage,
    secondaryLanguage,
    defaultProvider: value?.defaultProvider === 'azure' ? 'azure' : 'google',
  }
}

function normalizeDictionarySettings(
  value: Partial<DictionarySettingsConfiguration> | undefined,
): DictionarySettingsConfiguration {
  return {
    zdic: {
      enabled: value?.zdic?.enabled !== false,
    },
    merriamWebster: {
      ...defaultDictionarySettings.merriamWebster,
      ...value?.merriamWebster,
      apiKey: typeof value?.merriamWebster?.apiKey === 'string' ? value.merriamWebster.apiKey : '',
      enabled: value?.merriamWebster?.enabled === true,
    },
    sourceOrder: normalizeDictionarySourceOrder(value?.sourceOrder),
  }
}

function normalizeDictionarySourceOrder(value: unknown) {
  if (!Array.isArray(value)) return [...defaultDictionarySettings.sourceOrder]

  const defaultSourceIds = new Set(defaultDictionarySettings.sourceOrder)
  const seen = new Set<string>()
  const result: string[] = []
  for (const sourceId of value) {
    if (
      typeof sourceId !== 'string' ||
      (!defaultSourceIds.has(sourceId) && !sourceId.startsWith('local:')) ||
      seen.has(sourceId)
    ) {
      continue
    }
    seen.add(sourceId)
    result.push(sourceId)
  }
  for (const sourceId of defaultDictionarySettings.sourceOrder) {
    if (!seen.has(sourceId)) result.push(sourceId)
  }
  return result
}

export function normalizeLibraryBookCardWidth(value: unknown) {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? value : defaultLibraryBookCardWidth

  const stepped = Math.round(numeric / libraryBookCardWidthStep) * libraryBookCardWidthStep

  return Math.min(Math.max(stepped, libraryBookCardWidthMin), libraryBookCardWidthMax)
}

function normalizeLibraryDisplay(value: Partial<LibraryDisplayConfiguration> | undefined): LibraryDisplayConfiguration {
  return {
    bookCardWidth: normalizeLibraryBookCardWidth(value?.bookCardWidth),
    coverFit: value?.coverFit === 'contain' ? 'contain' : 'cover',
  }
}

function normalizeLibrarySort(value: Partial<LibrarySortConfiguration> | undefined): LibrarySortConfiguration {
  const field = librarySortFieldOptions.includes(value?.field as LibrarySortField)
    ? (value?.field as LibrarySortField)
    : defaultLibrarySort.field
  const direction =
    value?.direction === 'desc' || value?.direction === 'asc' ? value.direction : defaultLibrarySort.direction

  return { field, direction }
}
