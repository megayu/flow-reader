type HookTask<Args extends unknown[]> = (...args: Args) => unknown

/**
 * Hooks allow for injecting functions that must all complete in order before finishing
 * They will execute in parallel but all must finish before continuing
 * Functions may return a promise if they are async.
 * @param {any} context scope of this
 * @example this.content = new Hook(this);
 */
class Hook<Args extends unknown[] = unknown[]> {
  declare context: unknown
  declare hooks: HookTask<Args>[]

  constructor(context?: unknown) {
    this.context = context || this
    this.hooks = []
  }

  /**
   * Adds a function to be run before a hook completes
   * @example this.content.register(function(){...});
   */
  register(...tasks: (HookTask<Args> | HookTask<Args>[])[]): void
  register() {
    for (var i = 0; i < arguments.length; ++i) {
      if (typeof arguments[i] === 'function') {
        this.hooks.push(arguments[i])
      } else {
        // unpack array
        for (var j = 0; j < arguments[i].length; ++j) {
          this.hooks.push(arguments[i][j])
        }
      }
    }
  }

  /**
   * Removes a function
   * @example this.content.deregister(function(){...});
   */
  deregister(func: HookTask<Args>) {
    let hook
    for (let i = 0; i < this.hooks.length; i++) {
      hook = this.hooks[i]
      if (hook === func) {
        this.hooks.splice(i, 1)
        break
      }
    }
  }

  /**
   * Triggers a hook to run all functions
   * @example this.content.trigger(args).then(function(){...});
   */
  trigger(...args: Args): Promise<unknown[]>
  trigger() {
    var args = arguments as unknown as Args
    var context = this.context
    var promises: PromiseLike<unknown>[] = []

    this.hooks.forEach(function (task) {
      try {
        var executing = task.apply(context, args)
      } catch (err) {
        executing = Promise.reject(err)
      }

      if (
        executing &&
        typeof (executing as PromiseLike<unknown>)['then'] === 'function'
      ) {
        // Task is a function that returns a promise
        promises.push(executing as PromiseLike<unknown>)
      }
      // Otherwise Task resolves immediately, continue
    })

    return Promise.all(promises)
  }

  // Adds a function to be run before a hook completes
  list() {
    return this.hooks
  }

  clear() {
    return (this.hooks = [])
  }
}
export default Hook
