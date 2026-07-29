import { isTauriRuntime } from './env'

function suspendReactPerformanceTracks() {
  if (!import.meta.env.DEV || !isTauriRuntime()) return () => {}

  const descriptor = Object.getOwnPropertyDescriptor(performance, 'measure')

  // React 19.2's development-only component tracks recursively inspect changed
  // props. Reader tabs retain iframe Window references, whose properties throw
  // once WebView2 detaches the frame during navigation. Hide the browser API
  // React uses to detect track support only while its client module initializes.
  Object.defineProperty(performance, 'measure', {
    configurable: true,
    value: undefined,
  })

  return () => {
    if (descriptor) {
      Object.defineProperty(performance, 'measure', descriptor)
    } else {
      Reflect.deleteProperty(performance, 'measure')
    }
  }
}

async function bootstrap() {
  const restorePerformanceMeasure = suspendReactPerformanceTracks()

  try {
    await import('./main')
  } finally {
    restorePerformanceMeasure()
  }
}

void bootstrap().catch((error) => {
  console.error('Flow Reader failed to start', error)
})
