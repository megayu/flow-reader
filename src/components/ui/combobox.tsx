'use client'

import clsx from 'clsx'
import { XIcon } from 'lucide-react'
import {
  type ComponentProps,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

import { createTextSearchQuery, matchesTextSearch, type TextSearchIndex } from '@/search/textSearch'

import { IconButton } from '../IconButton'

import { InputGroup, InputGroupActions, InputGroupInput } from './input-group'
import { Popover, PopoverAnchor, PopoverContent } from './popover'

interface ComboboxOption {
  label: string
  searchIndex?: TextSearchIndex
  searchText?: string
  value: string
}

interface ComboboxProps {
  align?: ComponentProps<typeof PopoverContent>['align']
  clearLabel: string
  collisionPadding?: ComponentProps<typeof PopoverContent>['collisionPadding']
  contentClassName?: string
  emptyContent: ReactNode
  id: string
  name: string
  onLoadOptions?: () => unknown
  onValueChange: (value: string) => void
  options: readonly ComboboxOption[]
  placeholder?: string
  renderOption?: (option: ComboboxOption) => ReactNode
  side?: ComponentProps<typeof PopoverContent>['side']
  sideOffset?: number
  value: string
}

function Combobox({
  align = 'center',
  clearLabel,
  collisionPadding,
  contentClassName,
  emptyContent,
  id,
  name,
  onLoadOptions,
  onValueChange,
  options,
  placeholder,
  renderOption = (option) => option.label,
  side = 'bottom',
  sideOffset = 4,
  value,
}: ComboboxProps) {
  const listId = useId()
  const [inputValue, setInputValue] = useState(value)
  const [open, setOpen] = useState(false)
  const [contentWidth, setContentWidth] = useState<number>()
  const [activeIndex, setActiveIndex] = useState(-1)
  const [filtering, setFiltering] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const anchorRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const scrollFrameRef = useRef(0)
  const editingRef = useRef(false)

  useEffect(() => {
    if (!editingRef.current) setInputValue(value)
  }, [value])

  const query = useMemo(() => createTextSearchQuery(inputValue), [inputValue])
  const filteredOptions = useMemo(() => {
    if (!filtering || !query.length) return options

    return options.filter((option) => {
      const searchIndex = option.searchIndex ?? [(option.searchText ?? `${option.value} ${option.label}`).toLowerCase()]
      return matchesTextSearch(searchIndex, query)
    })
  }, [filtering, options, query])

  const activeOption = activeIndex >= 0 ? filteredOptions[activeIndex] : undefined

  useEffect(() => {
    if (!open || filtering) return

    const selectedIndex = value ? options.findIndex((option) => option.value === value) : -1
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : options.length ? 0 : -1)
  }, [filtering, open, options, value])

  const scrollActiveOptionIntoView = useCallback((element: HTMLButtonElement | null) => {
    if (scrollFrameRef.current) {
      window.cancelAnimationFrame(scrollFrameRef.current)
      scrollFrameRef.current = 0
    }
    if (!element) return

    const scroll = () => {
      if (element.isConnected) element.scrollIntoView({ block: 'nearest' })
    }
    const content = element.closest<HTMLElement>('[data-slot="combobox-content"]')
    if (content && content.clientHeight < content.scrollHeight) {
      scroll()
      return
    }

    // Radix initially mounts popover content offscreen at its full height; wait for collision sizing before scrolling.
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = 0
      scroll()
    })
  }, [])

  const openPicker = useCallback(() => {
    setOpen(true)
    void onLoadOptions?.()
  }, [onLoadOptions])

  const closePicker = useCallback(() => {
    setOpen(false)
    setActiveIndex(-1)
  }, [])

  const finishEditing = useCallback(
    (nextValue: string) => {
      editingRef.current = false
      setInputValue(nextValue)
      if (nextValue !== value) onValueChange(nextValue)
    },
    [onValueChange, value],
  )

  const selectOption = useCallback(
    (option: ComboboxOption) => {
      finishEditing(option.value)
      closePicker()
      inputRef.current?.blur()
    },
    [closePicker, finishEditing],
  )

  const moveActiveOption = useCallback(
    (direction: 1 | -1) => {
      if (!filteredOptions.length) return

      setActiveIndex((current) => {
        if (current < 0 || current >= filteredOptions.length) {
          return direction === 1 ? 0 : filteredOptions.length - 1
        }
        return (current + direction + filteredOptions.length) % filteredOptions.length
      })
    },
    [filteredOptions.length],
  )

  const estimatedContentWidth = useMemo(() => {
    const longestLabel = filteredOptions.reduce(
      (longest, option) => (option.label.length > longest.length ? option.label : longest),
      '',
    )
    const estimatedTextWidth = Array.from(longestLabel).reduce((width, character) => {
      if (/[\u3400-\u9fff\uf900-\ufaff]/.test(character)) return width + 15
      if (/[A-Z0-9]/.test(character)) return width + 8
      if (/\s/.test(character)) return width + 4
      return width + 7
    }, 0)

    return estimatedTextWidth + 34
  }, [filteredOptions])

  const updateContentWidth = useCallback(() => {
    const anchor = anchorRef.current
    if (!anchor) return

    const rect = anchor.getBoundingClientRect()
    const viewportMargin = 8
    const maxAvailableWidth = window.innerWidth - viewportMargin * 2
    const desiredWidth = Math.min(Math.max(rect.width, 280, estimatedContentWidth), Math.min(560, maxAvailableWidth))

    setContentWidth(desiredWidth)
  }, [estimatedContentWidth])

  useLayoutEffect(() => {
    if (open) updateContentWidth()
  }, [open, updateContentWidth])

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen)
        if (!nextOpen) setActiveIndex(-1)
      }}
    >
      <div ref={rootRef}>
        <PopoverAnchor asChild>
          <InputGroup ref={anchorRef}>
            <InputGroupInput
              ref={inputRef}
              name={name}
              id={id}
              role="combobox"
              aria-autocomplete="list"
              aria-controls={listId}
              aria-expanded={open}
              aria-activedescendant={activeOption ? `${listId}-${activeIndex}` : undefined}
              value={inputValue}
              placeholder={placeholder}
              onFocus={() => {
                if (!editingRef.current) {
                  editingRef.current = true
                }
                setFiltering(false)
                openPicker()
              }}
              onClick={openPicker}
              onValueChange={(nextValue) => {
                setInputValue(nextValue)
                setFiltering(nextValue !== value)
                setActiveIndex(-1)
                openPicker()
              }}
              onBlur={() => {
                if (!editingRef.current) return
                editingRef.current = false
                setInputValue(value)
                setFiltering(false)
                closePicker()
              }}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return

                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  event.preventDefault()
                  event.stopPropagation()
                  openPicker()
                  moveActiveOption(event.key === 'ArrowDown' ? 1 : -1)
                  return
                }

                if (event.key === 'Enter' && activeOption) {
                  event.preventDefault()
                  event.stopPropagation()
                  selectOption(activeOption)
                }
              }}
            />
            <InputGroupActions>
              <IconButton
                className="text-muted-foreground"
                title={clearLabel}
                Icon={XIcon}
                disabled={!inputValue}
                onMouseDown={(event) => {
                  event.preventDefault()
                }}
                onClick={() => {
                  finishEditing('')
                  closePicker()
                  inputRef.current?.blur()
                }}
              />
            </InputGroupActions>
          </InputGroup>
        </PopoverAnchor>
      </div>
      {contentWidth && (
        <PopoverContent
          id={listId}
          role="listbox"
          data-slot="combobox-content"
          data-flow-keyboard-capture="true"
          side={side}
          align={align}
          sideOffset={sideOffset}
          collisionPadding={collisionPadding}
          className={clsx(
            'z-100 block max-h-(--radix-popover-content-available-height) w-auto gap-0 overflow-x-hidden overflow-y-auto rounded-lg p-1 shadow-lg ring-(--flow-border)',
            contentClassName,
          )}
          style={{ width: contentWidth }}
          onOpenAutoFocus={(event) => event.preventDefault()}
          onInteractOutside={(event) => {
            if (rootRef.current?.contains(event.target as Node)) event.preventDefault()
          }}
          onEscapeKeyDown={(event) => {
            if (event.target === inputRef.current) event.preventDefault()
          }}
        >
          {filteredOptions.map((option, index) => {
            const active = index === activeIndex
            return (
              <button
                key={option.value}
                ref={active ? scrollActiveOptionIntoView : undefined}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={option.value === value}
                type="button"
                className={clsx(
                  'hover:bg-muted block min-h-9 w-full rounded-md px-3 py-1.5 text-left text-base leading-5 whitespace-nowrap',
                  (active || option.value === value) && 'bg-muted',
                )}
                onMouseDown={(event) => {
                  event.preventDefault()
                }}
                onMouseEnter={() => {
                  setActiveIndex(index)
                }}
                onClick={() => {
                  selectOption(option)
                }}
              >
                {renderOption(option)}
              </button>
            )
          })}
          {!filteredOptions.length && <div className="text-muted-foreground px-5 py-3 text-base">{emptyContent}</div>}
        </PopoverContent>
      )}
    </Popover>
  )
}

export {
  Combobox,
  // biome-ignore lint/style/useComponentExportOnlyModules: Type exports do not exist at runtime and cannot invalidate Fast Refresh.
  type ComboboxOption,
}
