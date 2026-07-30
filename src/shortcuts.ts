export type ShortcutChordValue = string[]

export type ShortcutActionId =
  | 'annotationPanel'
  | 'chapterFind'
  | 'closeAllTabs'
  | 'closeTab'
  | 'developerTools'
  | 'dismissReturn'
  | 'fullscreen'
  | 'imagePanel'
  | 'increaseFontSize'
  | 'libraryBatchTags'
  | 'libraryDeleteSelection'
  | 'libraryFilterAll'
  | 'libraryFilterClear'
  | 'libraryFilterPanel'
  | 'libraryFilterRead'
  | 'libraryFilterReading'
  | 'libraryFilterToRead'
  | 'libraryImport'
  | 'libraryReaderToggle'
  | 'librarySelectAll'
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
  | 'switchNextTab'
  | 'switchPreviousTab'
  | 'switchLastTab'
  | 'switchTabIndex'
  | 'tocPanel'
  | 'typographyPanel'
  | 'decreaseFontSize'
  | 'zenMode'

interface ShortcutDefinition {
  labelKey: string
  shortcuts: ShortcutChordValue[]
}

interface ShortcutGroupDefinition {
  titleKey: string
  items: ShortcutDefinition[]
}

const commandToken = 'Mod'

const shortcutDefinitions: Record<ShortcutActionId, ShortcutDefinition> = {
  previousPage: {
    labelKey: 'previous_page',
    shortcuts: [['←'], ['↑'], ['Shift', 'Space']],
  },
  nextPage: {
    labelKey: 'next_page',
    shortcuts: [['→'], ['↓'], ['Space']],
  },
  previousChapter: {
    labelKey: 'previous_chapter',
    shortcuts: [['[']],
  },
  nextChapter: {
    labelKey: 'next_chapter',
    shortcuts: [[']']],
  },
  returnPrevious: {
    labelKey: 'return_previous',
    shortcuts: [['B']],
  },
  returnStart: {
    labelKey: 'return_start',
    shortcuts: [['R']],
  },
  dismissReturn: {
    labelKey: 'dismiss_return',
    shortcuts: [['Q']],
  },
  chapterFind: {
    labelKey: 'chapter_find',
    shortcuts: [[commandToken, 'F']],
  },
  nextFindResult: {
    labelKey: 'next_find_result',
    shortcuts: [['Enter']],
  },
  previousFindResult: {
    labelKey: 'previous_find_result',
    shortcuts: [['Shift', 'Enter']],
  },
  closeTab: {
    labelKey: 'close_tab',
    shortcuts: [[commandToken, 'W']],
  },
  closeAllTabs: {
    labelKey: 'close_all_tabs',
    shortcuts: [[commandToken, 'Shift', 'W']],
  },
  switchTabIndex: {
    labelKey: 'switch_tab_index',
    shortcuts: [[commandToken, '1-8']],
  },
  switchLastTab: {
    labelKey: 'switch_last_tab',
    shortcuts: [[commandToken, '9']],
  },
  switchPreviousTab: {
    labelKey: 'switch_previous_tab',
    shortcuts: [[commandToken, '←']],
  },
  switchNextTab: {
    labelKey: 'switch_next_tab',
    shortcuts: [[commandToken, '→']],
  },
  moveTabLeft: {
    labelKey: 'move_tab_left',
    shortcuts: [[commandToken, 'Shift', '←']],
  },
  moveTabRight: {
    labelKey: 'move_tab_right',
    shortcuts: [[commandToken, 'Shift', '→']],
  },
  increaseFontSize: {
    labelKey: 'increase_font_size',
    shortcuts: [[commandToken, '+']],
  },
  decreaseFontSize: {
    labelKey: 'decrease_font_size',
    shortcuts: [[commandToken, '-']],
  },
  resetFontSize: {
    labelKey: 'reset_font_size',
    shortcuts: [[commandToken, '0']],
  },
  fullscreen: {
    labelKey: 'fullscreen',
    shortcuts: [['F']],
  },
  zenMode: {
    labelKey: 'zen_mode',
    shortcuts: [['Z']],
  },
  tocPanel: {
    labelKey: 'toc_panel',
    shortcuts: [['T']],
  },
  searchPanel: {
    labelKey: 'search_panel',
    shortcuts: [['S']],
  },
  annotationPanel: {
    labelKey: 'annotation_panel',
    shortcuts: [['A']],
  },
  imagePanel: {
    labelKey: 'image_panel',
    shortcuts: [['G']],
  },
  typographyPanel: {
    labelKey: 'typography_panel',
    shortcuts: [['V']],
  },
  libraryReaderToggle: {
    labelKey: 'library_reader_toggle',
    shortcuts: [['C']],
  },
  libraryBatchTags: {
    labelKey: 'library_batch_tags',
    shortcuts: [['T']],
  },
  libraryDeleteSelection: {
    labelKey: 'library_delete_selection',
    shortcuts: [['Del']],
  },
  openSettings: {
    labelKey: 'open_settings',
    shortcuts: [[commandToken, ',']],
  },
  libraryFilterPanel: {
    labelKey: 'library_filter_panel',
    shortcuts: [['S']],
  },
  libraryFilterClear: {
    labelKey: 'library_filter_clear',
    shortcuts: [['Esc']],
  },
  libraryFilterAll: {
    labelKey: 'library_filter_all',
    shortcuts: [['`'], ['0']],
  },
  libraryFilterToRead: {
    labelKey: 'library_filter_to_read',
    shortcuts: [['1']],
  },
  libraryFilterReading: {
    labelKey: 'library_filter_reading',
    shortcuts: [['2']],
  },
  libraryFilterRead: {
    labelKey: 'library_filter_read',
    shortcuts: [['3']],
  },
  libraryImport: {
    labelKey: 'library_import',
    shortcuts: [[commandToken, 'O']],
  },
  librarySelectAll: {
    labelKey: 'library_select_all',
    shortcuts: [[commandToken, 'A']],
  },
  developerTools: {
    labelKey: 'developer_tools',
    shortcuts: [[commandToken, 'Shift', 'I']],
  },
}

const shortcutGroups: ShortcutGroupDefinition[] = [
  {
    titleKey: 'group.navigation',
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
    titleKey: 'group.search',
    items: [
      shortcutDefinitions.chapterFind,
      shortcutDefinitions.nextFindResult,
      shortcutDefinitions.previousFindResult,
    ],
  },
  {
    titleKey: 'group.tabs',
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
    titleKey: 'group.display',
    items: [
      shortcutDefinitions.increaseFontSize,
      shortcutDefinitions.decreaseFontSize,
      shortcutDefinitions.resetFontSize,
      shortcutDefinitions.fullscreen,
      shortcutDefinitions.zenMode,
    ],
  },
  {
    titleKey: 'group.panels',
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
    titleKey: 'group.library',
    items: [
      shortcutDefinitions.libraryImport,
      shortcutDefinitions.librarySelectAll,
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

export function getCommandKeyLabel() {
  if (typeof navigator === 'undefined') return 'Ctrl'

  const platform =
    (
      navigator as Navigator & {
        userAgentData?: {
          platform?: string
        }
      }
    ).userAgentData?.platform ??
    navigator.platform ??
    ''

  return /mac|iphone|ipad|ipod/i.test(platform) ? 'Cmd' : 'Ctrl'
}

export function resolveShortcutChord(shortcut: ShortcutChordValue): ShortcutChordValue {
  const commandKey = getCommandKeyLabel()

  return shortcut.map((key) => (key === commandToken ? commandKey : key))
}

export function getShortcutChords(id: ShortcutActionId) {
  return shortcutDefinitions[id].shortcuts.map(resolveShortcutChord)
}

export function createShortcutGroups(t: (key: string) => string): ShortcutGroup[] {
  return shortcutGroups.map((group) => ({
    title: t(group.titleKey),
    items: group.items.map((item) => ({
      label: t(item.labelKey),
      shortcuts: item.shortcuts.map(resolveShortcutChord),
    })),
  }))
}
