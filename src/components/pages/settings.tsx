import clsx from 'clsx'
import type { CSSProperties, ReactNode } from 'react'
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'

import { RenditionSpread } from '@flow/epubjs/types/rendition'
import { openSupportedExternalUrl } from '@flow/reader/externalLink'
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
import {
  orderedTargetLanguages,
  TRANSLATION_LANGUAGES,
  type TranslationLanguage,
} from '@flow/reader/translation/languages'

import { ColorPickerPopover, normalizeHexColor } from '../ColorPickerPopover'
import { LocalDictionarySettings } from '../LocalDictionarySettings'
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
  const [popupOpen, setPopupOpen] = useState(false)
  const contentRef = useRef<HTMLDivElement>(null)
  const popupPointerDownOutsideRef = useRef(false)

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !popupOpen) onClose()
      }}
    >
      <DialogContent
        ref={contentRef}
        data-flow-keyboard-capture="true"
        className="h-[min(38rem,calc(100vh-4rem))] w-[min(56rem,calc(100vw-2rem))] max-w-none overflow-hidden rounded-lg p-0"
        onEscapeKeyDown={(event) => {
          if (
            event.target instanceof Element &&
            event.target.closest('[data-dictionary-inline-editor]')
          ) {
            event.preventDefault()
          }
        }}
        onPointerDownOutside={(event) => {
          if (popupPointerDownOutsideRef.current) {
            popupPointerDownOutsideRef.current = false
            event.preventDefault()
          }
        }}
      >
        <Settings
          onPopupOpenChange={setPopupOpen}
          onPopupPointerDownOutside={(target) => {
            popupPointerDownOutsideRef.current = !(
              target instanceof Node && contentRef.current?.contains(target)
            )
          }}
        />
      </DialogContent>
    </Dialog>
  )
}

interface SettingsProps {
  onPopupOpenChange: (open: boolean) => void
  onPopupPointerDownOutside: (target: EventTarget | null) => void
}

type SettingsTab =
  | 'basic'
  | 'reading'
  | 'dictionary'
  | 'translation'
  | 'txt'
  | 'shortcuts'
const SETTINGS_TABS: SettingsTab[] = [
  'basic',
  'reading',
  'dictionary',
  'translation',
  'txt',
  'shortcuts',
]
const TEXTAREA_SIZE_STYLE = {
  fieldSizing: 'fixed',
  maxHeight: '22rem',
  minHeight: '8.5rem',
} satisfies CSSProperties
const REGEX_TESTER_URL = 'https://regex101.com/?flavor=rust'

export const Settings: React.FC<SettingsProps> = ({
  onPopupOpenChange,
  onPopupPointerDownOutside,
}) => {
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
    <div className="flex h-full w-full max-w-full min-w-0 flex-row gap-0 overflow-hidden">
      <aside className="border-border w-40 min-w-40 shrink-0 overflow-hidden border-r bg-[var(--flow-bg-sidebar)] p-2">
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
      <section className="scroll w-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-5 py-4">
        <h2 className="text-muted-foreground text-lg font-semibold">
          {t(`tabs.${activeTab}`)}
        </h2>
        <div className="mt-5 space-y-5">
          {activeTab === 'basic' && (
            <div data-flow-settings-panel className="m-0 space-y-5">
              <Item title={t('language')}>
                <Select
                  value={locale}
                  onOpenChange={onPopupOpenChange}
                  onValueChange={(value) => setLocale(value as AppLocale)}
                >
                  <SelectTrigger
                    aria-label={t('language')}
                    className="h-8 w-44 rounded-lg"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent
                    onPointerDownOutside={(event) =>
                      onPopupPointerDownOutside(
                        event.detail.originalEvent.target,
                      )
                    }
                  >
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
            </div>
          )}
          {activeTab === 'reading' && (
            <div data-flow-settings-panel className="m-0 space-y-5">
              <Item
                title={t('default_page_view')}
                description={t('default_page_view.description')}
              >
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
              <Item
                title={t('default_text_align')}
                description={t('default_text_align.description')}
              >
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
                  checked={settings.enableTextSelectionMenu !== false}
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
            </div>
          )}
          {activeTab === 'txt' && (
            <div data-flow-settings-panel className="m-0 space-y-4">
              <Item
                title={t('txt_import.group_rules')}
                description={
                  <RegexDescription descriptionKey="txt_import.group_rules.description" />
                }
                wideControl
              >
                <PatternTextarea
                  label={t('txt_import.group_rules')}
                  value={textImportRules.groupPatterns}
                  onChange={(patterns) =>
                    updateTextImportRules({ groupPatterns: patterns })
                  }
                />
              </Item>
              <Item
                title={t('txt_import.chapter_rules')}
                description={
                  <RegexDescription descriptionKey="txt_import.chapter_rules.description" />
                }
                wideControl
              >
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
          {activeTab === 'dictionary' && (
            <div
              data-flow-settings-panel
              className="m-0 min-w-0 overflow-hidden"
            >
              <LocalDictionarySettings
                settings={settings}
                setSettings={setSettings}
              />
            </div>
          )}
          {activeTab === 'translation' && (
            <TranslationSettings
              settings={settings}
              setSettings={setSettings}
              onPopupOpenChange={onPopupOpenChange}
              onPopupPointerDownOutside={onPopupPointerDownOutside}
            />
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

function TranslationSettings({
  settings,
  setSettings,
  onPopupOpenChange,
  onPopupPointerDownOutside,
}: {
  settings: ReturnType<typeof useSettings>[0]
  setSettings: ReturnType<typeof useSettings>[1]
  onPopupOpenChange: (open: boolean) => void
  onPopupPointerDownOutside: (target: EventTarget | null) => void
}) {
  const t = useTranslation('settings.translation')
  const translation = settings.translation ?? {
    mainLanguage: 'zh-Hans' as const,
    secondaryLanguage: 'en' as const,
    defaultProvider: 'google' as const,
  }
  const languageSelect = (
    label: string,
    value: TranslationLanguage,
    key: 'mainLanguage' | 'secondaryLanguage',
  ) => (
    <Select
      value={value}
      onOpenChange={onPopupOpenChange}
      onValueChange={(next) => {
        const language = next as TranslationLanguage
        setSettings((previous) => {
          const current = previous.translation ?? translation
          const otherKey =
            key === 'mainLanguage' ? 'secondaryLanguage' : 'mainLanguage'
          return {
            ...previous,
            translation: {
              ...current,
              [key]: language,
              [otherKey]:
                current[otherKey] === language ? value : current[otherKey],
            },
          }
        })
      }}
    >
      <SelectTrigger aria-label={label} className="h-8 w-44 rounded-lg">
        <SelectValue />
      </SelectTrigger>
      <SelectContent
        onPointerDownOutside={(event) =>
          onPopupPointerDownOutside(event.detail.originalEvent.target)
        }
      >
        {orderedTargetLanguages(
          translation.mainLanguage,
          translation.secondaryLanguage,
        ).map((languageId) => (
          <SelectItem key={languageId} value={languageId}>
            {TRANSLATION_LANGUAGES.find(
              (language) => language.id === languageId,
            )?.label ?? languageId}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )

  return (
    <div data-flow-settings-panel className="m-0 space-y-5">
      <Item
        title={t('main_language')}
        description={t('main_language.description')}
      >
        {languageSelect(
          t('main_language'),
          translation.mainLanguage,
          'mainLanguage',
        )}
      </Item>
      <Item
        title={t('secondary_language')}
        description={t('secondary_language.description')}
      >
        {languageSelect(
          t('secondary_language'),
          translation.secondaryLanguage,
          'secondaryLanguage',
        )}
      </Item>
      <Item
        title={t('default_provider')}
        description={t('default_provider.description')}
      >
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

function RegexDescription({ descriptionKey }: { descriptionKey: string }) {
  const t = useTranslation('settings')

  return renderRichText(t(descriptionKey), {
    regex: (
      <button
        type="button"
        className="cursor-pointer text-[var(--flow-accent)] underline decoration-current/50 underline-offset-2 hover:decoration-current"
        onClick={() => {
          void openSupportedExternalUrl(REGEX_TESTER_URL).catch(() => undefined)
        }}
      >
        {t('txt_import.regular_expression')}
      </button>
    ),
  })
}

function renderRichText(
  message: string,
  replacements: Record<string, ReactNode>,
) {
  return message.split(/(\{[a-z][a-z0-9_]*\})/g).map((part, index) => {
    const name = part.match(/^\{(.+)\}$/)?.[1]
    const replacement = name ? replacements[name] : undefined

    return (
      <Fragment key={index}>
        {replacement === undefined ? part : replacement}
      </Fragment>
    )
  })
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
    <div className="text-muted-foreground ring-border inline-flex h-8 items-center overflow-hidden rounded-lg bg-[var(--flow-bg-control)] p-0.5 ring-1 ring-inset">
      {options.map((option) => {
        const selected = option.value === value

        return (
          <UiButton
            key={option.value}
            type="button"
            variant={selected ? 'default' : 'ghost'}
            size="sm"
            className={clsx(
              'h-full rounded-lg px-5 text-base',
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
  const settingsT = useTranslation('settings')

  const color = normalizeHexColor(displayColor) ?? accentColor

  return (
    <Item
      title={t('source_color')}
      description={settingsT('accent_color.description')}
    >
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
    <Item title={t('ui_font_size')} description={t('ui_font_size.description')}>
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
  id: string
  label: string
  onCheckedChange: (checked: boolean) => void
}

const SettingsCheckbox: React.FC<SettingsCheckboxProps> = ({
  checked,
  id,
  label,
  onCheckedChange,
}) => {
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

interface PartProps {
  children?: ReactNode
  controlId?: string
  description?: ReactNode
  title: string
  wideControl?: boolean
}
const Item: React.FC<PartProps> = ({
  title,
  children,
  controlId,
  description,
  wideControl = false,
}) => {
  const information = (
    <>
      <h3 className="text-base leading-tight font-semibold text-[var(--flow-text)]">
        {title}
      </h3>
      {description && (
        <p className="text-muted-foreground mt-0 py-0 text-sm leading-snug">
          {description}
        </p>
      )}
    </>
  )

  return (
    <div
      className={clsx(
        'grid min-h-8 items-center gap-x-6',
        wideControl
          ? 'grid-cols-[minmax(0,1fr)_minmax(14rem,28rem)]'
          : 'grid-cols-[minmax(0,1fr)_auto]',
      )}
    >
      {controlId ? (
        <label htmlFor={controlId} className="min-w-0 cursor-pointer">
          {information}
        </label>
      ) : (
        <div className="min-w-0">{information}</div>
      )}
      <div className="flex min-h-8 min-w-0 items-center justify-end">
        {children}
      </div>
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
