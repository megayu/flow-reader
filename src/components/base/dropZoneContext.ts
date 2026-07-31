import { createContext, useContext } from 'react'

export interface DragDataEvent {
  dataTransfer: DataTransfer | null
}

export const DndContext = createContext<{
  dragover: boolean
  setDragEvent: (event?: DragDataEvent) => void
}>({ dragover: false, setDragEvent: () => {} })

export function useDndContext() {
  return useContext(DndContext)
}
