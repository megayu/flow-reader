/// <reference types="vite/client" />
/// <reference path="./vendor.d.ts" />
import type JSZip from 'jszip'
import type { LegacyWindow } from './utils/core'

import { isXml, parse } from './utils/core'
import mime from './utils/mime'
import Path from './utils/path'

/**
 * Handles Unzipping a requesting files from an Epub Archive
 * @class
 */
class Archive {
  declare zip: JSZip | undefined
  declare zipPromise: Promise<JSZip> | undefined
  declare urlCache: Record<string, string>

  constructor() {
    this.zip = undefined
    this.zipPromise = undefined
    this.urlCache = {}
  }

  ensureZip() {
    if (this.zip) {
      return Promise.resolve(this.zip)
    }

    if (import.meta.env.MODE !== 'test') {
      return Promise.reject(
        new Error(
          'Archived EPUB inputs must be opened through the native reader source',
        ),
      )
    }

    if (!this.zipPromise) {
      this.zipPromise = import('jszip/dist/jszip').then((module) => {
        const JSZip = module.default || module
        this.zip = new JSZip()
        return this.zip
      })
    }

    return this.zipPromise
  }

  /**
   * Open an archive
   * @param  {binary} input
   * @param  {boolean} [isBase64] tells JSZip if the input data is base64 encoded
   * @return {Promise} zipfile
   */
  open(input: Parameters<JSZip['loadAsync']>[0], isBase64?: boolean | string) {
    return this.ensureZip().then((zip) =>
      zip.loadAsync(input, { base64: isBase64 as boolean }),
    )
  }

  /**
   * Request a url from the archive
   * @param  {string} url  a url to request from the archive
   * @param  {string} [type] specify the type of the returned result
   * @return {Promise<Blob | string | JSON | Document | XMLDocument>}
   */
  request(url: string, type?: string) {
    var response
    var path = new Path(url)

    // If type isn't set, determine it from the file extension
    if (!type) {
      type = path.extension
    }

    if (type == 'blob') {
      response = this.getBlob(url)
    } else {
      response = this.getText(url)
    }

    if (!response) {
      return Promise.reject({
        message: 'File not found in the epub: ' + url,
        stack: new Error().stack,
      })
    }

    return response.then((result) => this.handleResponse(result, type))
  }

  /**
   * Handle the response from request
   * @private
   * @param  {any} response
   * @param  {string} [type]
   * @return {any} the parsed result
   */
  handleResponse(response: Blob | string, type?: string): unknown {
    var r

    if (type == 'json') {
      r = JSON.parse(response as string)
    } else if (isXml(type!)) {
      r = parse(response as string, 'text/xml')
    } else if (type == 'xhtml') {
      r = parse(response as string, 'application/xhtml+xml')
    } else if (type == 'html' || type == 'htm') {
      r = parse(response as string, 'text/html')
    } else {
      r = response
    }

    return r
  }

  /**
   * Get a Blob from Archive by Url
   * @param  {string} url
   * @param  {string} [mimeType]
   * @return {Blob}
   */
  getBlob(url: string, mimeType?: string) {
    var decodededUrl = window.decodeURIComponent(url.substr(1)) // Remove first slash
    var entry = this.zip!.file(decodededUrl)

    if (entry) {
      mimeType = mimeType || mime.lookup(entry.name)
      return entry.async('uint8array').then(function (uint8array) {
        return new Blob([uint8array as Uint8Array<ArrayBuffer>], {
          type: mimeType,
        })
      })
    }
  }

  /**
   * Get Text from Archive by Url
   * @param  {string} url
   * @param  {string} [_encoding]
   * @return {string}
   */
  getText(url: string, _encoding?: string) {
    var decodededUrl = window.decodeURIComponent(url.substr(1)) // Remove first slash
    var entry = this.zip!.file(decodededUrl)

    if (entry) {
      return entry.async('string').then(function (text) {
        return text
      })
    }
  }

  /**
   * Get a base64 encoded result from Archive by Url
   * @param  {string} url
   * @param  {string} [mimeType]
   * @return {string} base64 encoded
   */
  getBase64(url: string, mimeType?: string) {
    var decodededUrl = window.decodeURIComponent(url.substr(1)) // Remove first slash
    var entry = this.zip!.file(decodededUrl)

    if (entry) {
      mimeType = mimeType || mime.lookup(entry.name)
      return entry.async('base64').then(function (data) {
        return 'data:' + mimeType + ';base64,' + data
      })
    }
  }

  /**
   * Create a Url from an unarchived item
   * @param  {string} url
   * @param  {object} [options.base64] use base64 encoding or blob url
   * @return {Promise} url promise with Url string
   */
  createUrl(url: string, options?: { base64?: boolean }) {
    var _URL =
      window.URL ||
      (window as LegacyWindow).webkitURL ||
      (window as LegacyWindow).mozURL
    var response
    var useBase64 = options && options.base64

    if (url in this.urlCache) {
      return Promise.resolve(this.urlCache[url]!)
    }

    if (useBase64) {
      response = this.getBase64(url)
    } else {
      response = this.getBlob(url)
    }

    if (!response) {
      return Promise.reject({
        message: 'File not found in the epub: ' + url,
        stack: new Error().stack,
      })
    }

    return response.then((result) => {
      const tempUrl = useBase64
        ? (result as string)
        : _URL.createObjectURL(result as Blob)
      this.urlCache[url] = tempUrl
      return tempUrl
    })
  }

  destroy() {
    var _URL =
      window.URL ||
      (window as LegacyWindow).webkitURL ||
      (window as LegacyWindow).mozURL
    for (let url in this.urlCache) {
      _URL.revokeObjectURL(this.urlCache[url]!)
    }
    this.zip = undefined
    this.urlCache = {}
  }
}

export default Archive
