import { CheckIcon } from 'lucide-react'

import { type AnnotationColor, annotationColors, colorMap } from '@/annotation'
import type { AnnotationFilterValue, AnnotationNoteFilter } from '@/annotationFilter'
import { useTranslation } from '@/hooks/useTranslation'

import { Button } from '../ui/button'

interface AnnotationFilterFieldsProps {
  onChange: (value: AnnotationFilterValue) => void
  value: AnnotationFilterValue
}

export function AnnotationFilterFields({ onChange, value }: AnnotationFilterFieldsProps) {
  const t = useTranslation('annotation')
  const toggleColor = (color: AnnotationColor) => {
    const colors = new Set(value.colors)
    if (colors.has(color)) colors.delete(color)
    else colors.add(color)
    onChange({ ...value, colors })
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="text-muted-foreground px-1 font-medium">{t('colors')}</div>
      <div className="flex items-center justify-between px-1">
        {annotationColors.map((color) => (
          <button
            key={color}
            type="button"
            aria-label={color}
            aria-pressed={value.colors.has(color)}
            className="ring-offset-popover flex size-5 cursor-pointer items-center justify-center rounded-full ring-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-(--flow-accent)"
            onClick={() => toggleColor(color)}
          >
            <span
              className="flex size-3.5 items-center justify-center rounded-full"
              style={{ backgroundColor: colorMap[color] }}
            >
              {value.colors.has(color) && <CheckIcon className="size-2.5 text-white drop-shadow-sm" strokeWidth={3} />}
            </span>
          </button>
        ))}
      </div>
      <div className="text-muted-foreground mt-1 px-1 font-medium">{t('notes')}</div>
      <div className="grid grid-cols-3 gap-1">
        {(['all', 'with', 'without'] as AnnotationNoteFilter[]).map((notes) => (
          <Button
            key={notes}
            size="xs"
            type="button"
            variant={value.notes === notes ? 'secondary' : 'ghost'}
            onClick={() => onChange({ ...value, notes })}
          >
            {t(`notes_${notes}`)}
          </Button>
        ))}
      </div>
    </div>
  )
}
