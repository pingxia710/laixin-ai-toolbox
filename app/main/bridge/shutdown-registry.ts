import { BridgeError } from './action-registry'

export type ShutdownHook = () => void | Promise<void>

export interface ShutdownRunOptions {
  readonly timeoutMs: number
  readonly diagnostic: (code: string, moduleId: string) => void
}

export interface ShutdownRunResult {
  readonly timedOutHook: string | undefined
}

export class ShutdownRegistry {
  private readonly hooks: Array<{ readonly moduleId: string; readonly hook: ShutdownHook }> = []
  private readonly moduleIds = new Set<string>()

  registerShutdownHook(moduleId: string, hook: ShutdownHook): void {
    if (this.moduleIds.has(moduleId)) {
      throw new BridgeError('SHUTDOWN_HOOK_DUPLICATE')
    }
    this.moduleIds.add(moduleId)
    this.hooks.push({ moduleId, hook })
  }

  async run(options: ShutdownRunOptions): Promise<ShutdownRunResult> {
    const deadline = Date.now() + options.timeoutMs
    for (const registered of [...this.hooks].reverse()) {
      const remainingMs = deadline - Date.now()
      if (remainingMs <= 0) {
        options.diagnostic(`清理未完成:${registered.moduleId}`, registered.moduleId)
        return { timedOutHook: registered.moduleId }
      }
      const outcome = await settleWithin(registered.hook, remainingMs)
      if (outcome === 'timeout') {
        options.diagnostic(`清理未完成:${registered.moduleId}`, registered.moduleId)
        return { timedOutHook: registered.moduleId }
      }
      if (outcome === 'rejected') {
        options.diagnostic('SHUTDOWN_HOOK_FAILED', registered.moduleId)
      }
    }
    return { timedOutHook: undefined }
  }
}

async function settleWithin(hook: ShutdownHook, timeoutMs: number): Promise<'fulfilled' | 'rejected' | 'timeout'> {
  const settled = Promise.resolve()
    .then(hook)
    .then(
      () => 'fulfilled' as const,
      () => 'rejected' as const
    )
  const timeout = new Promise<'timeout'>((resolve) => {
    setTimeout(() => resolve('timeout'), timeoutMs)
  })
  return Promise.race([settled, timeout])
}
