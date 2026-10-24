import { describe, expect, it, vi } from 'vitest'
import { ShutdownRegistry } from '../../app/main/bridge/shutdown-registry'
import { installShutdownLifecycle } from '../../app/main/bridge/shutdown-lifecycle'

describe('正常退出流程', () => {
  it('防重入：重复退出只清理一次，完成后才退出', async () => {
    const listeners = new Map<string, (event: { preventDefault(): void }) => void>()
    const electronApp = {
      on: vi.fn((event: string, listener: (quitEvent: { preventDefault(): void }) => void) => {
        listeners.set(event, listener)
      }),
      exit: vi.fn()
    }
    const registry = new ShutdownRegistry()
    const release = deferred<void>()
    const hook = vi.fn(() => release.promise)
    registry.registerShutdownHook('delayed', hook)
    installShutdownLifecycle(electronApp, registry, 50, vi.fn())

    const firstQuit = { preventDefault: vi.fn() }
    const secondQuit = { preventDefault: vi.fn() }
    listeners.get('before-quit')?.(firstQuit)
    listeners.get('before-quit')?.(secondQuit)
    await Promise.resolve()
    expect(firstQuit.preventDefault).toHaveBeenCalledOnce()
    expect(secondQuit.preventDefault).toHaveBeenCalledOnce()
    expect(hook).toHaveBeenCalledOnce()
    expect(electronApp.exit).not.toHaveBeenCalled()

    release.resolve()
    await vi.waitFor(() => expect(electronApp.exit).toHaveBeenCalledWith(0))
  })

  it('超时也在记录未完成后结束退出流程', async () => {
    const listeners = new Map<string, (event: { preventDefault(): void }) => void>()
    const electronApp = {
      on: vi.fn((event: string, listener: (quitEvent: { preventDefault(): void }) => void) => {
        listeners.set(event, listener)
      }),
      exit: vi.fn()
    }
    const registry = new ShutdownRegistry()
    registry.registerShutdownHook('never-finishes', () => new Promise<void>(() => undefined))
    const diagnostic = vi.fn()
    installShutdownLifecycle(electronApp, registry, 1, diagnostic)

    listeners.get('before-quit')?.({ preventDefault: vi.fn() })
    await vi.waitFor(() => expect(electronApp.exit).toHaveBeenCalledWith(0))
    expect(diagnostic).toHaveBeenCalledWith('清理未完成:never-finishes', 'never-finishes')
  })
})

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolvePromise: (value: T) => void = () => undefined
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve
  })
  return { promise, resolve: resolvePromise }
}
