import enUS from '../../src/locales/en-US.json' with { type: 'json' }

type MessageKey = keyof typeof enUS

export function msg(key: MessageKey) {
  return enUS[key]
}
