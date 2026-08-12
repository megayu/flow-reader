import type { AppLocale } from '../locales'
import type { PageAppearance, TypographyConfiguration } from '../reader/configuration'
import type { BookSourceStorage } from '../storage/types'
import type { ThemeConfiguration } from '../styles/theme'
import { defaultUiFontSize } from '../styles/ui'
import type { TranslationLanguage, TranslationProvider } from '../translation/languages'

export type ViewMode = 'reader' | 'library'
export type LibrarySortField = 'title' | 'creator' | 'updatedAt' | 'createdAt'
export type LibrarySortDirection = 'asc' | 'desc'

export interface Settings extends TypographyConfiguration {
  dictionary?: DictionarySettingsConfiguration
  translation?: TranslationSettingsConfiguration
  theme?: ThemeConfiguration
  ui?: UiConfiguration
  enableTextSelectionMenu?: boolean
  directTextImport?: boolean
  hideEndnotes?: boolean
  restoreLastReadingOnStartup?: boolean
  showLibraryInToc?: boolean
  showRecentBooks?: boolean
  showModifiedBookExportIndicator?: boolean
  importSourceStorage?: BookSourceStorage
  copyTextImports?: boolean
  startupSession?: StartupSession
  libraryDisplay?: LibraryDisplayConfiguration
  librarySort?: LibrarySortConfiguration
  textImportRules?: TextImportRulesConfiguration
  locale?: AppLocale
}

export interface TranslationSettingsConfiguration {
  mainLanguage: TranslationLanguage
  secondaryLanguage: TranslationLanguage
  defaultProvider: TranslationProvider
}

export interface DictionarySettingsConfiguration {
  zdic: ZdicSettingsConfiguration
  merriamWebster: MerriamWebsterSettingsConfiguration
  sourceOrder: string[]
}

export interface ZdicSettingsConfiguration {
  enabled: boolean
}

export interface MerriamWebsterSettingsConfiguration {
  apiKey: string
  enabled: boolean
}

interface UiConfiguration {
  fontSize?: number
}

interface StartupSession {
  viewMode?: ViewMode
  bookId?: string
}

export interface LibrarySortConfiguration {
  field: LibrarySortField
  direction: LibrarySortDirection
}

export interface LibraryDisplayConfiguration {
  bookCardWidth: number
}

export interface TextImportRulesConfiguration {
  groupPatterns: string[]
  chapterPatterns: string[]
  filenamePatterns: string[]
}

export const librarySortFieldOptions: LibrarySortField[] = ['title', 'creator', 'updatedAt', 'createdAt']

export const defaultLibrarySort: LibrarySortConfiguration = {
  field: 'title',
  direction: 'asc',
}

export const libraryBookCardWidthMin = 120
export const libraryBookCardWidthMax = 240
export const libraryBookCardWidthStep = 10
export const defaultLibraryBookCardWidth = 160

export const defaultLibraryDisplay: LibraryDisplayConfiguration = {
  bookCardWidth: defaultLibraryBookCardWidth,
}

export const defaultTextImportRules: TextImportRulesConfiguration = {
  groupPatterns: [
    '^\\s*第[0-9一二三四五六七八九十零〇百千万两壹贰叁肆伍陆柒捌玖拾佰仟]+[卷部集篇].*',
    '^\\s*(Book|Part|Volume)\\s+[0-9IVXLCDM]+.*',
  ],
  chapterPatterns: [
    '^\\s*第[0-9一二三四五六七八九十零〇百千万两壹贰叁肆伍陆柒捌玖拾佰仟]+[章回节].*',
    '^\\s*(简介|序言|序|前言|自序|楔子|后记|尾声|番外|附录).*',
    '^\\s*Chapter\\s+[0-9IVXLCDM]+.*',
  ],
  filenamePatterns: ['《$title》.+作者：$author', '《$title》'],
}

export function normalizeTextImportRules(
  value: Partial<TextImportRulesConfiguration> | undefined,
): TextImportRulesConfiguration {
  return {
    groupPatterns: normalizeTextImportPatternList(value?.groupPatterns, defaultTextImportRules.groupPatterns),
    chapterPatterns: normalizeTextImportPatternList(value?.chapterPatterns, defaultTextImportRules.chapterPatterns),
    filenamePatterns: normalizeTextImportPatternList(value?.filenamePatterns, defaultTextImportRules.filenamePatterns),
  }
}

function normalizeTextImportPatternList(value: unknown, fallback: string[]) {
  if (!Array.isArray(value)) return [...fallback]

  return value.flatMap((pattern) => {
    if (typeof pattern !== 'string') return []
    const trimmed = pattern.trim()
    return trimmed ? [trimmed] : []
  })
}

export const defaultDictionarySettings: DictionarySettingsConfiguration = {
  zdic: {
    enabled: true,
  },
  merriamWebster: {
    apiKey: '',
    enabled: false,
  },
  sourceOrder: ['zdic', 'merriam-webster'],
}

export const defaultTranslationSettings: TranslationSettingsConfiguration = {
  mainLanguage: 'zh-Hans',
  secondaryLanguage: 'en',
  defaultProvider: 'google',
}

export const defaultSettings: Settings = {
  dictionary: defaultDictionarySettings,
  translation: defaultTranslationSettings,
  enableTextSelectionMenu: false,
  directTextImport: false,
  hideEndnotes: false,
  restoreLastReadingOnStartup: false,
  showLibraryInToc: false,
  showRecentBooks: false,
  showModifiedBookExportIndicator: true,
  importSourceStorage: 'referenced',
  copyTextImports: false,
  libraryDisplay: defaultLibraryDisplay,
  librarySort: defaultLibrarySort,
  textImportRules: defaultTextImportRules,
  ui: {
    fontSize: defaultUiFontSize,
  },
}

export type { PageAppearance, TypographyConfiguration }
