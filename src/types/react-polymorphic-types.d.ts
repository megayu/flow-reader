declare module 'react-polymorphic-types' {
  import type * as React from 'react'

  type Merge<T, U> = Omit<T, keyof U> & U

  type PropsWithAs<P, T extends React.ElementType> = P & { as?: T }

  export type PolymorphicPropsWithoutRef<
    P,
    T extends React.ElementType,
  > = Merge<
    T extends keyof React.JSX.IntrinsicElements
      ? React.PropsWithoutRef<React.JSX.IntrinsicElements[T]>
      : React.ComponentPropsWithoutRef<T>,
    PropsWithAs<P, T>
  >

  export type PolymorphicPropsWithRef<P, T extends React.ElementType> = Merge<
    T extends keyof React.JSX.IntrinsicElements
      ? React.PropsWithRef<React.JSX.IntrinsicElements[T]>
      : React.ComponentPropsWithRef<T>,
    PropsWithAs<P, T>
  >

  type PolymorphicExoticComponent<
    P = {},
    T extends React.ElementType = React.ElementType,
  > = Merge<
    React.ExoticComponent<P & { [key: string]: unknown }>,
    {
      <InstanceT extends React.ElementType = T>(
        props: PolymorphicPropsWithRef<P, InstanceT>,
      ): React.ReactElement | null
    }
  >

  export type PolymorphicForwardRefExoticComponent<
    P,
    T extends React.ElementType,
  > = Merge<
    React.ForwardRefExoticComponent<P & { [key: string]: unknown }>,
    PolymorphicExoticComponent<P, T>
  >

  export type PolymorphicMemoExoticComponent<
    P,
    T extends React.ElementType,
  > = Merge<
    React.MemoExoticComponent<React.ComponentType<any>>,
    PolymorphicExoticComponent<P, T>
  >

  export type PolymorphicLazyExoticComponent<
    P,
    T extends React.ElementType,
  > = Merge<
    React.LazyExoticComponent<React.ComponentType<any>>,
    PolymorphicExoticComponent<P, T>
  >
}
