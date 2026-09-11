import { defer, requestAnimationFrame, type Deferred } from './core'

interface QueueItem {
  task: unknown
  args: unknown[]
  input: Promise<unknown> | undefined
  deferred: Deferred<unknown>
}

/** Runs one operation per animation frame and settles every caller, including cancellation. */
export default class Queue<Context = unknown> {
  declare context: Context | undefined
  declare items: (QueueItem | undefined)[]
  declare head: number
  declare running: boolean
  declare stopped: boolean
  declare frame: number | undefined
  declare active: QueueItem | undefined

  constructor(context?: Context) {
    this.context = context
    this.items = []
    this.head = 0
    this.running = false
    this.stopped = false
  }

  enqueue<Args extends unknown[], Result>(
    task: (this: Context, ...args: Args) => Result,
    ...args: Args
  ): Promise<Awaited<Result> | void>
  enqueue<Result>(
    task: PromiseLike<Result> | Result,
  ): Promise<Awaited<Result> | void>
  enqueue(task: unknown, ...args: unknown[]): Promise<unknown> {
    if (this.stopped) return Promise.resolve()
    const deferred = new defer<unknown>()
    // Observe promise inputs immediately, even while an earlier task is running.
    const input = typeof task === 'function' ? undefined : Promise.resolve(task)
    input?.catch(() => undefined)
    this.items.push({ task, args, input, deferred })
    this.run()
    return deferred.promise
  }

  run() {
    if (this.running || this.stopped || this.head >= this.items.length) return
    this.running = true
    this.frame = (requestAnimationFrame as typeof window.requestAnimationFrame)(
      () => {
        this.frame = undefined
        if (this.stopped) return
        const item = this.items[this.head++]!
        this.items[this.head - 1] = undefined
        this.active = item
        let result
        try {
          result =
            item.input ??
            (item.task as (...args: unknown[]) => unknown).apply(
              this.context,
              item.args,
            )
        } catch (error) {
          item.deferred.reject(error)
          this.finish()
          return
        }
        Promise.resolve(result).then(
          (value) => {
            item.deferred.resolve(value)
            this.finish()
          },
          (error) => {
            item.deferred.reject(error)
            this.finish()
          },
        )
      },
    )
  }

  finish() {
    this.active = undefined
    this.running = false
    if (this.stopped) return
    if (this.head < this.items.length) this.run()
    else {
      this.items = []
      this.head = 0
    }
  }

  stop() {
    if (this.stopped) return
    this.stopped = true
    if (this.frame !== undefined) cancelAnimationFrame(this.frame)
    this.active?.deferred.resolve(undefined)
    for (let i = this.head; i < this.items.length; i++)
      this.items[i]!.deferred.resolve(undefined)
    this.items = []
    this.active = undefined
    this.context = undefined
    this.running = false
  }
}
