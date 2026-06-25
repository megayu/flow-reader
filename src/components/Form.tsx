import clsx from 'clsx'
import { CheckIcon, type LucideIcon, XIcon } from 'lucide-react'
import {
  ElementType,
  useRef,
  useEffect,
  useId,
  RefObject,
  ComponentProps,
} from 'react'
import { PolymorphicPropsWithoutRef } from 'react-polymorphic-types'

import { useTranslation } from '../hooks/useTranslation'

import { IconButton } from './Button'

type TextFieldElement = HTMLInputElement | HTMLTextAreaElement

type Action = {
  title: string
  Icon: LucideIcon
  onClick: (el: TextFieldElement | null) => void
}

export type TextFieldProps<T extends ElementType> = PolymorphicPropsWithoutRef<
  {
    name: string
    hideLabel?: boolean
    autoFocus?: boolean
    actions?: Action[]
    datalist?: React.ReactNode[]
    hideDatalistIndicator?: boolean
    onClear?: () => void
    // https://react-typescript-cheatsheet.netlify.app/docs/basic/getting-started/forward_and_create_ref/#generic-forwardrefs
    mRef?: RefObject<TextFieldElement | null> | null
  },
  T
>
export function TextField<T extends ElementType = 'input'>({
  name,
  as,
  className,
  hideLabel = false,
  autoFocus,
  actions = [],
  datalist,
  hideDatalistIndicator = false,
  onClear,
  mRef: outerRef,
  ...props
}: TextFieldProps<T>) {
  const Component = (as || 'input') as ElementType<any>
  const isInput = Component === 'input'
  const innerRef = useRef<TextFieldElement | null>(null)
  const datalistId = useId()
  const ref = outerRef || innerRef
  const t = useTranslation()

  if (onClear) {
    actions = [
      ...actions,
      {
        title: t('action.clear'),
        Icon: XIcon,
        onClick: onClear,
      },
    ]
  }

  useEffect(() => {
    if (autoFocus) {
      setTimeout(() => {
        ref.current?.focus()
      })
    }
  }, [autoFocus, ref])

  return (
    <div className={clsx('flex flex-col', className)}>
      <Label name={name} hide={hideLabel}>
        {name}
      </Label>
      <div className="textfield bg-background flex grow items-center">
        <Component
          ref={ref}
          name={name}
          id={name}
          className={clsx(
            'text-muted-foreground placeholder:text-muted-foreground/60 w-0 flex-1 bg-transparent px-1.5 py-1 text-base',
            hideDatalistIndicator && 'datalist-no-indicator',
            isInput || 'scroll h-full resize-none',
          )}
          {...(datalist && { list: datalistId })}
          {...props}
        />
        {datalist && <datalist id={datalistId}>{datalist}</datalist>}
        {!!actions.length && (
          <div className="mx-1 flex gap-0.5">
            {actions.map(({ onClick, ...a }) => (
              <IconButton
                className="text-muted-foreground !p-px"
                key={a.title}
                onClick={() => {
                  onClick(ref.current)
                }}
                {...a}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

interface CheckboxProps extends ComponentProps<'input'> {
  name: string
}
export const Checkbox: React.FC<CheckboxProps> = ({ name, ...props }) => {
  return (
    <div className="flex items-center gap-2">
      <div className="checkbox bg-background relative shrink-0 rounded-sm">
        <input
          type="checkbox"
          name={name}
          id={name}
          className="peer block h-4 w-4 appearance-none"
          {...props}
        />
        <CheckIcon className="text-muted-foreground pointer-events-none invisible absolute top-0 size-4 peer-checked:visible" />
      </div>
      <Label name={name} className="!mb-0" />
    </div>
  )
}

interface SelectProps extends ComponentProps<'select'> {
  name?: string
}
export const Select: React.FC<SelectProps> = ({
  name,
  className,
  ...props
}) => {
  return (
    <div className={clsx('flex flex-col', className)}>
      {name && <Label name={name} />}
      <select
        name={name}
        id={name}
        className={clsx(
          'text-muted-foreground bg-background w-full px-0.5 py-1 text-base',
        )}
        {...props}
      ></select>
    </div>
  )
}

interface ColorPickerProps extends ComponentProps<'input'> {
  name?: string
}
export const ColorPicker: React.FC<ColorPickerProps> = ({
  name,
  className,
  ...props
}) => {
  return (
    <div className={clsx('flex flex-col', className)}>
      {name && <Label name={name} />}
      <input
        type="color"
        name={name}
        id={name}
        className="h-6 w-12"
        {...props}
      />
    </div>
  )
}

interface LabelProps extends ComponentProps<'label'> {
  name: string
  hide?: boolean
}
export const Label: React.FC<LabelProps> = ({
  name,
  hide = false,
  className,
}) => {
  return (
    <label
      htmlFor={name}
      className={clsx(
        'text-muted-foreground mb-1 block text-base font-medium',
        hide && 'hidden',
        className,
      )}
    >
      {name}
    </label>
  )
}
