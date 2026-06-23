import {
  useLibraryActionState,
  useReaderActionState,
  useSetReaderActionState,
  type Action,
  type LibraryAction,
} from '../state'

export type { Action, LibraryAction }

export function useSetAction() {
  return useSetReaderActionState()
}

export function useAction() {
  return useReaderActionState()
}

export function useLibraryAction() {
  return useLibraryActionState()
}
