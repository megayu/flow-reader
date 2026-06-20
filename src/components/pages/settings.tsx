import Dexie from 'dexie'
import type { ReactNode } from 'react'
import { useState } from 'react'

import { useLocale, useSourceColor, useTranslation } from '@flow/reader/hooks'
import { AppLocale, localeNames } from '@flow/reader/locales'
import { useSettings } from '@flow/reader/state'

import { Button } from '../Button'
import { ColorPickerPopover, normalizeHexColor } from '../ColorPickerPopover'
import { Checkbox, Select } from '../Form'
import { Page } from '../Page'

export const Settings: React.FC = () => {
  const { locale, locales, setLocale } = useLocale()
  const [settings, setSettings] = useSettings()
  const t = useTranslation('settings')

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
