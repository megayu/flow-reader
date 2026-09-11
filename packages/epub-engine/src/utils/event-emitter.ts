class EventEmitter<
  Events extends { [K in keyof Events]: unknown[] } = Record<string, unknown[]>,
> {
  // The key ties each listener to its event tuple at registration and emission.
  private declare _events: {
    [K in keyof Events]?: ((...args: Events[K]) => unknown)[]
  }

  constructor() {
    // Listener state must stay per instance so reader tabs cannot receive each other's events.
    this._events = Object.create(null)
  }

  on<K extends keyof Events>(
    type: K,
    listener: (...args: Events[K]) => unknown,
  ) {
    if (typeof listener !== 'function') {
      throw new TypeError('The listener must be a function')
    }

    const listeners = this._events[type]
    if (listeners) {
      listeners.push(listener)
    } else {
      this._events[type] = [listener]
    }

    return this
  }

  off<K extends keyof Events>(
    type: K,
    listener?: (...args: Events[K]) => unknown,
  ) {
    const listeners = this._events[type]
    if (!listeners) {
      return this
    }

    if (!listener) {
      delete this._events[type]
      return this
    }

    const remaining = listeners.filter((candidate) => candidate !== listener)
    if (remaining.length) {
      this._events[type] = remaining
    } else {
      delete this._events[type]
    }

    return this
  }

  emit<K extends keyof Events>(type: K, ...args: Events[K]) {
    const listeners = this._events[type]
    if (!listeners) {
      return false
    }

    for (const listener of listeners.slice()) {
      listener.apply(this, args)
    }

    return true
  }

  removeAllListeners() {
    this._events = Object.create(null)
  }
}

export default EventEmitter
