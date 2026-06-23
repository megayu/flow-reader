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
  EventEmitter.call(target)

  methods.forEach((method) => {
    if (typeof EventEmitter.prototype[method] === 'function') {
      target[method] = EventEmitter.prototype[method]
    }
  })

  target.trigger = target.emit
}
