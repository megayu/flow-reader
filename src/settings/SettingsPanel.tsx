import clsx from 'clsx'
import { ChevronDownIcon, ChevronUpIcon } from 'lucide-react'
import type { CSSProperties, ReactNode } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { RenditionSpread } from '@flow/epubjs/rendition'
import { normalizeHexColor } from '@/color'
import { ColorPickerPopover } from '@/components/ColorPickerPopover'
import { ColorValueButton } from '@/components/ColorValueButton'
import { ShortcutChord } from '@/components/ShortcutChord'
import { Button as UiButton } from '@/components/ui/button'
import { Checkbox as UiCheckbox } from '@/components/ui/checkbox'
import { DialogTitle } from '@/components/ui/dialog'
import { InputGroup, InputGroupInput } from '@/components/ui/input-group'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { SegmentedControl, SegmentedControlItem } from '@/components/ui/segmented-control'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { openSupportedExternalUrl } from '@/externalLink'
import { useAccentColor } from '@/hooks/theme/useSourceColor'
import { useLocale } from '@/hooks/useLocale'
import { formatTranslation, useTranslation } from '@/hooks/useTranslation'
import { type AppLocale, localeNames } from '@/locales'
import { createShortcutGroups } from '@/shortcuts'
import { defaultTextImportRules, normalizeTextImportRules, useSettings } from '@/state'
import { maxUiFontSize, minUiFontSize, normalizeUiFontSize } from '@/styles/ui'
import { orderedTargetLanguages, TRANSLATION_LANGUAGES, type TranslationLanguage } from '@/translation/languages'

import { BookCacheSetting } from './BookCacheSetting'
import { LocalDictionarySettings } from './LocalDictionarySettings'
import { SettingsItem as Item } from './SettingsItem'
import { TagSettings } from './TagSettings'

type SettingsTab = 'basic' | 'reading' | 'tags' | 'dictionary' | 'translation' | 'txt' | 'shortcuts'
const SETTINGS_TABS: SettingsTab[] = ['basic', 'reading', 'tags', 'dictionary', 'translation', 'txt', 'shortcuts']
const TEXTAREA_SIZE_STYLE = {
  fieldSizing: 'fixed',
  maxHeight: '22rem',
  minHeight: '8.5rem',
} satisfies CSSProperties
const REGEX_TESTER_URL = 'https://regex101.com/?flavor=rust'

export const SettingsPanel: React.FC = () => {
  const { locale, locales, setLocale } = useLocale()
  const [settings, setSettings] = useSettings()
  const t = useTranslation('settings')
  const typographyT = useTranslation('typography')
  const [activeTab, setActiveTab] = useState<SettingsTab>('basic')
  const textImportRules = normalizeTextImportRules(settings.textImportRules)
  const updateTextImportRules = (patch: Partial<typeof defaultTextImportRules>) => {
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
    <div className="flex h-full w-full max-w-full min-w-0 flex-row gap-0 overflow-hidden">
      <aside className="border-border w-40 min-w-40 shrink-0 overflow-hidden border-r bg-(--flow-bg-sidebar) p-2">
        <DialogTitle className="text-muted-foreground px-3 py-3 text-lg font-semibold">{t('title')}</DialogTitle>
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
                    ? 'bg-(--flow-accent-bg) text-(--flow-text) ring-1 ring-(--flow-accent-border) ring-inset'
                    : 'hover:bg-(--flow-bg-control-hover)',
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
      <section
        className={clsx(
          'w-0 min-w-0 flex-1 overflow-x-hidden px-5 py-4',
          activeTab === 'tags' ? 'flex flex-col overflow-y-hidden' : 'scroll overflow-y-auto',
        )}
      >
        <h2 className="text-muted-foreground text-lg font-semibold">{t(`tabs.${activeTab}`)}</h2>
        <div className={clsx('mt-5', activeTab === 'tags' ? 'min-h-0 flex-1' : 'space-y-5')}>
          {activeTab === 'basic' && (
            <div data-flow-settings-panel className="m-0 space-y-5">
              <Item title={t('language')}>
                <Select value={locale} onValueChange={(value) => setLocale(value as AppLocale)}>
                  <SelectTrigger aria-label={t('language')} className="h-8 w-44 rounded-lg">
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
              <Item
                title={t('source_storage')}
                description={t('source_storage.description')}
                controlId="settings-source-storage"
              >
                <SettingsCheckbox
                  id="settings-source-storage"
                  label={t('source_storage')}
                  checked={settings.importSourceStorage === 'referenced'}
                  onCheckedChange={(checked) => {
                    setSettings((prev) => ({
                      ...prev,
                      importSourceStorage: checked ? 'referenced' : 'managed',
                    }))
                  }}
                />
              </Item>
              <Item
                title={t('library_modified_indicator')}
                description={t('library_modified_indicator.description')}
                controlId="settings-library-export-reminder"
              >
                <SettingsCheckbox
                  id="settings-library-export-reminder"
                  label={t('library_modified_indicator')}
                  checked={settings.showModifiedBookExportIndicator === true}
                  onCheckedChange={(checked) => {
                    setSettings((prev) => ({
                      ...prev,
                      showModifiedBookExportIndicator: checked,
                    }))
                  }}
                />
              </Item>
              <BookCacheSetting />
            </div>
          )}
          {activeTab === 'reading' && (
            <div data-flow-settings-panel className="m-0 space-y-5">
              <Item title={t('default_page_view')} description={t('default_page_view.description')}>
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
              <Item title={t('default_text_align')} description={t('default_text_align.description')}>
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
              <Item
                title={t('restore_last_reading')}
                description={t('restore_last_reading.description')}
                controlId="settings-restore-last-reading"
              >
                <SettingsCheckbox
                  id="settings-restore-last-reading"
                  label={t('restore_last_reading')}
                  checked={settings.restoreLastReadingOnStartup === true}
                  onCheckedChange={(checked) => {
                    setSettings({
                      ...settings,
                      restoreLastReadingOnStartup: checked,
                    })
                  }}
                />
              </Item>
              <Item
                title={t('text_selection_menu')}
                description={t('text_selection_menu.description')}
                controlId="settings-text-selection-menu"
              >
                <SettingsCheckbox
                  id="settings-text-selection-menu"
                  label={t('text_selection_menu')}
                  checked={settings.enableTextSelectionMenu === true}
                  onCheckedChange={(checked) => {
                    setSettings({
                      ...settings,
                      enableTextSelectionMenu: checked,
                    })
                  }}
                />
              </Item>
              <Item
                title={t('hide_endnotes')}
                description={t('hide_endnotes.description')}
                controlId="settings-hide-endnotes"
              >
                <SettingsCheckbox
                  id="settings-hide-endnotes"
                  label={t('hide_endnotes')}
                  checked={settings.hideEndnotes === true}
                  onCheckedChange={(checked) => {
                    setSettings({
                      ...settings,
                      hideEndnotes: checked,
                    })
                  }}
                />
              </Item>
              <Item
                title={t('show_recent_books')}
                description={t('show_recent_books.description')}
                controlId="settings-show-recent-books"
              >
                <SettingsCheckbox
                  id="settings-show-recent-books"
                  label={t('show_recent_books')}
                  checked={settings.showRecentBooks === true}
                  onCheckedChange={(checked) => {
                    setSettings((prev) => ({
                      ...prev,
                      showRecentBooks: checked,
                    }))
                  }}
                />
              </Item>
              <Item
                title={t('show_library_in_toc')}
                description={t('show_library_in_toc.description')}
                controlId="settings-show-library-in-toc"
              >
                <SettingsCheckbox
                  id="settings-show-library-in-toc"
                  label={t('show_library_in_toc')}
                  checked={settings.showLibraryInToc === true}
                  onCheckedChange={(checked) => {
                    setSettings((prev) => ({
                      ...prev,
                      showLibraryInToc: checked,
                    }))
                  }}
                />
              </Item>
            </div>
          )}
          {activeTab === 'tags' && <TagSettings />}
          {activeTab === 'txt' && (
            <div data-flow-settings-panel className="m-0 space-y-4">
              <Item
                title={t('txt_import.auto_import')}
                description={t('txt_import.auto_import.description')}
                controlId="settings-txt-auto-import"
              >
                <SettingsCheckbox
                  id="settings-txt-auto-import"
                  label={t('txt_import.auto_import')}
                  checked={settings.directTextImport === true}
                  onCheckedChange={(checked) => {
                    setSettings((prev) => ({
                      ...prev,
                      directTextImport: checked,
                    }))
                  }}
                />
              </Item>
              <Item
                title={t('txt_import.group_rules')}
                description={<RegexDescription descriptionKey="txt_import.group_rules.description" />}
                wideControl
              >
                <PatternTextarea
                  label={t('txt_import.group_rules')}
                  value={textImportRules.groupPatterns}
                  onChange={(patterns) => updateTextImportRules({ groupPatterns: patterns })}
                />
              </Item>
              <Item
                title={t('txt_import.chapter_rules')}
                description={<RegexDescription descriptionKey="txt_import.chapter_rules.description" />}
                wideControl
              >
                <PatternTextarea
                  label={t('txt_import.chapter_rules')}
                  value={textImportRules.chapterPatterns}
                  onChange={(patterns) => updateTextImportRules({ chapterPatterns: patterns })}
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
          {activeTab === 'dictionary' && (
            <div data-flow-settings-panel className="m-0 min-w-0 overflow-hidden">
              <LocalDictionarySettings settings={settings} setSettings={setSettings} />
            </div>
          )}
          {activeTab === 'translation' && <TranslationSettings settings={settings} setSettings={setSettings} />}
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

function TranslationSettings({
  settings,
  setSettings,
}: {
  settings: ReturnType<typeof useSettings>[0]
  setSettings: ReturnType<typeof useSettings>[1]
}) {
  const t = useTranslation('settings.translation')
  const translation = settings.translation ?? {
    mainLanguage: 'zh-Hans' as const,
    secondaryLanguage: 'en' as const,
    defaultProvider: 'google' as const,
  }
  const languageSelect = (label: string, value: TranslationLanguage, key: 'mainLanguage' | 'secondaryLanguage') => (
    <Select
      value={value}
      onValueChange={(next) => {
        const language = next as TranslationLanguage
        setSettings((previous) => {
          const current = previous.translation ?? translation
          const otherKey = key === 'mainLanguage' ? 'secondaryLanguage' : 'mainLanguage'
          return {
            ...previous,
            translation: {
              ...current,
              [key]: language,
              [otherKey]: current[otherKey] === language ? value : current[otherKey],
            },
          }
        })
      }}
    >
      <SelectTrigger aria-label={label} className="h-8 w-44 rounded-lg">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {orderedTargetLanguages(translation.mainLanguage, translation.secondaryLanguage).map((languageId) => (
          <SelectItem key={languageId} value={languageId}>
            {TRANSLATION_LANGUAGES.find((language) => language.id === languageId)?.label ?? languageId}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )

  return (
    <div data-flow-settings-panel className="m-0 space-y-5">
      <Item title={t('main_language')} description={t('main_language.description')}>
        {languageSelect(t('main_language'), translation.mainLanguage, 'mainLanguage')}
      </Item>
      <Item title={t('secondary_language')} description={t('secondary_language.description')}>
        {languageSelect(t('secondary_language'), translation.secondaryLanguage, 'secondaryLanguage')}
      </Item>
      <Item title={t('default_provider')} description={t('default_provider.description')}>
        <SegmentedField
          value={translation.defaultProvider}
          options={[
            { label: 'Google', value: 'google' },
            { label: 'Azure', value: 'azure' },
          ]}
          onChange={(defaultProvider) =>
            setSettings((previous) => ({
              ...previous,
              translation: { ...translation, defaultProvider },
            }))
          }
        />
      </Item>
    </div>
  )
}

interface PatternTextareaProps {
  label: string
  value: string[]
  onChange: (value: string[]) => void
}

const PatternTextarea: React.FC<PatternTextareaProps> = ({ label, value, onChange }) => {
  const valueText = useMemo(() => value.join('\n'), [value])
  const [draft, setDraft] = useState(valueText)
  const focusedRef = useRef(false)
  const onChangeRef = useRef(onChange)

  useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])

  useEffect(() => {
    if (!focusedRef.current) {
      setDraft(valueText)
    }
  }, [valueText])

  return (
    <Textarea
      aria-label={label}
      className="scroll resize-y overflow-y-auto rounded-lg font-mono text-base leading-5"
      style={TEXTAREA_SIZE_STYLE}
      value={draft}
      spellCheck={false}
      onValueChange={setDraft}
      onFocus={() => {
        focusedRef.current = true
      }}
      onBlur={() => {
        focusedRef.current = false
        const patterns = parsePatternText(draft)
        const normalized = patterns.join('\n')
        setDraft(normalized)
        if (normalized !== valueText) {
          onChangeRef.current(patterns)
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

function RegexDescription({ descriptionKey }: { descriptionKey: string }) {
  const t = useTranslation('settings')

  return formatTranslation<ReactNode>(t(descriptionKey), [
    <button
      key="regular-expression"
      type="button"
      className="cursor-pointer text-(--flow-accent) underline decoration-current/50 underline-offset-2 hover:decoration-current"
      onClick={() => {
        void openSupportedExternalUrl(REGEX_TESTER_URL).catch(() => undefined)
      }}
    >
      {t('txt_import.regular_expression')}
    </button>,
  ])
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

function SegmentedField<T extends string>({ value, options, onChange }: SegmentedFieldProps<T>) {
  return (
    <SegmentedControl>
      {options.map((option) => {
        const selected = option.value === value

        return (
          <SegmentedControlItem
            key={option.value}
            selected={selected}
            className="px-5"
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </SegmentedControlItem>
        )
      })}
    </SegmentedControl>
  )
}

const AccentColorSetting: React.FC = () => {
  const { accentColor, setAccentColor } = useAccentColor()
  const [open, setOpen] = useState(false)
  const [displayColor, setDisplayColor] = useState(accentColor)
  const t = useTranslation('theme')
  const settingsT = useTranslation('settings')

  const color = normalizeHexColor(displayColor) ?? accentColor

  return (
    <Item title={t('source_color')} description={settingsT('accent_color.description')}>
      <Popover
        open={open}
        onOpenChange={(nextOpen) => {
          if (nextOpen) setDisplayColor(accentColor)
          setOpen(nextOpen)
        }}
      >
        <PopoverTrigger asChild>
          <ColorValueButton value={color} />
        </PopoverTrigger>
        <PopoverContent side="bottom" align="end" sideOffset={8} collisionPadding={8} variant="bare" className="z-110">
          <ColorPickerPopover
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
        </PopoverContent>
      </Popover>
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
    <Item title={t('ui_font_size')} description={t('ui_font_size.description')}>
      <InputGroup className="w-24 overflow-hidden bg-transparent focus-within:border-input focus-within:ring-0">
        <InputGroupInput
          type="text"
          aria-label={t('ui_font_size')}
          readOnly
          value={uiFontSize}
          escapeBehavior="none"
          focusBehavior="select-all"
          className="text-muted-foreground text-base outline-none"
        />
        <div className="border-input grid h-full w-7 shrink-0 grid-rows-2 border-l">
          <button
            type="button"
            aria-label={`${t('ui_font_size')} +`}
            className="flex min-h-0 w-full cursor-pointer items-center justify-center text-muted-foreground transition-colors enabled:hover:bg-(--flow-bg-control-hover) enabled:active:bg-(--flow-bg-control-active) disabled:cursor-default disabled:opacity-35"
            disabled={uiFontSize >= maxUiFontSize}
            onClick={() => setUiFontSize(uiFontSize + 1)}
          >
            <ChevronUpIcon className="size-3" />
          </button>
          <button
            type="button"
            aria-label={`${t('ui_font_size')} -`}
            className="border-input flex min-h-0 w-full cursor-pointer items-center justify-center border-t text-muted-foreground transition-colors enabled:hover:bg-(--flow-bg-control-hover) enabled:active:bg-(--flow-bg-control-active) disabled:cursor-default disabled:opacity-35"
            disabled={uiFontSize <= minUiFontSize}
            onClick={() => setUiFontSize(uiFontSize - 1)}
          >
            <ChevronDownIcon className="size-3" />
          </button>
        </div>
      </InputGroup>
    </Item>
  )
}

interface SettingsCheckboxProps {
  checked: boolean
  id: string
  label: string
  onCheckedChange: (checked: boolean) => void
}

const SettingsCheckbox: React.FC<SettingsCheckboxProps> = ({ checked, id, label, onCheckedChange }) => {
  return (
    <UiCheckbox
      id={id}
      aria-label={label}
      className="size-5 after:inset-x-0"
      checked={checked}
      onCheckedChange={(value) => onCheckedChange(value === true)}
    />
  )
}

const ShortcutSettings: React.FC = () => {
  const t = useTranslation()
  const groups = createShortcutGroups(t)

  return (
    <div className="space-y-5">
      {groups.map((group) => (
        <section key={group.title}>
          <h3 className="text-muted-foreground mb-2 text-base font-semibold">{group.title}</h3>
          <div className="divide-border divide-y">
            {group.items.map((item) => (
              <div key={item.label} className="flex min-h-9 items-center justify-between gap-4 py-1.5">
                <span className="text-muted-foreground min-w-0 text-base">{item.label}</span>
                <div className="flex shrink-0 flex-wrap justify-end gap-1">
                  {item.shortcuts.map((shortcut) => (
                    <ShortcutChord key={shortcut.join('+')} shortcut={shortcut} />
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

// PageTab uses displayName as its persisted page identifier.
SettingsPanel.displayName = 'settings'
