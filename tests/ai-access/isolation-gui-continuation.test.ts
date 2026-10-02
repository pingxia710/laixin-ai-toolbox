import { describe, expect, it, vi } from 'vitest'
import { ApplicationIsolationLeaseController, type ApplicationIsolationAdapter } from '../../app/main/ai-access/application-isolation-lease'

describe('独立隔离路由跨 GUI 生命周期', () => {
  it.each(['codex', 'claude', 'hermes'] as const)('%s 退出和重开接续原绑定，显式解除才恢复', async applicationId => {
    let configured = false
    const restore = vi.fn(async () => { configured = false; return 'restored' as const })
    const apply = vi.fn(async () => { configured = true })
    const deactivate = vi.fn(async () => undefined)
    const adapter: ApplicationIsolationAdapter = {
      inspect: async () => ({ id: applicationId, targetIdentity: 'target', fingerprint: 'before', isolationFingerprint: 'before' }),
      capture: async () => ({ beforeFingerprint: 'before', beforeIsolationFingerprint: 'before', targetIdentity: 'target',
        leaseId: 'a'.repeat(32), restoreIfOwned: restore }),
      activateEntry: async () => undefined, deactivateEntry: deactivate, apply,
      readback: async () => configured, verifyTarget: async () => configured,
      recoverLease: restore,
      resumeLease: async () => configured ? { leaseId: 'a'.repeat(32), restoreIfOwned: restore } : undefined
    }
    const create = () => new ApplicationIsolationLeaseController({ applicationId, adapter,
      system: { snapshot: async () => 'unchanged' },
      entry: async () => ({ capability: 'http-connect', id: 'owned-bridge', proxyUrl: 'http://127.0.0.1:18080' }) })
    const first = create()
    expect((await first.enable()).available).toBe(true)
    expect((await first.recover({ preserveIndependent: true })).available).toBe(true)
    expect(configured).toBe(true)
    expect(deactivate).not.toHaveBeenCalled()
    const reopened = create()
    expect((await reopened.recover({ preserveIndependent: true })).available).toBe(true)
    expect((await reopened.reverify()).available).toBe(true)
    expect(apply).toHaveBeenCalledTimes(1)
    expect(restore).not.toHaveBeenCalled()
    expect((await reopened.disable()).code).toBe('RESTORED')
    expect(restore).toHaveBeenCalledTimes(1)
    expect(deactivate).toHaveBeenCalledTimes(1)
  })
})
