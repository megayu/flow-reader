import clsx from 'clsx'
import {
  ComponentProps,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from 'react'

import { useAccentColor } from '@flow/reader/hooks/theme/useSourceColor'
import { useTranslation } from '@flow/reader/hooks/useTranslation'
import { useSettings, type Settings } from '@flow/reader/state'
import {
  backgroundPresets,
  defaultAccentColor,
  defaultCustomBackgroundColor,
  isDarkPaletteColor,
  normalizePaletteColor,
  normalizeThemeConfiguration,
  type BackgroundPreset,
} from '@flow/reader/styles/theme'

import { ColorPickerPopover } from '../ColorPickerPopover'

interface ThemePanelProps {
  className?: string
  onClose?: () => void
}
export const ThemePanel: React.FC<ThemePanelProps> = ({
  className,
  onClose,
}) => {
  const [{ theme }, setSettings] = useSettings()
  const { accentColor, setAccentColor } = useAccentColor()
  const t = useTranslation('theme')
  const normalizedTheme = normalizeThemeConfiguration(theme)
  const [customPickerOpen, setCustomPickerOpen] = useState(false)
  const [accentPickerOpen, setAccentPickerOpen] = useState(false)
  const previousThemeRef = useRef<Settings['theme'] | undefined>(undefined)
  const customSessionActiveRef = useRef(false)
  const customSessionAppliedRef = useRef(false)
  const selectedBackground = normalizedTheme.backgroundPreset
  const customBackground =
    normalizePaletteColor(normalizedTheme.customBackground) ??
    defaultCustomBackgroundColor
  const positioned = hasPositionClass(className)

  const applyBackgroundPreset = (preset: BackgroundPreset) => {
    customSessionActiveRef.current = false
    customSessionAppliedRef.current = true
    setCustomPickerOpen(false)
    setSettings((prev) => ({
      ...prev,
      theme: {
        ...prev.theme,
        backgroundPreset: preset.id,
        scheme: preset.mode,
        contrast: prev.theme?.contrast ?? 'standard',
      },
    }))
  }

  const previewCustomBackground = (color: string) => {
    setSettings((prev) => ({
      ...prev,
      theme: {
        ...prev.theme,
        backgroundPreset: 'custom',
        customBackground: color,
        scheme: isDarkPaletteColor(color) ? 'dark' : 'light',
        contrast: prev.theme?.contrast ?? 'standard',
      },
    }))
  }

  const openCustomPicker = () => {
    if (!customSessionActiveRef.current) {
      previousThemeRef.current = theme
      customSessionActiveRef.current = true
      customSessionAppliedRef.current = false
    }
    setAccentPickerOpen(false)
    setCustomPickerOpen(true)
    previewCustomBackground(customBackground)
  }

  const restorePreviousTheme = () => {
    if (customSessionActiveRef.current && !customSessionAppliedRef.current) {
      setSettings((prev) => ({
        ...prev,
        theme: previousThemeRef.current,
      }))
    }
    customSessionActiveRef.current = false
    customSessionAppliedRef.current = false
    setCustomPickerOpen(false)
  }

  const restorePreviousThemeOnUnmount = useEffectEvent(() => {
    if (customSessionActiveRef.current && !customSessionAppliedRef.current) {
      setSettings((prev) => ({
        ...prev,
        theme: previousThemeRef.current,
      }))
    }
  })

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()

      if (customPickerOpen) {
        restorePreviousTheme()
        return
      }

      if (accentPickerOpen) {
        setAccentPickerOpen(false)
        return
      }

      onClose?.()
    }

    const targets = [window, ...getIframeWindows()]
    targets.forEach((target) =>
      target.addEventListener('keydown', onKeyDown, true),
    )
    return () => {
      targets.forEach((target) =>
        target.removeEventListener('keydown', onKeyDown, true),
      )
    }
  })

  useEffect(() => {
    return () => {
      restorePreviousThemeOnUnmount()
    }
  }, [])

  return (
    <div
      data-flow-theme-panel
      className={clsx(
        'text-muted-foreground ring-border z-[100] w-80 rounded-xl bg-[var(--flow-bg-panel)] p-3 text-base shadow-xl ring-1 ring-inset',
        positioned || 'relative',
        className,
      )}
    >
      <div className="grid grid-cols-3 gap-2">
        {backgroundPresets.map((preset) => (
          <BackgroundSwatch
            key={preset.id}
            preset={preset}
            label={t(`preset.${preset.id}`)}
            selected={selectedBackground === preset.id}
            onClick={() => applyBackgroundPreset(preset)}
          />
        ))}
        <button
          type="button"
          aria-pressed={selectedBackground === 'custom'}
          className={clsx(
            'group relative h-12 overflow-hidden rounded-lg border border-dashed text-left shadow-sm transition-[color,background-color,border-color,box-shadow] outline-none focus-visible:ring-2 focus-visible:ring-[var(--flow-focus-ring)]',
            selectedBackground === 'custom'
              ? 'border-[var(--flow-accent)] ring-2 ring-[var(--flow-accent-border)]'
              : 'border-[var(--flow-border-strong)] hover:border-[var(--flow-accent-border)]',
          )}
          style={{ backgroundColor: customBackground }}
          onClick={openCustomPicker}
        >
          <span
            className="absolute inset-x-1.5 top-1/2 -translate-y-1/2 truncate text-center text-base font-medium"
            style={{
              color: isDarkPaletteColor(customBackground)
                ? '#F8FAFC'
                : '#1F2937',
            }}
          >
            {t('preset.custom')}
          </span>
          <span
            className="absolute right-1.5 bottom-1.5 h-1.5 w-8 rounded-full"
            style={{ backgroundColor: accentColor }}
          />
        </button>
      </div>

      <div className="border-border mt-3 flex items-center justify-between gap-3 border-t pt-3">
        <span className="text-muted-foreground text-base font-medium">
          {t('source_color')}
        </span>
        <button
          type="button"
          aria-label={t('source_color')}
          className="border-border text-foreground flex h-8 items-center gap-2 rounded-lg border bg-[var(--flow-bg-control)] px-2 text-base transition-colors outline-none hover:bg-[var(--flow-bg-control-hover)] focus-visible:ring-2 focus-visible:ring-[var(--flow-focus-ring)]"
          onClick={() => {
            setCustomPickerOpen(false)
            setAccentPickerOpen(true)
          }}
        >
          <span
            className="ring-border h-4 w-8 rounded-md ring-1 ring-inset"
            style={{ backgroundColor: accentColor }}
          />
          <span className="font-mono text-base">{accentColor}</span>
        </button>
      </div>

      <ThemePreview />

      {customPickerOpen && (
        <div className="absolute bottom-0 left-full z-[110] ml-2">
          <ColorPickerPopover
            value={customBackground}
            defaultValue={defaultCustomBackgroundColor}
            handleEscape={false}
            onPreview={previewCustomBackground}
            onApply={(color) => {
              customSessionAppliedRef.current = true
              customSessionActiveRef.current = false
              previewCustomBackground(color)
              setCustomPickerOpen(false)
            }}
            onCancel={restorePreviousTheme}
          />
        </div>
      )}

      {accentPickerOpen && (
        <div className="absolute bottom-0 left-full z-[110] ml-2">
          <ColorPickerPopover
            value={accentColor}
            defaultValue={defaultAccentColor}
            handleEscape={false}
            onPreview={setAccentColor}
            onApply={(color) => {
              setAccentColor(color)
              setAccentPickerOpen(false)
            }}
            onCancel={() => setAccentPickerOpen(false)}
          />
        </div>
      )}
    </div>
  )
}

function hasPositionClass(className: string | undefined) {
  return /\b(?:absolute|fixed|relative|sticky)\b/.test(className ?? '')
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

interface BackgroundSwatchProps extends ComponentProps<'button'> {
  preset: BackgroundPreset
  label: string
  selected?: boolean
}
const BackgroundSwatch: React.FC<BackgroundSwatchProps> = ({
  preset,
  label,
  selected,
  className,
  ...props
}) => {
  const seed = preset.mode === 'dark' ? preset.darkSeed : preset.lightSeed
  const labelColor = isDarkPaletteColor(seed) ? '#F8FAFC' : '#1F2937'

  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-label={label}
      className={clsx(
        'group relative h-12 overflow-hidden rounded-lg border text-left shadow-sm transition-[color,background-color,border-color,box-shadow] outline-none focus-visible:ring-2 focus-visible:ring-[var(--flow-focus-ring)]',
        selected
          ? 'border-[var(--flow-accent)] ring-2 ring-[var(--flow-accent-border)]'
          : 'border-[var(--flow-border)] hover:border-[var(--flow-accent-border)]',
        className,
      )}
      style={{ backgroundColor: seed }}
      {...props}
    >
      <span
        className="absolute inset-x-1.5 top-1/2 -translate-y-1/2 truncate text-center text-base font-medium"
        style={{ color: labelColor }}
      >
        {label}
      </span>
      <span
        className="absolute right-1.5 bottom-1.5 h-1.5 w-8 rounded-full"
        style={{ backgroundColor: preset.defaultAccent }}
      />
    </button>
  )
}

const ThemePreview: React.FC = () => {
  return (
    <div className="border-border mt-3 overflow-hidden rounded-lg border bg-[var(--flow-bg-app)]">
      <div className="flex h-36 min-w-0">
        <div className="relative flex w-8 flex-col items-center gap-2 bg-[var(--flow-bg-activity)] py-2">
          <span className="absolute inset-y-8 left-0 w-0.5 rounded-r bg-[var(--flow-accent)]" />
          <span className="h-4 w-4 rounded bg-[var(--flow-bg-control-hover)]" />
          <span className="h-4 w-4 rounded bg-[var(--flow-bg-control-hover)]" />
          <span className="h-4 w-4 rounded bg-[var(--flow-accent-bg)] ring-1 ring-[var(--flow-accent-border)] ring-inset" />
        </div>
        <div className="border-border flex w-20 flex-col gap-1.5 border-r bg-[var(--flow-bg-sidebar)] p-2">
          <span className="h-3 rounded bg-[var(--flow-sidebar-item-bg)] ring-1 ring-[var(--flow-sidebar-item-border)] ring-inset" />
          <span className="h-3 rounded bg-[var(--flow-sidebar-item-bg-hover)] ring-1 ring-[var(--flow-sidebar-item-border)] ring-inset" />
          <span className="h-4 rounded bg-[var(--flow-accent-bg)] ring-1 ring-[var(--flow-accent-border)] ring-inset" />
          <span className="mt-auto h-3 rounded bg-[var(--flow-sidebar-item-bg)] ring-1 ring-[var(--flow-sidebar-item-border)] ring-inset" />
        </div>
        <div className="flex min-w-0 flex-1 flex-col bg-[var(--flow-bg-content)]">
          <div className="flex h-8 items-end gap-1 bg-[var(--flow-bg-tabbar)] px-1">
            <span className="mb-1 h-5 w-10 rounded-md bg-[var(--flow-bg-control-hover)]" />
            <span className="relative h-7 w-16 rounded-t-md bg-[var(--flow-bg-tab-active)] shadow-[inset_0_1px_0_var(--flow-tab-border)] before:absolute before:bottom-0 before:-left-[8px] before:size-2 before:rounded-br-md before:shadow-[4px_4px_0_4px_var(--flow-bg-tab-active)] after:absolute after:right-[-8px] after:bottom-0 after:size-2 after:rounded-bl-md after:shadow-[-4px_4px_0_4px_var(--flow-bg-tab-active)]">
              <span className="absolute inset-x-2 top-0 h-px rounded-full bg-[var(--flow-accent)]" />
            </span>
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-1.5 p-2">
            <span className="h-2.5 rounded bg-[var(--flow-bg-control-hover)]" />
            <span className="h-2.5 w-5/6 rounded bg-[var(--flow-bg-control)]" />
            <span className="h-2.5 w-2/3 rounded bg-[var(--flow-bg-control)]" />
            <div className="mt-auto flex items-center gap-1.5">
              <span className="h-4 w-8 rounded bg-[var(--flow-bg-control)]" />
              <span className="h-4 w-9 rounded bg-[var(--flow-accent)]" />
              <span className="ml-auto h-4 w-8 rounded bg-[var(--flow-danger-bg)] ring-1 ring-[var(--flow-danger)] ring-inset" />
            </div>
            <div className="flex h-2 items-center gap-1">
              <span className="h-1 flex-1 rounded-full bg-[var(--flow-bg-control-hover)]">
                <span className="block h-full w-2/5 rounded-full bg-[var(--flow-accent)]" />
              </span>
              <span className="h-2 w-8 rounded-full bg-[var(--flow-accent-bg)] ring-1 ring-[var(--flow-accent-border)] ring-inset" />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
