import clsx from 'clsx'
import type { ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

import { RenditionSpread } from '@flow/epubjs/types/rendition'
import { useSourceColor } from '@flow/reader/hooks/theme/useSourceColor'
import { useLocale } from '@flow/reader/hooks/useLocale'
import { useTranslation } from '@flow/reader/hooks/useTranslation'
import { AppLocale, localeNames } from '@flow/reader/locales'
import { defaultTextImportRules, useSettings } from '@flow/reader/state'

import { ColorPickerPopover, normalizeHexColor } from '../ColorPickerPopover'
import { Checkbox, Select } from '../Form'
import { Overlay } from '../base/Overlay'

interface SettingsDialogProps {
  open: boolean
  onClose: () => void
}

export const SettingsDialog: React.FC<SettingsDialogProps> = ({
  open,
  onClose,
}) => {
  useEffect(() => {
    if (!open) return

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return

      e.preventDefault()
      onClose()
    }

    const targets = [window, ...getIframeWindows()]
    targets.forEach((target) => target.addEventListener('keydown', onKeyDown))
    return () => {
      targets.forEach((target) =>
        target.removeEventListener('keydown', onKeyDown),
      )
    }
  }, [onClose, open])

  if (!open) return null

  return createPortal(
    <>
      <Overlay className="z-[80] !bg-black/20" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        data-flow-keyboard-capture="true"
        className="text-muted-foreground ring-border bg-background fixed top-1/2 left-1/2 z-[90] h-[min(38rem,calc(100vh-4rem))] w-[min(48rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-md shadow-lg ring-1 ring-inset"
      >
        <Settings />
      </div>
    </>,
    document.body,
  )
}

type SettingsTab = 'basic' | 'reading' | 'txt' | 'shortcuts'

export const Settings: React.FC = () => {
  const { locale, locales, setLocale } = useLocale()
  const [settings, setSettings] = useSettings()
  const t = useTranslation('settings')
  const typographyT = useTranslation('typography')
  const [activeTab, setActiveTab] = useState<SettingsTab>('basic')
  const tabs: SettingsTab[] = ['basic', 'reading', 'txt', 'shortcuts']
  const textImportRules = {
    ...defaultTextImportRules,
    ...settings.textImportRules,
  }
  const updateTextImportRules = (
    patch: Partial<typeof defaultTextImportRules>,
  ) => {
    setSettings((prev) => ({
      ...prev,
      textImportRules: {
        ...defaultTextImportRules,
        ...prev.textImportRules,
        ...patch,
      },
    }))
  }

  return (
    <div className="flex h-full min-h-0">
      <aside className="border-border bg-muted/50 w-40 shrink-0 border-r p-2">
        <h1 className="text-muted-foreground px-3 py-3 text-base font-semibold">
          {t('title')}
        </h1>
        <nav className="mt-1 space-y-1">
          {tabs.map((tab) => {
            const selected = activeTab === tab
            return (
              <button
                key={tab}
                type="button"
                className={clsx(
                  'flex h-9 w-full items-center rounded-sm px-3 text-left text-sm',
                  selected
                    ? 'text-primary-foreground bg-primary'
                    : 'text-muted-foreground hover:bg-muted',
                )}
                onClick={() => setActiveTab(tab)}
              >
                {t(`tabs.${tab}`)}
              </button>
            )
          })}
        </nav>
      </aside>
      <section className="scroll min-w-0 flex-1 overflow-y-auto px-5 py-4">
        <h2 className="text-muted-foreground text-base font-semibold">
          {t(`tabs.${activeTab}`)}
        </h2>
        <div className="mt-5 space-y-5">
          {activeTab === 'basic' && (
            <>
              <Item title={t('language')}>
                <Select
                  value={locale}
                  onChange={(e) => {
                    setLocale(e.target.value as AppLocale)
                  }}
                >
                  {locales?.map((loc) => (
                    <option key={loc} value={loc}>
                      {localeNames[loc] || loc}
                    </option>
                  ))}
                </Select>
              </Item>
              <SourceColorSetting />
            </>
          )}
          {activeTab === 'reading' && (
            <>
              <Item title={t('default_page_view')}>
                <SegmentedField
                  value={settings.spread ?? RenditionSpread.Auto}
                  options={[
                    {
                      label: typographyT('page_view.single_page'),
                      value: RenditionSpread.None,
                    },
                    {
                      label: typographyT('page_view.double_page'),
                      value: RenditionSpread.Auto,
                    },
                  ]}
                  onChange={(spread) => {
                    setSettings((prev) => ({
                      ...prev,
                      spread,
                    }))
                  }}
                />
              </Item>
              <Item title={t('default_text_align')}>
                <SegmentedField
                  value={settings.textAlign ?? 'default'}
                  options={[
                    {
                      label: typographyT('text_align.default'),
                      value: 'default',
                    },
                    {
                      label: typographyT('text_align.justify'),
                      value: 'justify',
                    },
                  ]}
                  onChange={(textAlign) => {
                    setSettings((prev) => ({
                      ...prev,
                      textAlign,
                    }))
                  }}
                />
              </Item>
              <Item title={t('restore_last_reading')}>
                <Checkbox
                  name={t('restore_last_reading.enable')}
                  checked={settings.restoreLastReadingOnStartup === true}
                  onChange={(e) => {
                    setSettings({
                      ...settings,
                      restoreLastReadingOnStartup: e.target.checked,
                    })
                  }}
                />
              </Item>
              <Item title={t('text_selection_menu')}>
                <Checkbox
                  name={t('text_selection_menu.enable')}
                  checked={settings.enableTextSelectionMenu !== false}
                  onChange={(e) => {
                    setSettings({
                      ...settings,
                      enableTextSelectionMenu: e.target.checked,
                    })
                  }}
                />
              </Item>
              <Item title={t('hide_endnotes')}>
                <Checkbox
                  name={t('hide_endnotes.enable')}
                  checked={settings.hideEndnotes === true}
                  onChange={(e) => {
                    setSettings({
                      ...settings,
                      hideEndnotes: e.target.checked,
                    })
                  }}
                />
              </Item>
            </>
          )}
          {activeTab === 'txt' && (
            <>
              <Item title={t('txt_import.group_rules')}>
                <PatternTextarea
                  value={textImportRules.groupPatterns}
                  onChange={(patterns) =>
                    updateTextImportRules({ groupPatterns: patterns })
                  }
                />
              </Item>
              <Item title={t('txt_import.chapter_rules')}>
                <PatternTextarea
                  value={textImportRules.chapterPatterns}
                  onChange={(patterns) =>
                    updateTextImportRules({ chapterPatterns: patterns })
                  }
                />
              </Item>
              <div className="flex justify-end">
                <button
                  type="button"
                  className="text-muted-foreground hover:bg-muted hover:text-muted-foreground h-8 rounded-sm px-3 text-sm"
                  onClick={() => {
                    setSettings((prev) => ({
                      ...prev,
                      textImportRules: defaultTextImportRules,
                    }))
                  }}
                >
                  {t('txt_import.restore_defaults')}
                </button>
              </div>
            </>
          )}
          {activeTab === 'shortcuts' && <ShortcutSettings />}
        </div>
      </section>
    </div>
  )
}

interface PatternTextareaProps {
  value: string[]
  onChange: (value: string[]) => void
}

const PatternTextarea: React.FC<PatternTextareaProps> = ({
  value,
  onChange,
}) => {
  return (
    <textarea
      className="scroll text-muted-foreground ring-border focus:ring-ring bg-background min-h-28 w-full resize-y px-2 py-1 font-mono !text-[12px] leading-5 ring-1 outline-none ring-inset"
      value={value.join('\n')}
      spellCheck={false}
      onChange={(event) => {
        onChange(
          event.target.value
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean),
        )
      }}
    />
  )
}

interface SegmentedFieldOption<T extends string> {
  label: string
  value: T
}

interface SegmentedFieldProps<T extends string> {
  value: T
  options: SegmentedFieldOption<T>[]
  onChange: (value: T) => void
}

function SegmentedField<T extends string>({
  value,
  options,
  onChange,
}: SegmentedFieldProps<T>) {
  return (
    <div className="text-muted-foreground ring-border bg-background flex h-8 items-center p-0.5 ring-1 ring-inset">
      {options.map((option) => {
        const selected = option.value === value

        return (
          <button
            key={option.value}
            type="button"
            className={clsx(
              'hover:bg-muted h-full flex-1 px-2 text-sm !text-[13px]',
              selected && 'text-primary-foreground bg-primary',
            )}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

const SourceColorSetting: React.FC = () => {
  const { sourceColor, setSourceColor } = useSourceColor()
  const [open, setOpen] = useState(false)
  const [displayColor, setDisplayColor] = useState(sourceColor)
  const t = useTranslation('theme')

  const color = normalizeHexColor(displayColor) ?? sourceColor

  return (
    <Item title={t('source_color')}>
      <div className="relative inline-block">
        <button
          type="button"
          className="text-muted-foreground ring-border bg-background flex h-8 min-w-[9rem] items-center gap-2 px-2 text-left ring-1 ring-inset"
          onClick={() => {
            setDisplayColor(sourceColor)
            setOpen(true)
          }}
        >
          <span
            className="ring-border h-5 w-8 shrink-0 rounded-sm ring-1 ring-inset"
            style={{ backgroundColor: color }}
          />
          <span className="font-mono !text-[13px]">{color}</span>
        </button>
        {open && (
          <ColorPickerPopover
            className="absolute top-full left-0 z-20 mt-2"
            value={sourceColor}
            defaultValue="#0ea5e9"
            onPreview={(next) => {
              setDisplayColor(next)
              setSourceColor(next)
            }}
            onApply={(next) => {
              setSourceColor(next)
              setDisplayColor(next)
              setOpen(false)
            }}
            onCancel={() => {
              setOpen(false)
            }}
          />
        )}
      </div>
    </Item>
  )
}

function getIframeWindows() {
  return Array.from(document.querySelectorAll('iframe')).flatMap((frame) => {
    try {
      return frame.contentWindow ? [frame.contentWindow] : []
    } catch {
      return []
    }
  })
}

interface PartProps {
  children?: ReactNode
  title: string
}
const Item: React.FC<PartProps> = ({ title, children }) => {
  return (
    <div className="grid grid-cols-[8.5rem_minmax(0,1fr)] items-center gap-2">
      <h3 className="text-muted-foreground text-sm font-semibold">{title}</h3>
      <div className="min-w-0">{children}</div>
    </div>
  )
}

interface ShortcutGroup {
  title: string
  items: ShortcutItem[]
}

interface ShortcutItem {
  label: string
  shortcuts: ShortcutChordValue[]
}

type ShortcutChordValue = string[]

const ShortcutSettings: React.FC = () => {
  const t = useTranslation('shortcuts')
  const commandKey = getCommandKeyLabel()
  const groups: ShortcutGroup[] = [
    {
      title: t('group.navigation'),
      items: [
        {
          label: t('previous_page'),
          shortcuts: [['←'], ['↑'], ['Shift', 'Space']],
        },
        {
          label: t('next_page'),
          shortcuts: [['→'], ['↓'], ['Space']],
        },
        {
          label: t('previous_chapter'),
          shortcuts: [['[']],
        },
        {
          label: t('next_chapter'),
          shortcuts: [[']']],
        },
        {
          label: t('return_previous'),
          shortcuts: [['B']],
        },
        {
          label: t('return_start'),
          shortcuts: [['R']],
        },
        {
          label: t('dismiss_return'),
          shortcuts: [['S']],
        },
      ],
    },
    {
      title: t('group.search'),
      items: [
        {
          label: t('chapter_find'),
          shortcuts: [[commandKey, 'F']],
        },
        {
          label: t('next_find_result'),
          shortcuts: [['Enter']],
        },
        {
          label: t('previous_find_result'),
          shortcuts: [['Shift', 'Enter']],
        },
      ],
    },
    {
      title: t('group.tabs'),
      items: [
        {
          label: t('close_tab'),
          shortcuts: [[commandKey, 'W']],
        },
        {
          label: t('close_all_tabs'),
          shortcuts: [['Shift', commandKey, 'W']],
        },
        {
          label: t('switch_tab_index'),
          shortcuts: [[commandKey, '1-8']],
        },
        {
          label: t('switch_last_tab'),
          shortcuts: [[commandKey, '9']],
        },
        {
          label: t('switch_adjacent_tab'),
          shortcuts: [
            [commandKey, '←'],
            [commandKey, '→'],
          ],
        },
      ],
    },
    {
      title: t('group.display'),
      items: [
        {
          label: t('increase_font_size'),
          shortcuts: [[commandKey, '+']],
        },
        {
          label: t('decrease_font_size'),
          shortcuts: [[commandKey, '-']],
        },
        {
          label: t('reset_font_size'),
          shortcuts: [[commandKey, '0']],
        },
        {
          label: t('fullscreen'),
          shortcuts: [['F']],
        },
        {
          label: t('zen_mode'),
          shortcuts: [['Z']],
        },
      ],
    },
    {
      title: t('group.panels'),
      items: [
        {
          label: t('toc_panel'),
          shortcuts: [['T']],
        },
        {
          label: t('search_panel'),
          shortcuts: [['/']],
        },
        {
          label: t('annotation_panel'),
          shortcuts: [['A']],
        },
        {
          label: t('image_panel'),
          shortcuts: [['I']],
        },
        {
          label: t('typography_panel'),
          shortcuts: [['P']],
        },
        {
          label: t('library_reader_toggle'),
          shortcuts: [['L']],
        },
        {
          label: t('open_settings'),
          shortcuts: [[commandKey, ',']],
        },
      ],
    },
    {
      title: t('group.library'),
      items: [
        {
          label: t('library_filter_panel'),
          shortcuts: [['S']],
        },
        {
          label: t('library_filter_all'),
          shortcuts: [['1']],
        },
        {
          label: t('library_filter_to_read'),
          shortcuts: [['2']],
        },
        {
          label: t('library_filter_reading'),
          shortcuts: [['3']],
        },
        {
          label: t('library_filter_read'),
          shortcuts: [['4']],
        },
      ],
    },
    {
      title: t('group.development'),
      items: [
        {
          label: t('developer_tools'),
          shortcuts: [[commandKey, 'Shift', 'I']],
        },
      ],
    },
  ]

  return (
    <div className="space-y-5">
      {groups.map((group) => (
        <section key={group.title}>
          <h3 className="text-muted-foreground mb-2 text-sm font-semibold">
            {group.title}
          </h3>
          <div className="divide-border divide-y">
            {group.items.map((item) => (
              <div
                key={item.label}
                className="flex min-h-9 items-center justify-between gap-4 py-1.5"
              >
                <span className="text-muted-foreground min-w-0 text-sm">
                  {item.label}
                </span>
                <div className="flex shrink-0 flex-wrap justify-end gap-1">
                  {item.shortcuts.map((shortcut) => (
                    <ShortcutChord
                      key={shortcut.join('+')}
                      shortcut={shortcut}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

const ShortcutChord: React.FC<{ shortcut: ShortcutChordValue }> = ({
  shortcut,
}) => {
  return (
    <span className="inline-flex items-center gap-1">
      {shortcut.map((key, index) => (
        <span className="inline-flex items-center gap-1" key={index}>
          {index > 0 && (
            <span className="text-muted-foreground text-xs">+</span>
          )}
          <kbd className="bg-muted text-muted-foreground ring-border min-w-[1.55rem] rounded-sm px-1.5 py-0.5 text-center font-mono !text-[12px] leading-5 ring-1 ring-inset">
            {key}
          </kbd>
        </span>
      ))}
    </span>
  )
}

function getCommandKeyLabel() {
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

Settings.displayName = 'settings'
