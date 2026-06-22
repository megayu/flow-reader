import { atom, useRecoilState, useSetRecoilState } from 'recoil'

export type Action = 'toc' | 'search' | 'annotation' | 'typography' | 'image'
export type LibraryAction = 'libraryFilter'

export const actionState = atom<Action | undefined>({
  key: 'action',
  default: undefined,
})

export const libraryActionState = atom<LibraryAction | undefined>({
  key: 'libraryAction',
  default: undefined,
})

export function useSetAction() {
  return useSetRecoilState(actionState)
}

export function useAction() {
  return useRecoilState(actionState)
}

export function useLibraryAction() {
  return useRecoilState(libraryActionState)
}
