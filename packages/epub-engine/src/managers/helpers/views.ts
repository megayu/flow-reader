import type IframeView from '../views/iframe'
import type Section from '../../section'

class Views {
  declare container: HTMLElement | undefined
  declare _views: IframeView[]
  declare length: number
  declare hidden: boolean

  constructor(container?: HTMLElement) {
    this.container = container
    this._views = []
    this.length = 0
    this.hidden = false
  }

  all() {
    return this._views
  }

  first() {
    return this._views[0]
  }

  last() {
    return this._views[this._views.length - 1]
  }

  indexOf(view: IframeView) {
    return this._views.indexOf(view)
  }

  slice(start?: number, end?: number): IframeView[]
  slice() {
    return this._views.slice.apply(
      this._views,
      arguments as unknown as [number?, number?],
    )
  }

  get(i: number) {
    return this._views[i]
  }

  append(view: IframeView) {
    this._views.push(view)
    if (this.container) {
      this.container.appendChild(view.element)
    }
    this.length++
    return view
  }

  prepend(view: IframeView) {
    this._views.unshift(view)
    if (this.container) {
      this.container.insertBefore(view.element, this.container.firstChild)
    }
    this.length++
    return view
  }

  insert(view: IframeView, index: number) {
    this._views.splice(index, 0, view)

    if (this.container) {
      if (index < this.container.children.length) {
        this.container.insertBefore(
          view.element,
          this.container.children[index]!,
        )
      } else {
        this.container.appendChild(view.element)
      }
    }

    this.length++
    return view
  }

  remove(view: IframeView) {
    var index = this._views.indexOf(view)
    if (index === -1) return
    this._views.splice(index, 1)
    this.length = this._views.length

    this.destroy(view)
  }

  destroy(view: IframeView | null) {
    view!.destroy()

    if (this.container && view!.element?.parentNode === this.container) {
      this.container.removeChild(view!.element)
    }
    view = null
  }

  // Iterators

  forEach(
    callback: (view: IframeView, index: number, views: IframeView[]) => void,
    context?: unknown,
  ): void
  forEach() {
    return this._views.forEach.apply(
      this._views,
      arguments as unknown as [
        (view: IframeView, index: number, views: IframeView[]) => void,
        unknown?,
      ],
    )
  }

  clear() {
    // Remove all views
    var view
    var len = this.length

    if (!this.length) return

    for (var i = 0; i < len; i++) {
      view = this._views[i]!
      this.destroy(view)
    }

    this._views = []
    this.length = 0
  }

  find(section: Pick<Section, 'index'>) {
    var view
    var len = this.length

    for (var i = 0; i < len; i++) {
      view = this._views[i]!
      if (view.displayed && view.section.index == section.index) {
        return view
      }
    }
  }

  displayed() {
    var displayed = []
    var view
    var len = this.length

    for (var i = 0; i < len; i++) {
      view = this._views[i]!
      if (view.displayed) {
        displayed.push(view)
      }
    }
    return displayed
  }

  show() {
    var view
    var len = this.length

    for (var i = 0; i < len; i++) {
      view = this._views[i]!
      if (view.displayed) {
        view.show()
      }
    }
    this.hidden = false
  }

  hide() {
    var view
    var len = this.length

    for (var i = 0; i < len; i++) {
      view = this._views[i]!
      if (view.displayed) {
        view.hide()
      }
    }
    this.hidden = true
  }
}

export default Views
