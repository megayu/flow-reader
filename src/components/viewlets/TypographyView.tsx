import clsx from 'clsx'
import {
  CSSProperties,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import { MdAdd, MdRemove } from 'react-icons/md'

import { RenditionSpread } from '@flow/epubjs/types/rendition'
import { useTranslation } from '@flow/reader/hooks'
import { reader, useReaderSnapshot } from '@flow/reader/models'
import { TypographyConfiguration, useSettings } from '@flow/reader/state'

import { getBodyTypographyBaseline } from '../../styles'
import { Label, TextField, TextFieldProps } from '../Form'
import { PaneViewProps, PaneView } from '../base'

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

export const TypographyView: React.FC<PaneViewProps> = (props) => {
  const { focusedBookTab } = useReaderSnapshot()
  const [settings] = useSettings()
  const t = useTranslation('typography')

  const [localFonts, setLocalFonts] = useState<FontOption[]>()
  const localFontsRequestRef = useRef<Promise<FontOption[] | undefined>>()
  const bookTypography = focusedBookTab?.book.configuration?.typography
  const typography = bookTypography ?? {}

  const { fontFamily, fontSize, fontWeight, lineHeight, textIndent, zoom } =
    typography
  const globalSpread = settings.spread ?? RenditionSpread.Auto
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
    <PaneView {...props}>
      <div className="flex min-h-0 flex-1 flex-col text-on-surface-variant typescale-body-small">
        <div className="scroll min-h-0 flex-1">
          <div
            className="space-y-3 pl-4 pr-1.5 pt-2 pb-4"
            key={focusedBookTab?.id}
          >
            <SpreadField
              name={t('page_view')}
              value={bookTypography?.spread}
              inheritedValue={globalSpread}
              unsetOnSelected
              onChange={(value) => {
                setTypography('spread', value)
              }}
            />
            <TextAlignField
              name={t('text_align')}
              value={bookTypography?.textAlign}
              inheritedValue={globalTextAlign}
              unsetOnSelected
              onChange={(value) => {
                setTypography('textAlign', value)
              }}
            />
            <NumberField
              name={t('zoom')}
              min={1}
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
              step={0.5}
              value={textIndent}
              onChange={(v) => {
                setTypography('textIndent', v || undefined)
              }}
            />
          </div>
        </div>
      </div>
    </PaneView>
  )
}

async function querySystemFonts() {
  try {
    const { invoke } = await import('@tauri-apps/api/core')
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
      <Label name={name} />
      <div className="bg-default flex h-[31px] items-center p-0.5 text-on-surface-variant">
        {options.map((option) => {
          const selected = option.value === value
          const inherited =
            value === undefined && option.value === inheritedValue

          return (
            <button
              key={option.value ?? 'default'}
              type="button"
              className={clsx(
                'h-full flex-1 px-2 !text-[13px] typescale-body-medium',
                selected && 'bg-primary70 text-on-primary-container',
                inherited &&
                  'bg-on-surface-variant/10 ring-1 ring-inset ring-on-surface-variant/30',
              )}
              onClick={() =>
                onChange(selected && unsetOnSelected ? undefined : option.value)
              }
            >
              {option.label}
            </button>
          )
        })}
      </div>
    </div>
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
  const [inputValue, setInputValue] = useState(value)
  const [open, setOpen] = useState(false)
  const [popoverStyle, setPopoverStyle] = useState<CSSProperties>()
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setInputValue(value)
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

  useLayoutEffect(() => {
    if (!open) return

    updatePopoverPosition()
  }, [open, updatePopoverPosition])

  useEffect(() => {
    if (!open) return

    const handlePointerDown = (e: PointerEvent) => {
      const target = e.target as Node
      if (
        rootRef.current?.contains(target) ||
        popoverRef.current?.contains(target)
      ) {
        return
      }

      closePicker()
    }
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closePicker()
    }

    window.addEventListener('resize', updatePopoverPosition)
    window.addEventListener('scroll', updatePopoverPosition, true)
    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)

    return () => {
      window.removeEventListener('resize', updatePopoverPosition)
      window.removeEventListener('scroll', updatePopoverPosition, true)
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [closePicker, open, updatePopoverPosition])

  return (
    <div ref={rootRef}>
      <TextField
        as="input"
        name={name}
        value={inputValue}
        placeholder={t('default_value')}
        mRef={inputRef}
        onFocus={openPicker}
        onClick={openPicker}
        onChange={(e) => {
          const nextValue = e.target.value
          setInputValue(nextValue)
          onChange(nextValue)
          setOpen(true)
          loadOptions()
        }}
        onClear={() => {
          setInputValue('')
          onChange('')
          closePicker()
        }}
      />
      {open &&
        popoverStyle &&
        createPortal(
          <div
            data-flow-keyboard-capture="true"
            ref={popoverRef}
            className="fixed z-[100] overflow-y-auto overflow-x-hidden bg-surface py-1 text-on-surface shadow-1 ring-1 ring-inset ring-surface-variant"
            style={popoverStyle}
          >
            {filteredOptions.map((option) => (
              <button
                key={option.family}
                type="button"
                className={clsx(
                  'block min-h-[36px] w-full whitespace-nowrap px-3 py-1.5 text-left !text-[14px] leading-5 hover:bg-outline/10',
                  option.family === value && 'bg-outline/10',
                )}
                style={{
                  fontFamily: option.family,
                  fontSize: 14,
                  lineHeight: '20px',
                }}
                onMouseDown={(e) => {
                  e.preventDefault()
                }}
                onClick={() => {
                  setInputValue(option.family)
                  onChange(option.family)
                  closePicker()
                  inputRef.current?.focus()
                }}
              >
                {option.label}
              </button>
            ))}
            {!filteredOptions.length && (
              <div className="px-5 py-3 text-outline typescale-body-medium">
                {t('no_matching_fonts')}
              </div>
            )}
          </div>,
          document.body,
        )}
    </div>
  )
}

interface NumberFieldProps
  extends Omit<TextFieldProps<'input'>, 'onChange' | 'value' | 'defaultValue'> {
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
  const actionT = useTranslation('action')
  const typographyT = useTranslation('typography')

  useEffect(() => {
    if (!ref.current) return
    ref.current.value = value === undefined ? '' : String(value)
  }, [value])

  const step = (direction: -1 | 1) => {
    if (!ref.current) return

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
    <TextField
      as="input"
      type="number"
      placeholder={typographyT('default_value')}
      actions={[
        {
          title: actionT('step_down'),
          Icon: MdRemove,
          onClick: () => {
            step(-1)
          },
        },
        {
          title: actionT('step_up'),
          Icon: MdAdd,
          onClick: () => {
            step(1)
          },
        },
      ]}
      mRef={ref}
      defaultValue={value}
      // lazy render
      onBlur={(e) => {
        onChange(e.target.value === '' ? undefined : Number(e.target.value))
      }}
      onClear={() => {
        if (ref.current) ref.current.value = ''
        onChange(undefined)
      }}
      {...props}
    />
  )
}
