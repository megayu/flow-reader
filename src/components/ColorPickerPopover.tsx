import clsx from 'clsx'
import { ClipboardPasteIcon, CopyIcon } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { HexColorPicker } from 'react-colorful'

import { normalizeHexColor } from '../color'
import { useTranslation } from '../hooks/useTranslation'
import { copy } from '../utils'

import { IconButton } from './IconButton'
import { Button } from './ui/button'

const colorSlotCount = 9

interface ColorPickerPopoverProps {
  className?: string
  defaultValue: string
  value: string
  onApply: (color: string) => void
  onCancel: () => void
  onPreview: (color: string) => void
}

export const ColorPickerPopover: React.FC<ColorPickerPopoverProps> = ({
  className,
  defaultValue,
  value,
  onApply,
  onCancel,
  onPreview,
}) => {
  const initialColorRef = useRef(normalizeHexColor(value) ?? defaultValue)
  const normalizedDefault = normalizeHexColor(defaultValue) ?? '#0ea5e9'
  const [draft, setDraft] = useState(initialColorRef.current)
  const [input, setInput] = useState(initialColorRef.current)
  const [slots, setSlots] = useState<(string | undefined)[]>(() => Array.from({ length: colorSlotCount }))
  const t = useTranslation('color_picker')

  const slotItems = useMemo(
    () =>
      Array.from({ length: colorSlotCount }, (_, index) => ({
        id: `slot-${index}`,
        color: slots[index],
      })),
    [slots],
  )
  const updateDraft = (color: string) => {
    const normalized = normalizeHexColor(color)
    if (!normalized) return

    setDraft(normalized)
    setInput(normalized)
    onPreview(normalized)
  }

  const saveDraftToSlot = () => {
    setSlots((prev) => {
      const next = Array.from({ length: colorSlotCount }, (_, i) => prev[i])
      const filledColors = next.filter(Boolean)
      if (filledColors.includes(draft)) return next

      const emptyIndex = next.findIndex((color) => !color)
      if (emptyIndex >= 0) {
        next[emptyIndex] = draft
        return next
      }

      return next
    })
  }

  return (
    <div
      className={clsx(
        'text-muted-foreground ring-border bg-background w-72 rounded-lg p-3 shadow-lg ring-1 ring-inset',
        className,
      )}
      onClick={(e) => e.stopPropagation()}
    >
      <HexColorPicker color={draft} onChange={updateDraft} className="h-36! w-full!" />
      <div className="mt-3 flex items-center gap-2">
        <div className="ring-border h-8 w-8 shrink-0 rounded-sm ring-1 ring-inset" style={{ backgroundColor: draft }} />
        <input
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          value={input}
          spellCheck={false}
          className="textfield text-muted-foreground h-8 min-w-0 flex-1 bg-transparent px-2 font-mono text-base"
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => {
            const next = e.target.value
            setInput(next)

            const normalized = normalizeHexColor(next)
            if (!normalized) return

            setDraft(normalized)
            onPreview(normalized)
          }}
          onBlur={() => setInput(draft)}
        />
        <IconButton
          title={t('copy')}
          Icon={CopyIcon}
          className="text-muted-foreground"
          onClick={() => {
            copy(draft).catch(() => undefined)
          }}
        />
        <IconButton
          title={t('paste')}
          Icon={ClipboardPasteIcon}
          className="text-muted-foreground"
          onClick={() => {
            navigator.clipboard
              ?.readText()
              .then(updateDraft)
              .catch(() => undefined)
          }}
        />
      </div>
      <div className="mt-3 grid grid-cols-9 gap-1">
        {slotItems.map(({ id, color }) => (
          <button
            type="button"
            key={id}
            aria-label={color ? color : t('save_slot')}
            className="bg-popover ring-border h-6 rounded-sm ring-1 ring-inset"
            style={color ? { backgroundColor: color } : undefined}
            onClick={() => {
              if (color) {
                updateDraft(color)
              } else {
                saveDraftToSlot()
              }
            }}
          />
        ))}
      </div>
      <div className="mt-3 flex items-center justify-between gap-2">
        <Button variant="secondary" size="sm" onClick={saveDraftToSlot}>
          {t('save_slot')}
        </Button>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={() => updateDraft(normalizedDefault)}>
            {t('reset')}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              onPreview(initialColorRef.current)
              onCancel()
            }}
          >
            {t('cancel')}
          </Button>
          <Button size="sm" onClick={() => onApply(draft)}>
            {t('apply')}
          </Button>
        </div>
      </div>
    </div>
  )
}
