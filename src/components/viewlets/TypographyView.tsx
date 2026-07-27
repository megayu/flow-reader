import { invoke } from '@tauri-apps/api/core'
import clsx from 'clsx'
import { MinusIcon, PlusIcon, XIcon } from 'lucide-react'
import {
  ComponentProps,
  CSSProperties,
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'

import { RenditionSpread } from '@flow/epubjs/types/rendition'
import { useTranslation } from '@flow/reader/hooks/useTranslation'
import { reader, useReaderSnapshot } from '@flow/reader/models/reader'
import { resolveBookSpreadPolicy } from '@flow/reader/readerSpreadPolicy'
import {
  PageAppearance,
  TypographyConfiguration,
  useSettings,
} from '@flow/reader/state'

import { getBodyTypographyBaseline } from '../../styles'
import { IconButton } from '../Button'
import { PaneView, PaneViewProps } from '../base/PaneView'
import { Button as UiButton } from '../ui/button'
import { Input } from '../ui/input'

type TextAlignOption = NonNullable<TypographyConfiguration['textAlign']>

interface FontOption {
  family: string
  label: string
  searchText: string
}

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

  const [localFonts, setLocalFonts] = useState<FontOption[]>()
  const localFontsRequestRef = useRef<
    Promise<FontOption[] | undefined> | undefined
  >(undefined)
  const bookTypography = focusedBookTab?.book.configuration?.typography
  const typography = bookTypography ?? {}
  const isScrolledDocument = focusedBookTab?.isScrolledDocument ?? false

  const { fontFamily, fontSize, fontWeight, lineHeight, textIndent, zoom } =
    typography
  const globalSpread = settings.spread ?? RenditionSpread.Auto
  const inheritedSpread = resolveBookSpreadPolicy({
    publicationSpread: focusedBookTab?.book.metadata.spread,
    applicationDefault: globalSpread,
  })
  const globalTextAlign: TextAlignOption = settings.textAlign ?? 'default'

  const setTypography = useCallback(
    <K extends keyof TypographyConfiguration>(
      k: K,
      v: TypographyConfiguration[K],
    ) => {
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

      tab.updateBook({
        configuration: {
          ...tab.book.configuration,
          typography,
        },
      })
    },
    [],
  )

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
        <div
          className="space-y-3 pt-2 pr-1.5 pb-4 pl-4"
          key={focusedBookTab?.id}
        >
          <fieldset
            className="m-0 min-w-0 border-0 p-0"
            disabled={isScrolledDocument}
          >
            <SpreadField
              name={t('page_view')}
              value={
                isScrolledDocument
                  ? RenditionSpread.None
                  : bookTypography?.spread
              }
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
            value={fontSize ? parseInt(fontSize) : undefined}
            baseValue={() => getCurrentBodyBaseline().fontSize}
            onChange={(v) => {
              setTypography('fontSize', v ? v + 'px' : undefined)
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
  const unique = new Map<string, FontOption>()

  fonts.forEach(({ family, label }) => {
    const normalizedFamily = family.trim()
    const normalizedLabel = cleanFontLabel(label.trim() || normalizedFamily)
    if (!normalizedFamily) return

    const key = fontOptionKey(normalizedLabel || normalizedFamily)
    if (unique.has(key)) return

    unique.set(key, {
      family: normalizedFamily,
      label: normalizedLabel || normalizedFamily,
      searchText: `${normalizedFamily} ${normalizedLabel} ${key}`.toLowerCase(),
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
    .replace(
      /\b(?:bold|italic|oblique|regular|medium|light|semibold|semi bold|semilight|semi light|black)\b/g,
      '',
    )
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
      <div className="text-muted-foreground ring-border bg-background flex h-8 items-center overflow-hidden rounded-lg p-0.5 ring-1 ring-inset">
        {options.map((option) => {
          const selected = option.value === value
          const inherited =
            value === undefined && option.value === inheritedValue

          return (
            <UiButton
              key={option.value ?? 'default'}
              type="button"
              variant={selected ? 'default' : 'ghost'}
              size="sm"
              className={clsx(
                'h-full flex-1 rounded-lg px-2 text-base leading-none',
                selected || 'text-muted-foreground',
                inherited &&
                  !selected &&
                  'bg-muted ring-border ring-1 ring-inset',
              )}
              onClick={() =>
                onChange(selected && unsetOnSelected ? undefined : option.value)
              }
            >
              {option.label}
            </UiButton>
          )
        })}
      </div>
    </div>
  )
}

const FieldLabel: React.FC<{ name: string }> = ({ name }) => {
  return (
    <label
      htmlFor={name}
      className="text-muted-foreground mb-1 block text-base font-medium"
    >
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

const SpreadField: React.FC<SpreadFieldProps> = ({
  name,
  value,
  inheritedValue,
  unsetOnSelected,
  onChange,
}) => {
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

const TextAlignField: React.FC<TextAlignFieldProps> = ({
  name,
  value,
  inheritedValue,
  unsetOnSelected,
  onChange,
}) => {
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

const PageAppearanceField: React.FC<PageAppearanceFieldProps> = ({
  name,
  value,
  onChange,
}) => {
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
  options: FontOption[]
  loadOptions: () => Promise<FontOption[] | undefined>
  onChange: (value: string) => void
}

const FontField: React.FC<FontFieldProps> = ({
  name,
  value,
  options,
  loadOptions,
  onChange,
}) => {
  const t = useTranslation('typography')
  const actionT = useTranslation('action')
  const [inputValue, setInputValue] = useState(value)
  const [open, setOpen] = useState(false)
  const [popoverStyle, setPopoverStyle] = useState<CSSProperties>()
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const editingRef = useRef(false)
  const editStartValueRef = useRef(value)

  useEffect(() => {
    if (!editingRef.current) setInputValue(value)
  }, [value])

  const query = inputValue.trim().toLowerCase()
  const filteredOptions = useMemo(() => {
    if (!query) return options

    const keywords = query.split(/\s+/).filter(Boolean)
    return options.filter((option) =>
      keywords.every((keyword) => option.searchText.includes(keyword)),
    )
  }, [options, query])

  const openPicker = useCallback(() => {
    setOpen(true)
    loadOptions()
  }, [loadOptions])

  const closePicker = useCallback(() => {
    setOpen(false)
  }, [])
  const handleDocumentPointerDown = useEffectEvent((e: PointerEvent) => {
    const target = e.target as Node
    if (
      rootRef.current?.contains(target) ||
      popoverRef.current?.contains(target)
    ) {
      return
    }

    closePicker()
  })
  const handleDocumentKeyDown = useEffectEvent((e: KeyboardEvent) => {
    if (e.key === 'Escape' && e.target !== inputRef.current) closePicker()
  })

  const finishEditing = useCallback(
    (nextValue: string) => {
      editingRef.current = false
      editStartValueRef.current = nextValue
      setInputValue(nextValue)
      if (nextValue !== value) onChange(nextValue)
    },
    [onChange, value],
  )

  const estimatedPopoverWidth = useMemo(() => {
    const longestLabel = filteredOptions.reduce(
      (longest, option) =>
        option.label.length > longest.length ? option.label : longest,
      '',
    )
    const estimatedTextWidth = Array.from(longestLabel).reduce((width, ch) => {
      if (/[\u3400-\u9fff\uf900-\ufaff]/.test(ch)) return width + 15
      if (/[A-Z0-9]/.test(ch)) return width + 8
      if (/\s/.test(ch)) return width + 4
      return width + 7
    }, 0)

    return estimatedTextWidth + 34
  }, [filteredOptions])

  const updatePopoverPosition = useCallback(() => {
    const root = rootRef.current
    if (!root) return

    const rect = root.getBoundingClientRect()
    const viewportWidth = window.innerWidth
    const viewportHeight = window.innerHeight
    const margin = 8
    const itemHeight = 36
    const contentHeight = Math.max(filteredOptions.length, 1) * itemHeight + 8
    const hasQuery = !!query
    const rightSpace = viewportWidth - rect.right - margin
    const maxAvailableWidth = viewportWidth - margin * 2
    const desiredWidth = Math.min(
      Math.max(rect.width, 280, estimatedPopoverWidth),
      Math.min(560, maxAvailableWidth),
    )
    const preferSide = !hasQuery && rightSpace >= desiredWidth
    const width = preferSide
      ? Math.min(desiredWidth, rightSpace - margin)
      : desiredWidth

    if (preferSide) {
      const top = Math.max(
        margin,
        Math.min(rect.top - 6, viewportHeight - margin - contentHeight),
      )
      setPopoverStyle({
        left: rect.right + margin,
        top,
        width,
        maxHeight: viewportHeight - top - margin,
      })
      return
    }

    const belowTop = rect.bottom + margin
    const belowSpace = viewportHeight - belowTop - margin
    const aboveSpace = rect.top - margin * 2
    const showAbove =
      belowSpace < Math.min(contentHeight, 180) && aboveSpace > belowSpace
    const maxHeight = showAbove ? aboveSpace : belowSpace
    const height = Math.min(contentHeight, maxHeight)

    setPopoverStyle({
      left: Math.min(
        viewportWidth - width - margin,
        Math.max(margin, rect.right - width),
      ),
      top: showAbove ? rect.top - margin - height : belowTop,
      width,
      maxHeight: Math.max(120, maxHeight),
    })
  }, [estimatedPopoverWidth, filteredOptions.length, query])
  const handlePopoverPositionUpdate = useEffectEvent(() => {
    updatePopoverPosition()
  })

  useLayoutEffect(() => {
    if (!open) return

    updatePopoverPosition()
  }, [open, updatePopoverPosition])

  useEffect(() => {
    if (!open) return

    const handlePointerDown = (e: PointerEvent) => {
      handleDocumentPointerDown(e)
    }
    const handleKeyDown = (e: KeyboardEvent) => {
      handleDocumentKeyDown(e)
    }
    const handleResizeOrScroll = () => {
      handlePopoverPositionUpdate()
    }

    window.addEventListener('resize', handleResizeOrScroll)
    window.addEventListener('scroll', handleResizeOrScroll, true)
    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)

    return () => {
      window.removeEventListener('resize', handleResizeOrScroll)
      window.removeEventListener('scroll', handleResizeOrScroll, true)
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  return (
    <div ref={rootRef}>
      <div className="flex flex-col">
        <FieldLabel name={name} />
        <div className="border-input bg-background focus-within:border-ring focus-within:ring-ring/50 flex h-8 items-center rounded-lg border transition-colors focus-within:ring-3">
          <Input
            ref={inputRef}
            name={name}
            id={name}
            value={inputValue}
            placeholder={t('default_value')}
            className="h-full flex-1 rounded-none border-0 bg-transparent px-2.5 py-0 leading-none focus-visible:border-transparent focus-visible:ring-0"
            onFocus={() => {
              if (!editingRef.current) {
                editingRef.current = true
                editStartValueRef.current = value
              }
              openPicker()
            }}
            onClick={openPicker}
            onChange={(e) => {
              const nextValue = e.target.value
              setInputValue(nextValue)
              setOpen(true)
              loadOptions()
            }}
            onBlur={(e) => {
              if (!editingRef.current) return
              finishEditing(e.currentTarget.value)
              closePicker()
            }}
            onKeyDown={(e) => {
              if (
                e.key !== 'Escape' ||
                e.nativeEvent.isComposing ||
                !editingRef.current
              ) {
                return
              }

              e.preventDefault()
              e.stopPropagation()
              const restoredValue = editStartValueRef.current
              e.currentTarget.value = restoredValue
              setInputValue(restoredValue)
              e.currentTarget.setSelectionRange(
                restoredValue.length,
                restoredValue.length,
              )
            }}
          />
          {inputValue && (
            <div className="flex shrink-0 items-center pr-1">
              <IconButton
                className="text-muted-foreground"
                title={actionT('clear')}
                Icon={XIcon}
                onMouseDown={(e) => {
                  e.preventDefault()
                }}
                onClick={() => {
                  finishEditing('')
                  closePicker()
                  inputRef.current?.blur()
                }}
              />
            </div>
          )}
        </div>
      </div>
      {open &&
        popoverStyle &&
        createPortal(
          <div
            data-flow-keyboard-capture="true"
            ref={popoverRef}
            className="bg-popover text-popover-foreground ring-border fixed z-[100] overflow-x-hidden overflow-y-auto rounded-lg p-1 shadow-lg ring-1"
            style={popoverStyle}
          >
            {filteredOptions.map((option) => (
              <button
                key={option.family}
                type="button"
                className={clsx(
                  'hover:bg-muted block min-h-[36px] w-full rounded-md px-3 py-1.5 text-left text-base leading-5 whitespace-nowrap',
                  option.family === value && 'bg-muted',
                )}
                style={{
                  fontFamily: option.family,
                  lineHeight: '20px',
                }}
                onMouseDown={(e) => {
                  e.preventDefault()
                }}
                onClick={() => {
                  finishEditing(option.family)
                  closePicker()
                  inputRef.current?.blur()
                }}
              >
                {option.label}
              </button>
            ))}
            {!filteredOptions.length && (
              <div className="text-muted-foreground px-5 py-3 text-base">
                {t('no_matching_fonts')}
              </div>
            )}
          </div>,
          document.body,
        )}
    </div>
  )
}

interface NumberFieldProps extends Omit<
  ComponentProps<'input'>,
  'onChange' | 'value' | 'defaultValue'
> {
  value?: number
  baseValue?: () => number | undefined
  onChange: (v?: number) => void
}
const NumberField: React.FC<NumberFieldProps> = ({
  value,
  baseValue,
  onChange,
  ...props
}) => {
  const ref = useRef<HTMLInputElement>(null)
  const editStartValueRef = useRef<string | undefined>(undefined)
  const actionT = useTranslation('action')
  const typographyT = useTranslation('typography')
  const min = parseNumberInputProp(props.min)
  const max = parseNumberInputProp(props.max)
  const stepDownDisabled =
    value !== undefined && min !== undefined && value <= min
  const stepUpDisabled =
    value !== undefined && max !== undefined && value >= max

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
      <div className="border-input bg-background focus-within:border-ring focus-within:ring-ring/50 flex h-8 items-center rounded-lg border transition-colors focus-within:ring-3">
        <Input
          ref={ref}
          type="number"
          id={typeof props.name === 'string' ? props.name : undefined}
          placeholder={typographyT('default_value')}
          defaultValue={value}
          className="h-full flex-1 rounded-none border-0 bg-transparent px-2.5 py-0 leading-none focus-visible:border-transparent focus-visible:ring-0"
          // lazy render
          onFocus={(e) => {
            editStartValueRef.current = e.currentTarget.value
          }}
          onBlur={(e) => {
            const normalized = normalizeNumberFieldValue(e.target.value, {
              min: props.min,
              max: props.max,
              step: props.step,
            })
            e.target.value = normalized === undefined ? '' : String(normalized)
            editStartValueRef.current = undefined
            onChange(normalized)
          }}
          onKeyDown={(e) => {
            if (
              e.key !== 'Escape' ||
              e.nativeEvent.isComposing ||
              editStartValueRef.current === undefined
            ) {
              return
            }

            e.preventDefault()
            e.stopPropagation()
            e.currentTarget.value = editStartValueRef.current
          }}
          {...props}
        />
        <div className="flex shrink-0 items-center gap-0.5 pr-1">
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
          <span
            aria-hidden={value === undefined}
            className="flex size-6 items-center justify-center"
          >
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
        </div>
      </div>
    </div>
  )
}

function parseNumberInputProp(value: string | number | undefined) {
  if (typeof value === 'number')
    return Number.isFinite(value) ? value : undefined
  if (typeof value !== 'string') return undefined

  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function normalizeNumberFieldValue(
  input: string,
  constraints: Pick<ComponentProps<'input'>, 'min' | 'max' | 'step'>,
) {
  if (input === '') return undefined

  const parsed = Number(input)
  if (!Number.isFinite(parsed)) return undefined

  const min = parseNumberInputProp(constraints.min)
  const max = parseNumberInputProp(constraints.max)
  const step =
    constraints.step === 'any'
      ? undefined
      : (parseNumberInputProp(constraints.step) ?? 1)
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
