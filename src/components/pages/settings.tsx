import clsx from 'clsx'
import type { CSSProperties, ReactNode } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { RenditionSpread } from '@flow/epubjs/types/rendition'
import { useAccentColor } from '@flow/reader/hooks/theme/useSourceColor'
import { useLocale } from '@flow/reader/hooks/useLocale'
import { useTranslation } from '@flow/reader/hooks/useTranslation'
import { AppLocale, localeNames } from '@flow/reader/locales'
import { createShortcutGroups } from '@flow/reader/shortcuts'
import { defaultTextImportRules, useSettings } from '@flow/reader/state'
import {
  maxUiFontSize,
  minUiFontSize,
  normalizeUiFontSize,
} from '@flow/reader/styles/ui'

import { ColorPickerPopover, normalizeHexColor } from '../ColorPickerPopover'
import { ShortcutChord } from '../ShortcutChord'
import { Button as UiButton } from '../ui/button'
import { Checkbox as UiCheckbox } from '../ui/checkbox'
import { Dialog, DialogContent, DialogTitle } from '../ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select'
import { Textarea } from '../ui/textarea'

interface SettingsDialogProps {
  open: boolean
  onClose: () => void
}

export const SettingsDialog: React.FC<SettingsDialogProps> = ({
  open,
  onClose,
}) => {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        data-flow-keyboard-capture="true"
        className="h-[min(38rem,calc(100vh-4rem))] w-[min(56rem,calc(100vw-2rem))] max-w-none overflow-hidden rounded-lg p-0"
      >
        <Settings />
      </DialogContent>
    </Dialog>
  )
}

type SettingsTab = 'basic' | 'reading' | 'txt' | 'shortcuts'
const SETTINGS_TABS: SettingsTab[] = ['basic', 'reading', 'txt', 'shortcuts']
const TEXTAREA_SIZE_STYLE = {
  fieldSizing: 'fixed',
  maxHeight: '22rem',
  minHeight: '8.5rem',
} satisfies CSSProperties

export const Settings: React.FC = () => {
  const { locale, locales, setLocale } = useLocale()
  const [settings, setSettings] = useSettings()
  const t = useTranslation('settings')
  const typographyT = useTranslation('typography')
  const [activeTab, setActiveTab] = useState<SettingsTab>('basic')
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
    <div className="flex h-full min-h-0 flex-row gap-0">
      <aside className="border-border w-40 shrink-0 border-r bg-[var(--flow-bg-sidebar)] p-2">
        <DialogTitle className="text-muted-foreground px-3 py-3 text-lg font-semibold">
          {t('title')}
        </DialogTitle>
        <div className="mt-1 flex h-auto w-full flex-col items-stretch gap-1 rounded-none bg-transparent p-0">
          {SETTINGS_TABS.map((tab) => {
            const active = tab === activeTab
            return (
              <button
                type="button"
                key={tab}
                data-flow-settings-tab
                className={clsx(
                  'text-muted-foreground h-9 cursor-pointer rounded-sm px-3 text-left transition-colors',
                  active
                    ? 'bg-[var(--flow-accent-bg)] text-[var(--flow-text)] ring-1 ring-[var(--flow-accent-border)] ring-inset'
                    : 'hover:bg-[var(--flow-bg-control-hover)]',
                )}
                style={{ fontSize: 'var(--app-font-size-md)' }}
                onClick={() => setActiveTab(tab)}
              >
                {t(`tabs.${tab}`)}
              </button>
            )
          })}
        </div>
      </aside>
      <section className="scroll min-w-0 flex-1 overflow-y-auto px-5 py-4">
        <h2 className="text-muted-foreground text-lg font-semibold">
          {t(`tabs.${activeTab}`)}
        </h2>
        <div className="mt-5 space-y-5">
          {activeTab === 'basic' && (
            <div data-flow-settings-panel className="m-0 space-y-5">
              <Item title={t('language')}>
                <Select
                  value={locale}
                  onValueChange={(value) => setLocale(value as AppLocale)}
                >
                  <SelectTrigger
                    aria-label={t('language')}
                    className="h-8 w-44 rounded-lg"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {locales?.map((loc) => (
                      <SelectItem key={loc} value={loc}>
                        {localeNames[loc] || loc}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Item>
              <AccentColorSetting />
              <UiFontSizeSetting />
            </div>
          )}
          {activeTab === 'reading' && (
            <div data-flow-settings-panel className="m-0 space-y-5">
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
                <SettingsCheckbox
                  label={t('restore_last_reading.enable')}
                  checked={settings.restoreLastReadingOnStartup === true}
                  onCheckedChange={(checked) => {
                    setSettings({
                      ...settings,
                      restoreLastReadingOnStartup: checked,
                    })
                  }}
                />
              </Item>
              <Item title={t('text_selection_menu')}>
                <SettingsCheckbox
                  label={t('text_selection_menu.enable')}
                  checked={settings.enableTextSelectionMenu !== false}
                  onCheckedChange={(checked) => {
                    setSettings({
                      ...settings,
                      enableTextSelectionMenu: checked,
                    })
                  }}
                />
              </Item>
              <Item title={t('hide_endnotes')}>
                <SettingsCheckbox
                  label={t('hide_endnotes.enable')}
                  checked={settings.hideEndnotes === true}
                  onCheckedChange={(checked) => {
                    setSettings({
                      ...settings,
                      hideEndnotes: checked,
                    })
                  }}
                />
              </Item>
            </div>
          )}
          {activeTab === 'txt' && (
            <div data-flow-settings-panel className="m-0 space-y-5">
              <Item title={t('txt_import.group_rules')}>
                <PatternTextarea
                  label={t('txt_import.group_rules')}
                  value={textImportRules.groupPatterns}
                  onChange={(patterns) =>
                    updateTextImportRules({ groupPatterns: patterns })
                  }
                />
              </Item>
              <Item title={t('txt_import.chapter_rules')}>
                <PatternTextarea
                  label={t('txt_import.chapter_rules')}
                  value={textImportRules.chapterPatterns}
                  onChange={(patterns) =>
                    updateTextImportRules({ chapterPatterns: patterns })
                  }
                />
              </Item>
              <div className="flex justify-end">
                <UiButton
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground hover:bg-muted hover:text-muted-foreground h-8 rounded-sm px-3 text-base"
                  onClick={() => {
                    setSettings((prev) => ({
                      ...prev,
                      textImportRules: defaultTextImportRules,
                    }))
                  }}
                >
                  {t('txt_import.restore_defaults')}
                </UiButton>
              </div>
            </div>
          )}
          {activeTab === 'shortcuts' && (
            <div data-flow-settings-panel className="m-0">
              <ShortcutSettings />
            </div>
          )}
        </div>
      </section>
    </div>
  )
}

interface PatternTextareaProps {
  label: string
  value: string[]
  onChange: (value: string[]) => void
}

const PatternTextarea: React.FC<PatternTextareaProps> = ({
  label,
  value,
  onChange,
}) => {
  const valueText = useMemo(() => value.join('\n'), [value])
  const [draft, setDraft] = useState(valueText)
  const focusedRef = useRef(false)
  const focusedValueRef = useRef(valueText)
  const onChangeRef = useRef(onChange)

  useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])

  useEffect(() => {
    if (!focusedRef.current) {
      setDraft(valueText)
      focusedValueRef.current = valueText
    }
  }, [valueText])

  return (
    <Textarea
      aria-label={label}
      className="scroll resize-y overflow-y-auto rounded-lg font-mono text-base leading-5"
      style={TEXTAREA_SIZE_STYLE}
      value={draft}
      spellCheck={false}
      onChange={(event) => {
        setDraft(event.target.value)
      }}
      onFocus={() => {
        focusedRef.current = true
        focusedValueRef.current = valueText
      }}
      onBlur={() => {
        focusedRef.current = false
        const patterns = parsePatternText(draft)
        const normalized = patterns.join('\n')
        setDraft(normalized)
        if (normalized !== focusedValueRef.current) {
          onChangeRef.current(patterns)
          focusedValueRef.current = normalized
        }
      }}
    />
  )
}

function parsePatternText(value: string) {
  const patterns: string[] = []
  for (const line of value.split(/\r?\n/)) {
    const pattern = line.trim()
    if (pattern) patterns.push(pattern)
  }
  return patterns
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
    <div className="text-muted-foreground ring-border flex h-8 items-center overflow-hidden rounded-lg bg-[var(--flow-bg-control)] p-0.5 ring-1 ring-inset">
      {options.map((option) => {
        const selected = option.value === value

        return (
          <UiButton
            key={option.value}
            type="button"
            variant={selected ? 'default' : 'ghost'}
            size="sm"
            className={clsx(
              'h-full flex-1 rounded-lg px-2 text-base leading-none',
              selected || 'text-muted-foreground',
            )}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </UiButton>
        )
      })}
    </div>
  )
}

const AccentColorSetting: React.FC = () => {
  const { accentColor, setAccentColor } = useAccentColor()
  const [open, setOpen] = useState(false)
  const [displayColor, setDisplayColor] = useState(accentColor)
  const t = useTranslation('theme')

  const color = normalizeHexColor(displayColor) ?? accentColor

  return (
    <Item title={t('source_color')}>
      <div className="relative inline-block">
        <button
          type="button"
          className="border-input text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 dark:bg-input/30 flex h-8 min-w-[9rem] items-center gap-2 rounded-lg border bg-transparent px-2.5 text-left text-base leading-none transition-colors outline-none focus-visible:ring-3"
          onClick={() => {
            setDisplayColor(accentColor)
            setOpen(true)
          }}
        >
          <span
            className="ring-border h-5 w-8 shrink-0 rounded-md ring-1 ring-inset"
            style={{ backgroundColor: color }}
          />
          <span className="font-mono text-base">{color}</span>
        </button>
        {open && (
          <ColorPickerPopover
            className="absolute top-full left-0 z-20 mt-2"
            value={accentColor}
            defaultValue="#0ea5e9"
            onPreview={(next) => {
              setDisplayColor(next)
              setAccentColor(next)
            }}
            onApply={(next) => {
              setAccentColor(next)
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

const UiFontSizeSetting: React.FC = () => {
  const [settings, setSettings] = useSettings()
  const t = useTranslation('settings')
  const uiFontSize = normalizeUiFontSize(settings.ui?.fontSize)
  const setUiFontSize = (next: number) => {
    setSettings((prev) => ({
      ...prev,
      ui: {
        ...prev.ui,
        fontSize: normalizeUiFontSize(next),
      },
    }))
  }

  return (
    <Item title={t('ui_font_size')}>
      <div className="border-input focus-within:border-ring focus-within:ring-ring/50 dark:bg-input/30 flex h-8 w-24 overflow-hidden rounded-lg border bg-transparent transition-colors focus-within:ring-3">
        <input
          type="text"
          aria-label={t('ui_font_size')}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          readOnly
          value={uiFontSize}
          className="text-muted-foreground min-w-0 flex-1 bg-transparent px-2.5 text-base leading-none outline-none"
          onFocus={(e) => e.currentTarget.select()}
        />
        <div className="border-input flex w-7 flex-col border-l">
          <button
            type="button"
            aria-label={`${t('ui_font_size')} +`}
            className="hover:bg-muted flex h-1/2 items-center justify-center text-[12px] leading-none disabled:opacity-35"
            disabled={uiFontSize >= maxUiFontSize}
            onClick={() => setUiFontSize(uiFontSize + 1)}
          >
            ▲
          </button>
          <button
            type="button"
            aria-label={`${t('ui_font_size')} -`}
            className="border-input hover:bg-muted flex h-1/2 items-center justify-center border-t text-[12px] leading-none disabled:opacity-35"
            disabled={uiFontSize <= minUiFontSize}
            onClick={() => setUiFontSize(uiFontSize - 1)}
          >
            ▼
          </button>
        </div>
      </div>
    </Item>
  )
}

interface SettingsCheckboxProps {
  checked: boolean
  label: string
  onCheckedChange: (checked: boolean) => void
}

const SettingsCheckbox: React.FC<SettingsCheckboxProps> = ({
  checked,
  label,
  onCheckedChange,
}) => {
  return (
    <label className="text-muted-foreground inline-flex items-center gap-2 text-base">
      <UiCheckbox
        checked={checked}
        onCheckedChange={(value) => onCheckedChange(value === true)}
      />
      <span>{label}</span>
    </label>
  )
}

interface PartProps {
  children?: ReactNode
  title: string
}
const Item: React.FC<PartProps> = ({ title, children }) => {
  return (
    <div className="grid grid-cols-[10rem_minmax(0,1fr)] items-center gap-2">
      <h3 className="text-muted-foreground text-base font-semibold">{title}</h3>
      <div className="min-w-0">{children}</div>
    </div>
  )
}

const ShortcutSettings: React.FC = () => {
  const t = useTranslation('shortcuts')
  const groups = createShortcutGroups(t)

  return (
    <div className="space-y-5">
      {groups.map((group) => (
        <section key={group.title}>
          <h3 className="text-muted-foreground mb-2 text-base font-semibold">
            {group.title}
          </h3>
          <div className="divide-border divide-y">
            {group.items.map((item) => (
              <div
                key={item.label}
                className="flex min-h-9 items-center justify-between gap-4 py-1.5"
              >
                <span className="text-muted-foreground min-w-0 text-base">
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

Settings.displayName = 'settings'
