import type { MessageKey } from './locales'

export type ShortcutChordValue = string[]

export type ShortcutActionId =
  | 'annotationPanel'
  | 'chapterFind'
  | 'closeAllTabs'
  | 'closeTab'
  | 'dismissReturn'
  | 'fullscreen'
  | 'imagePanel'
  | 'increaseFontSize'
  | 'libraryAuthorSearch'
  | 'libraryBatchTags'
  | 'libraryDeleteSelection'
  | 'libraryFilterAll'
  | 'libraryFilterClear'
  | 'libraryFilterPanel'
  | 'libraryFilterRead'
  | 'libraryFilterReading'
  | 'libraryFilterToRead'
  | 'libraryImport'
  | 'libraryImportFolder'
  | 'libraryReaderToggle'
  | 'librarySelectAll'
  | 'libraryTagSearch'
  | 'libraryTitleSearch'
  | 'moveTabLeft'
  | 'moveTabRight'
  | 'nextChapter'
  | 'nextFindResult'
  | 'nextPage'
  | 'openSettings'
  | 'previousChapter'
  | 'previousFindResult'
  | 'previousPage'
  | 'resetFontSize'
  | 'returnPrevious'
  | 'returnStart'
  | 'searchPanel'
  | 'selectionAnnotate'
  | 'selectionCopy'
  | 'selectionDefinitionToggle'
  | 'selectionDictionary'
  | 'selectionEditText'
  | 'selectionSearch'
  | 'selectionTranslate'
  | 'switchNextTab'
  | 'switchPreviousTab'
  | 'switchLastTab'
  | 'switchTabIndex'
  | 'tocPanel'
  | 'typographyPanel'
  | 'decreaseFontSize'
  | 'zenMode'

type ShortcutDefinition = {
  shortcuts: ShortcutChordValue[]
} & ({ labelKey: MessageKey; labelKeys?: never } | { labelKey?: never; labelKeys: [MessageKey, MessageKey] })

interface ShortcutGroupDefinition {
  titleKey: MessageKey
  items: ShortcutDefinition[]
}

const commandToken = 'Mod'

const shortcutDefinitions: Record<ShortcutActionId, ShortcutDefinition> = {
  previousPage: {
    labelKey: 'reader.previous_page',
    shortcuts: [['←'], ['↑'], ['Shift', 'Space']],
  },
  nextPage: {
    labelKey: 'reader.next_page',
    shortcuts: [['→'], ['↓'], ['Space']],
  },
  previousChapter: {
    labelKey: 'reader.previous_chapter',
    shortcuts: [['[']],
  },
  nextChapter: {
    labelKey: 'reader.next_chapter',
    shortcuts: [[']']],
  },
  returnPrevious: {
    labelKey: 'reader.return_to_previous',
    shortcuts: [['B']],
  },
  returnStart: {
    labelKey: 'reader.return_to_start',
    shortcuts: [['R']],
  },
  dismissReturn: {
    labelKey: 'reader.dismiss_return',
    shortcuts: [['X']],
  },
  chapterFind: {
    labelKey: 'reader.find_current_chapter',
    shortcuts: [[commandToken, 'F']],
  },
  selectionCopy: {
    labelKey: 'menu.copy',
    shortcuts: [['C']],
  },
  selectionSearch: {
    labelKey: 'menu.search_in_book',
    shortcuts: [['S']],
  },
  selectionDictionary: {
    labelKey: 'menu.dictionary',
    shortcuts: [['D']],
  },
  selectionTranslate: {
    labelKey: 'menu.translate',
    shortcuts: [['T']],
  },
  selectionEditText: {
    labelKey: 'menu.edit_text',
    shortcuts: [['E']],
  },
  selectionAnnotate: {
    labelKey: 'menu.annotate',
    shortcuts: [['A']],
  },
  selectionDefinitionToggle: {
    labelKeys: ['menu.define', 'menu.undefine'],
    shortcuts: [['F']],
  },
  nextFindResult: {
    labelKey: 'reader.next_find_result',
    shortcuts: [['Enter']],
  },
  previousFindResult: {
    labelKey: 'reader.previous_find_result',
    shortcuts: [['Shift', 'Enter']],
  },
  closeTab: {
    labelKey: 'tabs.close',
    shortcuts: [[commandToken, 'W']],
  },
  closeAllTabs: {
    labelKey: 'tabs.close_all',
    shortcuts: [[commandToken, 'Shift', 'W']],
  },
  switchTabIndex: {
    labelKey: 'tabs.switch_by_number',
    shortcuts: [[commandToken, '1-8']],
  },
  switchLastTab: {
    labelKey: 'tabs.switch_rightmost',
    shortcuts: [[commandToken, '9']],
  },
  switchPreviousTab: {
    labelKey: 'tabs.switch_previous',
    shortcuts: [[commandToken, '←']],
  },
  switchNextTab: {
    labelKey: 'tabs.switch_next',
    shortcuts: [[commandToken, '→']],
  },
  moveTabLeft: {
    labelKey: 'tabs.move_left',
    shortcuts: [[commandToken, 'Shift', '←']],
  },
  moveTabRight: {
    labelKey: 'tabs.move_right',
    shortcuts: [[commandToken, 'Shift', '→']],
  },
  increaseFontSize: {
    labelKey: 'typography.increase_font_size',
    shortcuts: [[commandToken, '+']],
  },
  decreaseFontSize: {
    labelKey: 'typography.decrease_font_size',
    shortcuts: [[commandToken, '-']],
  },
  resetFontSize: {
    labelKey: 'typography.reset_font_size',
    shortcuts: [[commandToken, '0']],
  },
  fullscreen: {
    labelKey: 'fullscreen.title',
    shortcuts: [['F']],
  },
  zenMode: {
    labelKey: 'zen.title',
    shortcuts: [['Z']],
  },
  tocPanel: {
    labelKey: 'toc.title',
    shortcuts: [['C']],
  },
  searchPanel: {
    labelKey: 'search.title',
    shortcuts: [['S']],
  },
  annotationPanel: {
    labelKey: 'annotation.title',
    shortcuts: [['A']],
  },
  imagePanel: {
    labelKey: 'image.title',
    shortcuts: [['G']],
  },
  typographyPanel: {
    labelKey: 'typography.title',
    shortcuts: [['T']],
  },
  libraryReaderToggle: {
    labelKey: 'mode.switch_library_reading',
    shortcuts: [['V']],
  },
  libraryAuthorSearch: {
    labelKey: 'home.library_filter.search_authors',
    shortcuts: [[commandToken, 'E']],
  },
  libraryBatchTags: {
    labelKey: 'home.tags.tooltip',
    shortcuts: [['T']],
  },
  libraryDeleteSelection: {
    labelKey: 'home.delete.tooltip',
    shortcuts: [['Del']],
  },
  openSettings: {
    labelKey: 'settings.title',
    shortcuts: [[commandToken, ',']],
  },
  libraryFilterPanel: {
    labelKey: 'library_filter.title',
    shortcuts: [['S']],
  },
  libraryFilterClear: {
    labelKey: 'home.library_filter.clear',
    shortcuts: [['Esc']],
  },
  libraryFilterAll: {
    labelKey: 'home.library_filter.all',
    shortcuts: [['`'], ['0']],
  },
  libraryFilterToRead: {
    labelKey: 'home.reading_status.to_read',
    shortcuts: [['1']],
  },
  libraryFilterReading: {
    labelKey: 'home.reading_status.reading',
    shortcuts: [['2']],
  },
  libraryFilterRead: {
    labelKey: 'home.reading_status.read',
    shortcuts: [['3']],
  },
  libraryImport: {
    labelKey: 'home.import_books',
    shortcuts: [[commandToken, 'O']],
  },
  libraryImportFolder: {
    labelKey: 'home.folder_import.action',
    shortcuts: [[commandToken, 'Shift', 'O']],
  },
  librarySelectAll: {
    labelKey: 'home.select_all',
    shortcuts: [[commandToken, 'A']],
  },
  libraryTagSearch: {
    labelKey: 'home.library_filter.search_tags',
    shortcuts: [[commandToken, 'T']],
  },
  libraryTitleSearch: {
    labelKey: 'home.library_search.title',
    shortcuts: [[commandToken, 'F']],
  },
}

const shortcutGroups: ShortcutGroupDefinition[] = [
  {
    titleKey: 'settings.shortcuts.group.navigation',
    items: [
      shortcutDefinitions.previousPage,
      shortcutDefinitions.nextPage,
      shortcutDefinitions.previousChapter,
      shortcutDefinitions.nextChapter,
      shortcutDefinitions.returnPrevious,
      shortcutDefinitions.returnStart,
      shortcutDefinitions.dismissReturn,
    ],
  },
  {
    titleKey: 'settings.shortcuts.group.search',
    items: [
      shortcutDefinitions.chapterFind,
      shortcutDefinitions.nextFindResult,
      shortcutDefinitions.previousFindResult,
    ],
  },
  {
    titleKey: 'settings.shortcuts.group.selection_menu',
    items: [
      shortcutDefinitions.selectionCopy,
      shortcutDefinitions.selectionSearch,
      shortcutDefinitions.selectionDictionary,
      shortcutDefinitions.selectionTranslate,
      shortcutDefinitions.selectionEditText,
      shortcutDefinitions.selectionAnnotate,
      shortcutDefinitions.selectionDefinitionToggle,
    ],
  },
  {
    titleKey: 'settings.shortcuts.group.tabs',
    items: [
      shortcutDefinitions.closeTab,
      shortcutDefinitions.closeAllTabs,
      shortcutDefinitions.switchTabIndex,
      shortcutDefinitions.switchLastTab,
      shortcutDefinitions.switchPreviousTab,
      shortcutDefinitions.switchNextTab,
      shortcutDefinitions.moveTabLeft,
      shortcutDefinitions.moveTabRight,
    ],
  },
  {
    titleKey: 'settings.shortcuts.group.display',
    items: [
      shortcutDefinitions.increaseFontSize,
      shortcutDefinitions.decreaseFontSize,
      shortcutDefinitions.resetFontSize,
      shortcutDefinitions.fullscreen,
      shortcutDefinitions.zenMode,
    ],
  },
  {
    titleKey: 'settings.shortcuts.group.panels',
    items: [
      shortcutDefinitions.tocPanel,
      shortcutDefinitions.searchPanel,
      shortcutDefinitions.annotationPanel,
      shortcutDefinitions.imagePanel,
      shortcutDefinitions.typographyPanel,
      shortcutDefinitions.libraryReaderToggle,
      shortcutDefinitions.openSettings,
    ],
  },
  {
    titleKey: 'settings.shortcuts.group.library',
    items: [
      shortcutDefinitions.libraryImport,
      shortcutDefinitions.libraryImportFolder,
      shortcutDefinitions.librarySelectAll,
      shortcutDefinitions.libraryTitleSearch,
      shortcutDefinitions.libraryAuthorSearch,
      shortcutDefinitions.libraryTagSearch,
      shortcutDefinitions.libraryBatchTags,
      shortcutDefinitions.libraryDeleteSelection,
      shortcutDefinitions.libraryFilterPanel,
      shortcutDefinitions.libraryFilterClear,
      shortcutDefinitions.libraryFilterAll,
      shortcutDefinitions.libraryFilterToRead,
      shortcutDefinitions.libraryFilterReading,
      shortcutDefinitions.libraryFilterRead,
    ],
  },
]

export interface ShortcutGroup {
  title: string
  items: ShortcutItem[]
}

export interface ShortcutItem {
  label: string
  shortcuts: ShortcutChordValue[]
}

function isMacPlatform() {
  if (typeof navigator === 'undefined') return false

  const userAgentPlatform = (
    navigator as Navigator & {
      userAgentData?: {
        platform?: string
      }
    }
  ).userAgentData?.platform

  if (userAgentPlatform) return userAgentPlatform.toLowerCase() === 'macos'

  return /^mac/i.test(navigator.platform) && !(navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
}

export function resolveShortcutChord(shortcut: ShortcutChordValue): ShortcutChordValue {
  const macPlatform = isMacPlatform()
  const commandKey = macPlatform ? '⌘' : 'Ctrl'

  return shortcut.map((key) => {
    if (key === commandToken) return commandKey
    if (macPlatform && key === 'Shift') return '⇧'
    return key
  })
}

export function getShortcutChords(id: ShortcutActionId) {
  return shortcutDefinitions[id].shortcuts.map(resolveShortcutChord)
}

export function createShortcutGroups(t: (key: string) => string): ShortcutGroup[] {
  return shortcutGroups.map((group) => ({
    title: t(group.titleKey),
    items: group.items.map((item) => ({
      label: item.labelKeys ? item.labelKeys.map(t).join(' / ') : t(item.labelKey),
      shortcuts: item.shortcuts.map(resolveShortcutChord),
    })),
  }))
}
