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
import {
  defaultSettings,
  TypographyConfiguration,
  useSettings,
} from '@flow/reader/state'
import { keys } from '@flow/reader/utils'

import { Select, TextField, TextFieldProps } from '../Form'
import { PaneViewProps, PaneView, Pane } from '../base'

enum TypographyScope {
  Book,
  Global,
}

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
  const [settings, setSettings] = useSettings()
  const [scope, setScope] = useState(TypographyScope.Book)
  const t = useTranslation('typography')

  const [localFonts, setLocalFonts] = useState<FontOption[]>()
  const localFontsRequestRef = useRef<Promise<FontOption[] | undefined>>()

  const { fontFamily, fontSize, fontWeight, lineHeight, zoom, spread } =
    scope === TypographyScope.Book
      ? focusedBookTab?.book.configuration?.typography ?? defaultSettings
      : settings

  const setTypography = useCallback(
    <K extends keyof TypographyConfiguration>(
      k: K,
      v: TypographyConfiguration[K],
    ) => {
      if (scope === TypographyScope.Book) {
        reader.focusedBookTab?.updateBook({
          configuration: {
            ...reader.focusedBookTab.book.configuration,
            typography: {
              ...reader.focusedBookTab.book.configuration?.typography,
              [k]: v,
            },
          },
        })
      } else {
        setSettings((prev) => ({
          ...prev,
          [k]: v,
        }))
      }
    },
    [scope, setSettings],
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

  return (
    <PaneView {...props}>
      <div className="flex gap-2 px-5 pb-2 !text-[13px] typescale-body-medium">
        {keys(TypographyScope)
          .filter((k) => isNaN(Number(k)))
          .map((scopeName) => (
            <button
              key={scopeName}
              className={clsx(
                TypographyScope[scopeName] === scope
                  ? 'text-on-surface-variant'
                  : 'text-outline/60',
              )}
              onClick={() => setScope(TypographyScope[scopeName])}
            >
              {t(`scope.${scopeName.toLowerCase()}`)}
            </button>
          ))}
      </div>
      <Pane
        headline={t('title')}
        className="space-y-3 px-5 pt-2 pb-4"
        key={`${scope}${focusedBookTab?.id}`}
      >
        <Select
          name={t('page_view')}
          value={spread ?? RenditionSpread.Auto}
          onChange={(e) => {
            setTypography('spread', e.target.value as RenditionSpread)
          }}
        >
          <option value={RenditionSpread.None}>
            {t('page_view.single_page')}
          </option>
          <option value={RenditionSpread.Auto}>
            {t('page_view.double_page')}
          </option>
        </Select>
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
          defaultValue={fontSize && parseInt(fontSize)}
          onChange={(v) => {
            setTypography('fontSize', v ? v + 'px' : undefined)
          }}
        />
        <NumberField
          name={t('font_weight')}
          min={100}
          max={900}
          step={100}
          defaultValue={fontWeight}
          onChange={(v) => {
            setTypography('fontWeight', v || undefined)
          }}
        />
        <NumberField
          name={t('line_height')}
          min={1}
          step={0.1}
          defaultValue={lineHeight}
          onChange={(v) => {
            setTypography('lineHeight', v || undefined)
          }}
        />
        <NumberField
          name={t('zoom')}
          min={1}
          step={0.1}
          defaultValue={zoom}
          onChange={(v) => {
            setTypography('zoom', v || undefined)
          }}
        />
      </Pane>
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
        placeholder="default"
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
                没有匹配字体
              </div>
            )}
          </div>,
          document.body,
        )}
    </div>
  )
}

interface NumberFieldProps extends Omit<TextFieldProps<'input'>, 'onChange'> {
  onChange: (v?: number) => void
}
const NumberField: React.FC<NumberFieldProps> = ({ onChange, ...props }) => {
  const ref = useRef<HTMLInputElement>(null)
  const t = useTranslation('action')

  return (
    <TextField
      as="input"
      type="number"
      placeholder="default"
      actions={[
        {
          title: t('step_down'),
          Icon: MdRemove,
          onClick: () => {
            if (!ref.current) return
            ref.current.stepDown()
            onChange(Number(ref.current.value))
          },
        },
        {
          title: t('step_up'),
          Icon: MdAdd,
          onClick: () => {
            if (!ref.current) return
            ref.current.stepUp()
            onChange(Number(ref.current.value))
          },
        },
      ]}
      mRef={ref}
      // lazy render
      onBlur={(e) => {
        onChange(Number(e.target.value))
      }}
      onClear={() => {
        if (ref.current) ref.current.value = ''
        onChange(undefined)
      }}
      {...props}
    />
  )
}
