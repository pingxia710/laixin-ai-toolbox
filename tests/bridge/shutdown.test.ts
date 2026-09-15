import { describe, expect, it, vi } from 'vitest'
import { ShutdownRegistry } from '../../app/main/bridge/shutdown-registry'

describe('退出钩子', () => {
  it('逆序等待异步钩子，异常不阻断后续钩子', async () => {
    const calls: string[] = []
    const registry = new ShutdownRegistry()
    registry.registerShutdownHook('first', () => {
      calls.push('first')
    })
    registry.registerShutdownHook('second', async () => {
      calls.push('second:start')
      await Promise.resolve()
      calls.push('second:done')
    })
    registry.registerShutdownHook('broken', () => {
      calls.push('broken')
      throw new Error('not exposed')
    })

    const diagnostic = vi.fn()
    await expect(registry.run({ timeoutMs: 50, diagnostic })).resolves.toEqual({ timedOutHook: undefined })
    expect(calls).toEqual(['broken', 'second:start', 'second:done', 'first'])
    expect(diagnostic).toHaveBeenCalledWith('SHUTDOWN_HOOK_FAILED', 'broken')
  })

  it('有界超时并报告未完成钩子', async () => {
    const registry = new ShutdownRegistry()
    registry.registerShutdownHook('never-finishes', () => new Promise<void>(() => undefined))
    const diagnostic = vi.fn()

    await expect(registry.run({ timeoutMs: 1, diagnostic })).resolves.toEqual({
      timedOutHook: 'never-finishes'
    })
    expect(diagnostic).toHaveBeenCalledWith('清理未完成:never-finishes', 'never-finishes')
  })

  it('整轮等待不会为每个钩子重置上限', async () => {
    const registry = new ShutdownRegistry()
    for (const moduleId of ['first', 'second', 'third']) {
      registry.registerShutdownHook(moduleId, async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 40))
      })
    }
    const diagnostic = vi.fn()
    const startedAt = Date.now()

    await expect(registry.run({ timeoutMs: 50, diagnostic })).resolves.toEqual({ timedOutHook: 'second' })

    expect(Date.now() - startedAt).toBeLessThan(100)
    expect(diagnostic).toHaveBeenCalledWith('清理未完成:second', 'second')
  })

  it('重复模块退出钩子被拒绝', () => {
    const registry = new ShutdownRegistry()
    registry.registerShutdownHook('app', () => undefined)
    expect(() => registry.registerShutdownHook('app', () => undefined)).toThrow('SHUTDOWN_HOOK_DUPLICATE')
  })
})
