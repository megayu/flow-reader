import { Overlay } from '@literal-ui/core'
import clsx from 'clsx'
import type { ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

import { RenditionSpread } from '@flow/epubjs/types/rendition'
import { useLocale, useSourceColor, useTranslation } from '@flow/reader/hooks'
import { AppLocale, localeNames } from '@flow/reader/locales'
import { useSettings } from '@flow/reader/state'

import { ColorPickerPopover, normalizeHexColor } from '../ColorPickerPopover'
import { Checkbox, Select } from '../Form'

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
        className="bg-default fixed left-1/2 top-1/2 z-[90] h-[min(38rem,calc(100vh-4rem))] w-[min(48rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-md text-on-surface-variant shadow-lg ring-1 ring-inset ring-on-surface-variant/20"
      >
        <Settings />
      </div>
    </>,
    document.body,
  )
}

type SettingsTab = 'basic' | 'reading' | 'shortcuts'

export const Settings: React.FC = () => {
  const { locale, locales, setLocale } = useLocale()
  const [settings, setSettings] = useSettings()
  const t = useTranslation('settings')
  const typographyT = useTranslation('typography')
  const [activeTab, setActiveTab] = useState<SettingsTab>('basic')
  const tabs: SettingsTab[] = ['basic', 'reading', 'shortcuts']

  return (
    <div className="flex h-full min-h-0">
      <aside className="border-on-surface-variant/15 w-40 shrink-0 border-r bg-on-surface-variant/[0.04] p-2">
        <h1 className="px-3 py-3 text-on-surface-variant typescale-title-medium">
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
                  'flex h-9 w-full items-center rounded-sm px-3 text-left typescale-body-medium',
                  selected
                    ? 'bg-primary70 text-on-primary-container'
                    : 'text-on-surface-variant hover:bg-on-surface-variant/10',
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
        <h2 className="text-on-surface-variant typescale-title-medium">
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
          {activeTab === 'shortcuts' && <ShortcutSettings />}
        </div>
      </section>
    </div>
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
    <div className="bg-default flex h-8 items-center p-0.5 text-on-surface-variant ring-1 ring-inset ring-surface-variant">
      {options.map((option) => {
        const selected = option.value === value

        return (
          <button
            key={option.value}
            type="button"
            className={clsx(
              'h-full flex-1 px-2 !text-[13px] typescale-body-medium hover:bg-on-surface-variant/10',
              selected && 'bg-primary70 text-on-primary-container',
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
          className="bg-default flex h-8 min-w-[9rem] items-center gap-2 px-2 text-left text-on-surface-variant ring-1 ring-inset ring-surface-variant"
          onClick={() => {
            setDisplayColor(sourceColor)
            setOpen(true)
          }}
        >
          <span
            className="h-5 w-8 shrink-0 rounded-sm ring-1 ring-inset ring-on-surface-variant/30"
            style={{ backgroundColor: color }}
          />
          <span className="font-mono !text-[13px]">{color}</span>
        </button>
        {open && (
          <ColorPickerPopover
            className="absolute left-0 top-full z-20 mt-2"
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
    <div className="grid gap-2 sm:grid-cols-[8.5rem_minmax(0,1fr)] sm:items-center">
      <h3 className="text-on-surface-variant typescale-title-small">{title}</h3>
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
          <h3 className="mb-2 text-on-surface-variant typescale-title-small">
            {group.title}
          </h3>
          <div className="divide-y divide-on-surface-variant/10">
            {group.items.map((item) => (
              <div
                key={item.label}
                className="min-h-9 flex items-center justify-between gap-4 py-1.5"
              >
                <span className="min-w-0 text-on-surface-variant typescale-body-medium">
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
            <span className="text-outline typescale-body-small">+</span>
          )}
          <kbd className="bg-on-surface-variant/8 min-w-[1.55rem] rounded-sm px-1.5 py-0.5 text-center font-mono !text-[12px] leading-5 text-on-surface-variant ring-1 ring-inset ring-on-surface-variant/20">
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
