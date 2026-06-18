const scrollbarVisibleClass = 'scrollbar-visible'

export function revealScrollbars(target?: EventTarget | null) {
  if (typeof document === 'undefined') return

  const element = target instanceof Element ? target : undefined
  const scroll = element?.closest('.scroll')

  if (scroll) {
    scroll.classList.add(scrollbarVisibleClass)
    return
  }

  document
    .querySelectorAll(`.scroll`)
    .forEach((el) => el.classList.add(scrollbarVisibleClass))
}
