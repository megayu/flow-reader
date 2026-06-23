import clsx from 'clsx'
import { ComponentProps } from 'react'
import { IconType } from 'react-icons'

import { cn } from '@/lib/utils'

import { Button as ShadcnButton } from './ui/button'

interface IconButtonProps extends Omit<ComponentProps<'button'>, 'size'> {
  Icon: IconType
  size?: number
}
export function IconButton({
  className,
  Icon,
  size = 16,
  ...props
}: IconButtonProps) {
  return (
    <ShadcnButton
      variant="ghost"
      size="icon-sm"
      className={cn('h-auto w-auto rounded-sm p-0.5', className)}
      {...props}
    >
      <Icon size={size} />
    </ShadcnButton>
  )
}

const variantMap = {
  primary: 'default',
  secondary: 'secondary',
} as const

const compactClassMap = {
  true: 'h-auto px-2 py-1',
  false: 'h-auto px-3 py-1.5',
}

export interface ButtonProps extends ComponentProps<'button'> {
  variant?: keyof typeof variantMap
  compact?: boolean
}
export const Button: React.FC<ButtonProps> = ({
  variant = 'primary',
  compact = false,
  className,
  ...props
}) => {
  return (
    <ShadcnButton
      variant={variantMap[variant]}
      className={clsx(compactClassMap[`${compact}`], className)}
      {...props}
    />
  )
}
