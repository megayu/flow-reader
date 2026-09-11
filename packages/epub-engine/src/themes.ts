import type Rendition from './rendition'
import type Contents from './contents'

export type StylesheetRules = Record<
  string,
  Record<string, string | number | boolean | undefined>
>

/** Owns the application's default stylesheet and per-property overrides. */
export default class Themes {
  private declare rendition: Rendition
  declare rules: StylesheetRules
  declare _overrides: Record<string, { value: string; priority: boolean }>
  declare injectHook: (contents: Contents) => void
  declare overrideHook: (contents: Contents) => void

  constructor(rendition: Rendition) {
    this.rendition = rendition
    this.rules = {}
    this._overrides = {}
    this.injectHook = this.inject.bind(this)
    this.overrideHook = this.applyOverrides.bind(this)
    rendition.hooks.content.register(this.injectHook, this.overrideHook)
  }

  setDefaultRules(rules: StylesheetRules) {
    if (!rules) return
    this.rules = rules
    for (const content of this.rendition.getContents()) {
      content.addStylesheetRules(rules, 'default')
    }
  }

  inject(contents: Contents) {
    if (Object.keys(this.rules).length)
      contents.addStylesheetRules(this.rules, 'default')
  }

  overrideProperty(name: string, value: string, important = false) {
    this._overrides[name] = { value, priority: important }
    for (const content of this.rendition.getContents()) {
      content.setCss(name, value, important)
    }
  }

  applyOverrides(contents: Contents) {
    for (const [name, rule] of Object.entries(this._overrides)) {
      contents.setCss(name, rule.value, rule.priority)
    }
  }

  destroy() {
    this.rendition.hooks.content.deregister(this.injectHook)
    this.rendition.hooks.content.deregister(this.overrideHook)
    this.rendition = undefined!
    this.rules = {}
    this._overrides = {}
  }
}
