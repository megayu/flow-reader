import { invoke } from '@tauri-apps/api/core'
import { MinusIcon, PlusIcon, XIcon } from 'lucide-react'
import { type ComponentProps, useCallback, useEffect, useRef, useState } from 'react'

import { RenditionSpread } from '@flow/epubjs/rendition'
import { useTranslation } from '@/hooks/useTranslation'
import { reader, useReaderSnapshot } from '@/models/reader'
import { resolveBookSpreadPolicy } from '@/reader/spreadPolicy'
import { createTextSearchIndex } from '@/search/textSearch'
import { type PageAppearance, type TypographyConfiguration, useSettings } from '@/state'

import { getBodyTypographyBaseline } from '../../styles'
import { PaneView, type PaneViewProps } from '../base/PaneView'
import { IconButton } from '../IconButton'
import { Combobox, type ComboboxOption } from '../ui/combobox'
import { InputGroup, InputGroupActions, InputGroupInput } from '../ui/input-group'
import { SegmentedControl, SegmentedControlItem } from '../ui/segmented-control'

type TextAlignOption = NonNullable<TypographyConfiguration['textAlign']>

interface SystemFont {
  family: string
  label: string
}

const ZOOM_MAX = 2
const LINE_HEIGHT_MAX = 3
const TEXT_INDENT_MAX = 4

export const TypographyView: React.FC<PaneViewProps> = (props) => {
  const active = props.active ?? true

  return <PaneView {...props}>{active && <TypographyPane />}</PaneView>
}

const TypographyPane: React.FC = () => {
  const { focusedBookTab } = useReaderSnapshot()
  const [settings] = useSettings()
  const t = useTranslation('typography')

  const [localFonts, setLocalFonts] = useState<ComboboxOption[]>()
  const localFontsRequestRef = useRef<Promise<ComboboxOption[] | undefined> | undefined>(undefined)
  const bookTypography = focusedBookTab?.book.configuration?.typography
  const typography = bookTypography ?? {}
  const isScrolledDocument = focusedBookTab?.isScrolledDocument ?? false

  const { fontFamily, fontSize, fontWeight, lineHeight, textIndent, zoom } = typography
  const globalSpread = settings.spread ?? RenditionSpread.Auto
  const inheritedSpread = resolveBookSpreadPolicy({
    publicationSpread: focusedBookTab?.book.metadata.spread,
    applicationDefault: globalSpread,
  })
  const globalTextAlign: TextAlignOption = settings.textAlign ?? 'default'

  const setTypography = useCallback(<K extends keyof TypographyConfiguration>(k: K, v: TypographyConfiguration[K]) => {
    const tab = reader.focusedBookTab
    if (!tab) return

    const typography = {
      ...tab.book.configuration?.typography,
    }

    if (v === undefined) {
      delete typography[k]
    } else {
      typography[k] = v
    }

    tab.updateConfiguration({
      ...tab.book.configuration,
      typography,
    })
  }, [])

  const queryBrowserFonts = useCallback(async () => {
    if (!('queryLocalFonts' in window)) {
      console.error('queryLocalFonts is not available')
      return
    }

    try {
      const fonts = await window.queryLocalFonts()
      return createFontOptions(
        fonts.map((font) => ({
          family: font.family,
          label: font.family,
        })),
      )
    } catch (error) {
      console.error('Error querying local fonts:', error)
      return undefined
    }
  }, [])

  const queryFonts = useCallback(async () => {
    if (localFonts) return localFonts
    if (localFontsRequestRef.current) return localFontsRequestRef.current

    localFontsRequestRef.current = querySystemFonts()
      .then((fonts) => fonts ?? queryBrowserFonts())
      .then((fonts) => {
        if (fonts) setLocalFonts(fonts)
        return fonts
      })
      .finally(() => {
        localFontsRequestRef.current = undefined
      })

    return localFontsRequestRef.current
  }, [localFonts, queryBrowserFonts])

  const getCurrentBodyBaseline = useCallback(() => {
    const tab = reader.focusedBookTab
    return getBodyTypographyBaseline(tab?.view?.contents, tab?.bodyTextCache)
  }, [])

  return (
    <div className="text-muted-foreground flex min-h-0 flex-1 flex-col text-base">
      <div className="scroll min-h-0 flex-1">
        <div className="space-y-3 pt-2 pr-1.5 pb-4 pl-4" key={focusedBookTab?.id}>
          <fieldset className="m-0 min-w-0 border-0 p-0" disabled={isScrolledDocument}>
            <SpreadField
              name={t('page_view')}
              value={isScrolledDocument ? RenditionSpread.None : bookTypography?.spread}
              inheritedValue={inheritedSpread}
              unsetOnSelected
              onChange={(value) => {
                setTypography('spread', value)
              }}
            />
          </fieldset>
          <TextAlignField
            name={t('text_align')}
            value={bookTypography?.textAlign}
            inheritedValue={globalTextAlign}
            unsetOnSelected
            onChange={(value) => {
              setTypography('textAlign', value)
            }}
          />
          <PageAppearanceField
            name={t('page_appearance')}
            value={bookTypography?.pageAppearance}
            onChange={(value) => {
              setTypography('pageAppearance', value)
            }}
          />
          <NumberField
            name={t('zoom')}
            min={1}
            max={ZOOM_MAX}
            step={0.1}
            value={zoom}
            onChange={(v) => {
              setTypography('zoom', v || undefined)
            }}
          />
          <FontField
            name={t('font_family')}
            value={fontFamily ?? ''}
            options={localFonts ?? []}
            loadOptions={queryFonts}
            onChange={(value) => {
              setTypography('fontFamily', value || undefined)
            }}
          />
          <NumberField
            name={t('font_size')}
            min={14}
            max={28}
            value={fontSize ? parseInt(fontSize, 10) : undefined}
            baseValue={() => getCurrentBodyBaseline().fontSize}
            onChange={(v) => {
              setTypography('fontSize', v ? `${v}px` : undefined)
            }}
          />
          <NumberField
            name={t('font_weight')}
            min={100}
            max={900}
            step={100}
            value={fontWeight}
            baseValue={() => getCurrentBodyBaseline().fontWeight}
            onChange={(v) => {
              setTypography('fontWeight', v || undefined)
            }}
          />
          <NumberField
            name={t('line_height')}
            min={1}
            max={LINE_HEIGHT_MAX}
            step={0.1}
            value={lineHeight}
            baseValue={() => getCurrentBodyBaseline().lineHeight}
            onChange={(v) => {
              setTypography('lineHeight', v || undefined)
            }}
          />
          <NumberField
            name={t('text_indent')}
            min={0}
            max={TEXT_INDENT_MAX}
            step={0.5}
            value={textIndent}
            onChange={(v) => {
              setTypography('textIndent', v)
            }}
          />
        </div>
      </div>
    </div>
  )
}

async function querySystemFonts() {
  try {
    const fonts = await invoke<SystemFont[]>('list_system_fonts')
    const options = createFontOptions(fonts)
    return options.length ? options : undefined
  } catch {
    return undefined
  }
}

function createFontOptions(fonts: SystemFont[]) {
  const unique = new Map<string, ComboboxOption>()

  fonts.forEach(({ family, label }) => {
    const normalizedFamily = family.trim()
    const normalizedLabel = cleanFontLabel(label.trim() || normalizedFamily)
    if (!normalizedFamily) return

    const key = fontOptionKey(normalizedLabel || normalizedFamily)
    if (unique.has(key)) return

    unique.set(key, {
      value: normalizedFamily,
      label: normalizedLabel || normalizedFamily,
      searchIndex: createTextSearchIndex([normalizedFamily, normalizedLabel, key]),
    })
  })

  return [...unique.values()].sort((a, b) =>
    a.label.localeCompare(b.label, undefined, {
      numeric: true,
      sensitivity: 'base',
    }),
  )
}

function cleanFontLabel(label: string) {
  return label
    .replace(/\.(?:ttf|ttc|otf)$/i, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
}

function fontOptionKey(label: string) {
  return cleanFontLabel(label)
    .toLowerCase()
    .replace(/\b(?:bold|italic|oblique|regular|medium|light|semibold|semi bold|semilight|semi light|black)\b/g, '')
    .replace(/[^a-z0-9\u3400-\u9fff\uf900-\ufaff]+/g, '')
}

interface TextAlignFieldProps {
  name: string
  value?: TextAlignOption
  inheritedValue?: TextAlignOption
  unsetOnSelected?: boolean
  onChange: (value?: TextAlignOption) => void
}

interface SegmentedFieldOption<T extends string> {
  label: string
  value: T
}

interface SegmentedFieldProps<T extends string> {
  name: string
  value?: T
  inheritedValue?: T
  unsetOnSelected?: boolean
  options: SegmentedFieldOption<T>[]
  onChange: (value?: T) => void
}

function SegmentedField<T extends string>({
  name,
  value,
  inheritedValue,
  unsetOnSelected = false,
  options,
  onChange,
}: SegmentedFieldProps<T>) {
  return (
    <div className="flex flex-col">
      <FieldLabel name={name} />
      <SegmentedControl className="flex w-full bg-background">
        {options.map((option) => {
          const selected = option.value === value
          const inherited = value === undefined && option.value === inheritedValue

          return (
            <SegmentedControlItem
              key={option.value ?? 'default'}
              selected={selected}
              inherited={inherited}
              className="flex-1 px-2 leading-none"
              onClick={() => onChange(selected && unsetOnSelected ? undefined : option.value)}
            >
              {option.label}
            </SegmentedControlItem>
          )
        })}
      </SegmentedControl>
    </div>
  )
}

const FieldLabel: React.FC<{ name: string }> = ({ name }) => {
  return (
    <label htmlFor={name} className="text-muted-foreground mb-1 block text-base font-medium">
      {name}
    </label>
  )
}

interface SpreadFieldProps {
  name: string
  value?: RenditionSpread
  inheritedValue?: RenditionSpread
  unsetOnSelected?: boolean
  onChange: (value?: RenditionSpread) => void
}

const SpreadField: React.FC<SpreadFieldProps> = ({ name, value, inheritedValue, unsetOnSelected, onChange }) => {
  const t = useTranslation('typography')

  return (
    <SegmentedField
      name={name}
      value={value}
      inheritedValue={inheritedValue}
      unsetOnSelected={unsetOnSelected}
      options={[
        {
          label: t('page_view.single_page'),
          value: RenditionSpread.None,
        },
        {
          label: t('page_view.double_page'),
          value: RenditionSpread.Auto,
        },
      ]}
      onChange={onChange}
    />
  )
}

const TextAlignField: React.FC<TextAlignFieldProps> = ({ name, value, inheritedValue, unsetOnSelected, onChange }) => {
  const t = useTranslation('typography')

  return (
    <SegmentedField
      name={name}
      value={value}
      inheritedValue={inheritedValue}
      unsetOnSelected={unsetOnSelected}
      options={[
        { label: t('text_align.default'), value: 'default' },
        { label: t('text_align.justify'), value: 'justify' },
      ]}
      onChange={onChange}
    />
  )
}

interface PageAppearanceFieldProps {
  name: string
  value?: PageAppearance
  onChange: (value?: PageAppearance) => void
}

const PageAppearanceField: React.FC<PageAppearanceFieldProps> = ({ name, value, onChange }) => {
  const t = useTranslation('typography')

  return (
    <SegmentedField
      name={name}
      value={value}
      unsetOnSelected
      options={[
        { label: t('page_appearance.cards'), value: 'cards' },
        { label: t('page_appearance.book'), value: 'book' },
        { label: t('page_appearance.divider'), value: 'divider' },
      ]}
      onChange={onChange}
    />
  )
}

interface FontFieldProps {
  name: string
  value: string
  options: ComboboxOption[]
  loadOptions: () => Promise<ComboboxOption[] | undefined>
  onChange: (value: string) => void
}

const FontField: React.FC<FontFieldProps> = ({ name, value, options, loadOptions, onChange }) => {
  const t = useTranslation('typography')
  const actionT = useTranslation('action')

  return (
    <div className="flex flex-col">
      <FieldLabel name={name} />
      <Combobox
        id={name}
        name={name}
        value={value}
        options={options}
        placeholder={t('default_value')}
        clearLabel={actionT('clear')}
        emptyContent={t('no_matching_fonts')}
        side="right"
        align="start"
        sideOffset={8}
        collisionPadding={8}
        onLoadOptions={loadOptions}
        onValueChange={onChange}
        renderOption={(option) => <span style={{ fontFamily: option.value }}>{option.label}</span>}
      />
    </div>
  )
}

interface NumberFieldProps extends Omit<ComponentProps<'input'>, 'onChange' | 'value' | 'defaultValue'> {
  value?: number
  baseValue?: () => number | undefined
  onChange: (v?: number) => void
}
const NumberField: React.FC<NumberFieldProps> = ({ value, baseValue, onChange, ...props }) => {
  const ref = useRef<HTMLInputElement>(null)
  const actionT = useTranslation('action')
  const typographyT = useTranslation('typography')
  const min = parseNumberInputProp(props.min)
  const max = parseNumberInputProp(props.max)
  const stepDownDisabled = value !== undefined && min !== undefined && value <= min
  const stepUpDisabled = value !== undefined && max !== undefined && value >= max

  useEffect(() => {
    if (!ref.current) return
    ref.current.value = value === undefined ? '' : String(value)
  }, [value])

  const step = (direction: -1 | 1) => {
    if (!ref.current) return
    if (direction < 0 && stepDownDisabled) return
    if (direction > 0 && stepUpDisabled) return

    if (ref.current.value === '') {
      const base = baseValue?.()
      if (base !== undefined) {
        ref.current.value = String(base)
      }
    }

    direction < 0 ? ref.current.stepDown() : ref.current.stepUp()
    onChange(Number(ref.current.value))
  }

  return (
    <div className="flex flex-col">
      {typeof props.name === 'string' && <FieldLabel name={props.name} />}
      <InputGroup>
        <InputGroupInput
          ref={ref}
          type="number"
          id={typeof props.name === 'string' ? props.name : undefined}
          placeholder={typographyT('default_value')}
          defaultValue={value}
          // lazy render
          onBlur={(e) => {
            const normalized = normalizeNumberFieldValue(e.target.value, {
              min: props.min,
              max: props.max,
              step: props.step,
            })
            e.target.value = normalized === undefined ? '' : String(normalized)
            onChange(normalized)
          }}
          {...props}
        />
        <InputGroupActions>
          <IconButton
            className="text-muted-foreground flex size-6 items-center justify-center"
            disabled={stepDownDisabled}
            title={actionT('step_down')}
            Icon={MinusIcon}
            onClick={() => {
              step(-1)
            }}
          />
          <IconButton
            className="text-muted-foreground flex size-6 items-center justify-center"
            disabled={stepUpDisabled}
            title={actionT('step_up')}
            Icon={PlusIcon}
            onClick={() => {
              step(1)
            }}
          />
          <span aria-hidden={value === undefined} className="flex size-6 items-center justify-center">
            <IconButton
              className="text-muted-foreground flex size-6 items-center justify-center"
              disabled={value === undefined}
              tabIndex={value === undefined ? -1 : undefined}
              title={actionT('clear')}
              Icon={XIcon}
              onClick={() => {
                if (ref.current) ref.current.value = ''
                onChange(undefined)
              }}
            />
          </span>
        </InputGroupActions>
      </InputGroup>
    </div>
  )
}

function parseNumberInputProp(value: string | number | undefined) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value !== 'string') return undefined

  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function normalizeNumberFieldValue(input: string, constraints: Pick<ComponentProps<'input'>, 'min' | 'max' | 'step'>) {
  if (input === '') return undefined

  const parsed = Number(input)
  if (!Number.isFinite(parsed)) return undefined

  const min = parseNumberInputProp(constraints.min)
  const max = parseNumberInputProp(constraints.max)
  const step = constraints.step === 'any' ? undefined : (parseNumberInputProp(constraints.step) ?? 1)
  let normalized = parsed

  if (min !== undefined) normalized = Math.max(min, normalized)
  if (max !== undefined) normalized = Math.min(max, normalized)

  if (step !== undefined && step > 0) {
    const base = min ?? 0
    normalized = base + Math.round((normalized - base) / step) * step
    normalized = Number(normalized.toFixed(12))
  }

  if (min !== undefined) normalized = Math.max(min, normalized)
  if (max !== undefined) normalized = Math.min(max, normalized)

  return Object.is(normalized, -0) ? 0 : normalized
}
