import clsx from 'clsx'
import { type LucideIcon } from 'lucide-react'
import { ComponentProps } from 'react'

import { IconButton } from '../Button'

export interface Action {
  id: string
  title: string
  Icon: LucideIcon
  handle: () => void
}

interface ActionBarProps extends ComponentProps<'ul'> {
  actions: Action[]
}
export const ActionBar: React.FC<ActionBarProps> = ({ actions, className }) => {
  return (
    <ul
      className={clsx(
        'text-muted-foreground flex items-center gap-1',
        className,
      )}
    >
      {actions.map(({ id, title, Icon, handle }) => (
        <li key={id} className="flex items-center">
          <IconButton
            title={title}
            Icon={Icon}
            onClick={(e) => {
              e.stopPropagation()
              handle()
            }}
          />
        </li>
      ))}
    </ul>
  )
}
