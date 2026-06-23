import clsx from 'clsx'
import { ComponentProps, useEffect, useRef, useState } from 'react'

import {
  backgroundOptions,
  customBackgroundValue,
  darkBackgroundColor,
  defaultCustomBackgroundColor,
  isDarkPaletteColor,
  normalizePaletteColor,
  useBackground,
} from '@flow/reader/hooks/theme/useBackground'
import { useColorScheme } from '@flow/reader/hooks/theme/useColorScheme'
import { useSettings, type Settings } from '@flow/reader/state'

import { ColorPickerPopover } from '../ColorPickerPopover'
import { PaneView, PaneViewProps } from '../base/PaneView'

export const ThemeView: React.FC<PaneViewProps> = (props) => {
  return (
    <PaneView {...props}>
      <ThemePanel />
    </PaneView>
  )
}

interface ThemePanelProps {
  className?: string
  onClose?: () => void
}
export const ThemePanel: React.FC<ThemePanelProps> = ({
  className,
  onClose,
}) => {
  const { dark, scheme, setScheme } = useColorScheme()
  const [, setBackground] = useBackground()
  const [{ theme }, setSettings] = useSettings()
  const [customPickerOpen, setCustomPickerOpen] = useState(false)
  const previousThemeRef = useRef<Settings['theme'] | undefined>(undefined)
  const previousSchemeRef = useRef<'light' | 'dark' | 'system'>('system')
  const customSessionActiveRef = useRef(false)
  const customSessionAppliedRef = useRef(false)
  const selectedBackground = theme?.background ?? -1
  const customBackground =
    normalizePaletteColor(theme?.customBackground) ??
    defaultCustomBackgroundColor
  const positioned = hasPositionClass(className)

  const applyBackground = (background: number) => {
    customSessionActiveRef.current = false
    customSessionAppliedRef.current = true
    setCustomPickerOpen(false)
    setScheme('light')
    setBackground(background)
  }

  const previewCustomBackground = (color: string) => {
    setScheme(isDarkPaletteColor(color) ? 'dark' : 'light')
    setSettings((prev) => ({
      ...prev,
      theme: {
        ...prev.theme,
        background: customBackgroundValue,
        customBackground: color,
      },
    }))
  }

  const openCustomPicker = () => {
    if (!customSessionActiveRef.current) {
      previousThemeRef.current = theme
      previousSchemeRef.current = scheme ?? 'system'
      customSessionActiveRef.current = true
      customSessionAppliedRef.current = false
    }
    setCustomPickerOpen(true)
    previewCustomBackground(customBackground)
  }

  const restorePreviousTheme = () => {
    if (customSessionActiveRef.current && !customSessionAppliedRef.current) {
      setSettings((prev) => ({
        ...prev,
        theme: previousThemeRef.current,
      }))
      setScheme(previousSchemeRef.current)
    }
    customSessionActiveRef.current = false
    customSessionAppliedRef.current = false
    setCustomPickerOpen(false)
  }

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()

      if (customPickerOpen) {
        restorePreviousTheme()
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
      if (customSessionActiveRef.current && !customSessionAppliedRef.current) {
        setSettings((prev) => ({
          ...prev,
          theme: previousThemeRef.current,
        }))
        setScheme(previousSchemeRef.current)
      }
    }
  }, [setScheme, setSettings])

  return (
    <div
      className={clsx(
        'text-muted-foreground ring-border bg-background/70 z-[100] flex flex-col-reverse items-center gap-2 rounded-full p-1 text-xs shadow-lg ring-1 backdrop-blur-sm ring-inset',
        positioned || 'relative',
        className,
      )}
    >
      {backgroundOptions.map((background) => (
        <Background
          key={background.value}
          style={{ backgroundColor: background.color }}
          selected={!dark && selectedBackground === background.value}
          onClick={() => applyBackground(background.value)}
        />
      ))}
      <Background
        style={{ backgroundColor: darkBackgroundColor }}
        selected={dark && selectedBackground !== customBackgroundValue}
        onClick={() => {
          customSessionActiveRef.current = false
          customSessionAppliedRef.current = true
          setCustomPickerOpen(false)
          setScheme('dark')
        }}
      />
      <Background
        style={{ backgroundColor: customBackground }}
        selected={selectedBackground === customBackgroundValue}
        className="border-dashed"
        onClick={openCustomPicker}
      />
      {customPickerOpen && (
        <div className="absolute top-0 left-[46px] z-[110]">
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

interface BackgroundProps extends ComponentProps<'button'> {
  selected?: boolean
}
const Background: React.FC<BackgroundProps> = ({
  className,
  selected,
  ...props
}) => {
  return (
    <button
      type="button"
      aria-pressed={selected}
      className={clsx(
        'light h-9 w-9 rounded-full border shadow-sm',
        selected ? 'border-primary border-2' : 'border-border',
        className,
      )}
      {...props}
    />
  )
}
