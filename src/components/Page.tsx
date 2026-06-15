import clsx from 'clsx'
import { ComponentProps } from 'react'

interface PageProps extends ComponentProps<'div'> {
  headline: string
}
export const Page: React.FC<PageProps> = ({
  className,
  children,
  headline,
  ...props
}) => {
  return (
    <div className={clsx('p-4', className)} {...props}>
      <h1
        className={clsx(
          'mb-4 text-on-surface-variant typescale-title-large',
          className,
        )}
        {...props}
      >
        {headline}
      </h1>
      {children}
    </div>
  )
}
