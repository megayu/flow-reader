import Dexie from 'dexie'
import type { ReactNode } from 'react'

import { useLocale, useTranslation } from '@flow/reader/hooks'
import { AppLocale, localeNames } from '@flow/reader/locales'
import { useSettings } from '@flow/reader/state'

import { Button } from '../Button'
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
