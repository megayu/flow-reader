import clsx from 'clsx'
import { type DragEvent, type HTMLAttributes, type ReactNode, useCallback, useMemo, useState } from 'react'

import { DndContext, type DragDataEvent, useDndContext } from './dropZoneContext'

interface DropZoneProps extends Omit<HTMLAttributes<HTMLDivElement>, 'onDrop'> {
  children?: ReactNode
  className?: string
  onDrop?: (e: DragEvent<HTMLDivElement>) => void
}
export const DropZone: React.FC<DropZoneProps> = (props) => {
  return (
    <DndProvider>
      <DropZoneInner {...props} />
    </DndProvider>
  )
}

// > During the drag, in an event listener for the dragenter and dragover events, you use the data types of the data being dragged to check whether a drop is allowed.
// https://developer.mozilla.org/en-US/docs/Web/API/HTML_Drag_and_Drop_API/Drag_operations#drag_data
function accept(e?: DragDataEvent) {
  const dt = e?.dataTransfer
  return !!dt && [...dt.types].some((t) => ['text/plain', 'Files'].includes(t))
}

const DropZoneInner: React.FC<DropZoneProps> = ({ children, className, onDrop, ...props }) => {
  const { dragover, setDragEvent } = useDndContext()

  const handleDragover = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.stopPropagation()
    e.preventDefault()
  }, [])

  return (
    <div
      className={clsx('relative', className)}
      {...props}
      // https://developer.mozilla.org/en-US/docs/Web/API/File/Using_files_from_web_applications#selecting_files_using_drag_and_drop
      onDragEnter={(e) => {
        if (dragover) return

        setDragEvent(e)
        e.stopPropagation()
        e.preventDefault()
      }}
    >
      {children}

      {dragover && <div className="bg-muted/60 absolute inset-0 z-10 transition"></div>}
      {dragover && (
        <div
          className="absolute inset-0 z-10"
          onDragOver={handleDragover}
          onDragLeave={() => {
            setDragEvent()
          }}
          onDrop={(e) => {
            setDragEvent()
            e.stopPropagation()
            e.preventDefault()
            onDrop?.(e)
          }}
        ></div>
      )}
    </div>
  )
}

const DndProvider: React.FC<{ children?: ReactNode }> = ({ children }) => {
  const [dragover, setDragover] = useState(false)

  const setDragEvent = useCallback((e?: DragDataEvent) => {
    setDragover(accept(e))
  }, [])
  const value = useMemo(() => ({ dragover, setDragEvent }), [dragover, setDragEvent])

  return <DndContext.Provider value={value}>{children}</DndContext.Provider>
}
