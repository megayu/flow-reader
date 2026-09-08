class EventEmitter {
  constructor() {
    // Listener state must stay per instance so reader tabs cannot receive each other's events.
    this._events = Object.create(null)
  }

  on(type, listener) {
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

  off(type, listener) {
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

  emit(type, ...args) {
    const listeners = this._events[type]
    if (!listeners) {
      return false
    }

    for (const listener of listeners.slice()) {
      listener.apply(this, args)
    }

    return true
  }
}

export default EventEmitter
