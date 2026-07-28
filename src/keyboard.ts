const KEYBOARD_EDITABLE_SELECTOR = 'input, textarea, select, [contenteditable="true"]'
const KEYBOARD_CAPTURE_SELECTOR = '[data-flow-keyboard-capture="true"]'
const KEYBOARD_BLOCKING_OVERLAY_SELECTOR = '[role="dialog"], [role="menu"]'

function eventTargetDocuments(target: EventTarget | null) {
  const doc = target instanceof Node && target.ownerDocument ? target.ownerDocument : document
  const parentDoc = doc.defaultView?.frameElement?.ownerDocument
  const docs = new Set<Document>()

  ;[doc, parentDoc, document].forEach((candidate) => {
    if (candidate) docs.add(candidate)
  })
  ;[...docs].forEach((candidate) => {
    candidate.querySelectorAll('iframe').forEach((frame) => {
      try {
        if (frame.contentDocument) docs.add(frame.contentDocument)
      } catch {
        // Ignore cross-origin frames.
      }
    })
  })

  return [...docs]
}

export function isEditableKeyboardTarget(target: EventTarget | null) {
  return target instanceof Element && !!target.closest(KEYBOARD_EDITABLE_SELECTOR)
}

export function isKeyboardCaptureTarget(target: EventTarget | null) {
  return target instanceof Element && !!target.closest(KEYBOARD_CAPTURE_SELECTOR)
}

export function hasBlockingKeyboardOverlay(target: EventTarget | null) {
  return eventTargetDocuments(target).some((doc) => doc.querySelector(KEYBOARD_BLOCKING_OVERLAY_SELECTOR))
}

export function hasKeyboardCaptureLayer(target: EventTarget | null, selectors: string[] = []) {
  return eventTargetDocuments(target).some((doc) =>
    doc.querySelector([KEYBOARD_CAPTURE_SELECTOR, ...selectors].join(',')),
  )
}

export function isGlobalKeyboardShortcutBlocked(e: KeyboardEvent) {
  return isEditableKeyboardTarget(e.target) || isKeyboardCaptureTarget(e.target) || hasBlockingKeyboardOverlay(e.target)
}
