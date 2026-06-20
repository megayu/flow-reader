import { Overlay } from '@literal-ui/core'
import clsx from 'clsx'
import Dexie from 'dexie'
import type { ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

import { RenditionSpread } from '@flow/epubjs/types/rendition'
import { useLocale, useSourceColor, useTranslation } from '@flow/reader/hooks'
import { AppLocale, localeNames } from '@flow/reader/locales'
import { useSettings } from '@flow/reader/state'

import { Button } from '../Button'
import { ColorPickerPopover, normalizeHexColor } from '../ColorPickerPopover'
import { Checkbox, Select } from '../Form'
import { Page } from '../Page'

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
        className="bg-default fixed left-1/2 top-1/2 z-[90] max-h-[calc(100vh-4rem)] w-[min(30rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded text-on-surface-variant shadow-lg ring-1 ring-inset ring-on-surface-variant/20"
      >
        <div className="scroll max-h-[calc(100vh-4rem)]">
          <Settings />
        </div>
      </div>
    </>,
    document.body,
  )
}

export const Settings: React.FC = () => {
  const { locale, locales, setLocale } = useLocale()
  const [settings, setSettings] = useSettings()
  const t = useTranslation('settings')
  const typographyT = useTranslation('typography')

  return (
    <Page headline={t('title')}>
      <div className="space-y-6">
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
        <Item title={t('cache')}>
          <Button
            variant="secondary"
            onClick={() => {
              window.localStorage.clear()
              Dexie.getDatabaseNames().then((names) => {
                names.forEach((n) => Dexie.delete(n))
              })
            }}
          >
            {t('cache.clear')}
          </Button>
        </Item>
      </div>
    </Page>
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
    <div className="bg-default flex h-[31px] items-center p-0.5 text-on-surface-variant">
      {options.map((option) => {
        const selected = option.value === value

        return (
          <button
            key={option.value}
            type="button"
            className={clsx(
              'h-full flex-1 px-2 !text-[13px] typescale-body-medium',
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
    <div>
      <h3 className="text-on-surface-variant typescale-title-small">{title}</h3>
      <div className="mt-2">{children}</div>
    </div>
  )
}

Settings.displayName = 'settings'
