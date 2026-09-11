import { qs, qsa } from './utils/core'

/**
 * Open DisplayOptions Format Parser
 * @class
 * @param {document} displayOptionsDocument XML
 */
class DisplayOptions {
  declare interactive: string | null | undefined
  declare fixedLayout: string | null | undefined
  declare openToSpread: string | null | undefined
  declare orientationLock: string | null | undefined

  constructor(displayOptionsDocument?: Document) {
    this.interactive = ''
    this.fixedLayout = ''
    this.openToSpread = ''
    this.orientationLock = ''

    if (displayOptionsDocument) {
      this.parse(displayOptionsDocument)
    }
  }

  /**
   * Parse XML
   * @param  {document} displayOptionsDocument XML
   * @return {DisplayOptions} self
   */
  parse(displayOptionsDocument: Document) {
    if (!displayOptionsDocument) {
      return this
    }

    const displayOptionsNode = qs(displayOptionsDocument, 'display_options')
    if (!displayOptionsNode) {
      return this
    }

    const options = qsa(displayOptionsNode, 'option')
    ;(options as NodeListOf<Element>).forEach((el) => {
      let value: string | null = ''

      if (el.childNodes.length) {
        value = el.childNodes[0]!.nodeValue
      }

      switch ((el.attributes as NamedNodeMap & { name: Attr }).name.value) {
        case 'interactive':
          this.interactive = value
          break
        case 'fixed-layout':
          this.fixedLayout = value
          break
        case 'open-to-spread':
          this.openToSpread = value
          break
        case 'orientation-lock':
          this.orientationLock = value
          break
      }
    })

    return this
  }

  destroy() {
    this.interactive = undefined
    this.fixedLayout = undefined
    this.openToSpread = undefined
    this.orientationLock = undefined
  }
}

export default DisplayOptions
