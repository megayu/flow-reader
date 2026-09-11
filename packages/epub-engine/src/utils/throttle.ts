export default function throttle<Context, Args extends unknown[]>(
  func: (this: Context, ...args: Args) => unknown,
  wait: number,
) {
  let timeout: ReturnType<typeof setTimeout> | undefined
  let previous = 0

  function throttled(this: Context, ...args: Args) {
    const now = Date.now()
    const remaining = wait - (now - previous)

    if (remaining <= 0 || remaining > wait) {
      if (timeout) {
        clearTimeout(timeout)
        timeout = undefined
      }

      previous = now
      func.apply(this, args)
    } else if (!timeout) {
      timeout = setTimeout(() => {
        previous = Date.now()
        timeout = undefined
        func.apply(this, args)
      }, remaining)
    }
  }

  throttled.cancel = () => {
    if (timeout) {
      clearTimeout(timeout)
      timeout = undefined
    }
    previous = 0
  }

  return throttled
}
