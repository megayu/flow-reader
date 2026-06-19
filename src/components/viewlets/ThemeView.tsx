import clsx from 'clsx'
import { ComponentProps } from 'react'

import {
  backgroundOptions,
  darkBackgroundColor,
  useBackground,
  useColorScheme,
  useSourceColor,
  useTranslation,
} from '@flow/reader/hooks'
import { useSettings } from '@flow/reader/state'

import { ColorPicker, Label } from '../Form'
import { PaneViewProps, PaneView } from '../base'

export const ThemeView: React.FC<PaneViewProps> = (props) => {
  const { dark, setScheme } = useColorScheme()
  const { sourceColor, setSourceColor } = useSourceColor()
  const [, setBackground] = useBackground()
  const [{ theme }] = useSettings()
  const t = useTranslation('theme')
  const selectedBackground = theme?.background ?? -1

  return (
    <PaneView {...props}>
      <div className="scroll min-h-0 flex-1 text-on-surface-variant typescale-body-small">
        <div className="space-y-3 pl-4 pr-1.5 pt-2 pb-4">
          <div>
            <ColorPicker
              name={t('source_color')}
              defaultValue={sourceColor}
              onChange={(e) => {
                setSourceColor(e.target.value)
              }}
            />
          </div>
          <div>
            <Label name={t('background_color')}></Label>
            <div className="flex gap-2">
              {backgroundOptions.map((background) => (
                <Background
                  key={background.value}
                  className={background.className}
                  selected={!dark && selectedBackground === background.value}
                  onClick={() => {
                    setScheme('light')
                    setBackground(background.value)
                  }}
                />
              ))}
              <Background
                style={{ backgroundColor: darkBackgroundColor }}
                selected={dark}
                onClick={() => {
                  setScheme('dark')
                }}
              />
            </div>
          </div>
        </div>
      </div>
    </PaneView>
  )
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
        'light h-6 w-6 border',
        selected ? 'border-2 border-primary70' : 'border-outline-variant',
        className,
      )}
      {...props}
    />
  )
}
