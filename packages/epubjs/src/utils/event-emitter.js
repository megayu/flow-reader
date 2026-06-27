import EventEmitter from 'eventemitter3'

const methods = [
  'addListener',
  'emit',
  'eventNames',
  'listenerCount',
  'listeners',
  'off',
  'on',
  'once',
  'removeAllListeners',
  'removeListener',
]

export default function applyEventEmitter(target) {
  methods.forEach((method) => {
    if (typeof EventEmitter.prototype[method] === 'function') {
      target[method] = function (...args) {
        if (!Object.prototype.hasOwnProperty.call(this, '_events')) {
          EventEmitter.call(this)
        }

        return EventEmitter.prototype[method].apply(this, args)
      }
    }
  })

  target.trigger = target.emit
}
