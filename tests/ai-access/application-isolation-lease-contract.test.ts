import { describe, expect, it, vi } from 'vitest'
import {
  ApplicationIsolationLeaseController,
  type ApplicationIsolationAdapter,
  type ApplicationIsolationLeaseStatus,
  type ApplicationIsolationSystemGuard
} from '../../app/main/ai-access/application-isolation-lease'
import { ApplicationIsolationHttpConnectTransport, type ApplicationIsolationHttpConnectSession } from '../../app/main/ai-access/application-isolation-transport'

describe('N-56 application capability isolation lease contract', () => {
  it('exposes an explicit HTTP/CONNECT capability lease without OS-process identity or model-gateway fields', async () => {
    let configured = false
    const adapter: ApplicationIsolationAdapter = {
      inspect: vi.fn(async () => ({ id: 'explicit-application-owned-surface', targetIdentity: 'opaque-target-a', fingerprint: 'before', isolationFingerprint: 'before-exact' })),
      capture: vi.fn(async () => ({ beforeFingerprint: 'before', beforeIsolationFingerprint: 'before-exact', targetIdentity: 'opaque-target-a', leaseId: 'a'.repeat(32), restoreIfOwned: async () => 'restored' as const })),
      activateEntry: vi.fn(async () => undefined),
      deactivateEntry: vi.fn(async () => undefined),
      apply: vi.fn(async () => { configured = true }),
      readback: vi.fn(async () => configured),
      verifyTarget: vi.fn(async () => configured)
    }
    const system: ApplicationIsolationSystemGuard = { snapshot: vi.fn(async () => 'system-network-unchanged') }
    const controller = new ApplicationIsolationLeaseController({
      applicationId: 'codex',
      adapter, system,
      entry: async () => ({ capability: 'http-connect', id: 'n55-proven-entry', proxyUrl: 'http://127.0.0.1:18080' })
    })

    const status: ApplicationIsolationLeaseStatus = await controller.enable()

    expect(status).toMatchObject({ application: 'codex', scope: 'model-api-egress', capability: 'http-connect', mode: 'application-only', action: 'enable', available: true, code: 'AVAILABLE' })
    expect(status.intentGeneration).toBeGreaterThan(0)
    expect(Object.keys(status)).not.toEqual(expect.arrayContaining(['pid', 'processId', 'proxyUrl', 'target', 'configuration', 'ANTHROPIC_BASE_URL', 'NO_PROXY']))
  })

  it('独立公共入口可直接导入租约控制器与 HTTP/CONNECT 传输，不依赖 Codex 适配文件', async () => {
    const session: ApplicationIsolationHttpConnectSession = {
      closeAllConnections: vi.fn(async () => undefined),
      setProxy: vi.fn(async () => undefined),
      resolveProxy: vi.fn(async () => 'PROXY 127.0.0.1:18080'),
      fetch: vi.fn(async () => new Response('ok'))
    }
    const transport = new ApplicationIsolationHttpConnectTransport({ create: () => session })

    await transport.activate('http://127.0.0.1:18080', 'https://api.example.test/responses')

    expect(session.setProxy).toHaveBeenCalledWith({ mode: 'fixed_servers', proxyRules: 'http://127.0.0.1:18080', proxyBypassRules: '<-loopback>' })
  })

  it('Claude 租约只有配置读回和独立 HTTP/CONNECT 目标复验都成功时才可用', async () => {
    let owned = false
    const adapter: ApplicationIsolationAdapter = {
      inspect: async () => ({ id: 'claude:user', targetIdentity: 'claude-target', fingerprint: 'before', isolationFingerprint: 'before' }),
      capture: async () => ({ beforeFingerprint: 'before', beforeIsolationFingerprint: 'before', targetIdentity: 'claude-target', leaseId: 'b'.repeat(32), restoreIfOwned: async () => owned ? 'restored' as const : 'preserved-external' as const }),
      activateEntry: async () => undefined,
      deactivateEntry: async () => { owned = false },
      apply: async () => { owned = true },
      readback: async () => owned,
      verifyTarget: async () => false
    }
    const controller = new ApplicationIsolationLeaseController({
      applicationId: 'claude', adapter, system: { snapshot: async () => 'n55-read-only-path' },
      entry: async () => ({ capability: 'http-connect', id: 'n55-proven-entry', proxyUrl: 'http://127.0.0.1:18080' })
    })

    await expect(controller.enable()).resolves.toMatchObject({ application: 'claude', scope: 'model-api-egress', capability: 'http-connect', available: false, code: 'TARGET_UNREACHABLE' })
    expect(owned).toBe(false)
  })

  it('Claude 捕获与当前有效目标不一致时撤销未启动租约，不写配置也不绑定 transport', async () => {
    const apply = vi.fn(async () => undefined)
    const activateEntry = vi.fn(async () => undefined)
    const clearLease = vi.fn(async () => undefined)
    const adapter: ApplicationIsolationAdapter = {
      inspect: async () => ({ id: 'claude:project', targetIdentity: 'project-target', fingerprint: 'project', isolationFingerprint: 'project-owned' }),
      capture: async () => ({ beforeFingerprint: 'user', beforeIsolationFingerprint: 'user-owned', targetIdentity: 'user-target', leaseId: 'c'.repeat(32), restoreIfOwned: async () => 'restored' as const }),
      activateEntry,
      deactivateEntry: async () => undefined,
      apply,
      readback: async () => false,
      verifyTarget: async () => false,
      clearLease
    }
    const controller = new ApplicationIsolationLeaseController({
      applicationId: 'claude', adapter, system: { snapshot: async () => 'n55-read-only-path' },
      entry: async () => ({ capability: 'http-connect', id: 'n55-proven-entry', proxyUrl: 'http://127.0.0.1:18080' })
    })

    await expect(controller.enable()).resolves.toMatchObject({ available: false, code: 'STALE_OPERATION' })
    expect(clearLease).toHaveBeenCalledWith('c'.repeat(32))
    expect(apply).not.toHaveBeenCalled()
    expect(activateEntry).not.toHaveBeenCalled()
  })

  it('Claude 捕获 A 后在启动前被新目标 B 淘汰时，只调用捕获目标的租约结算', async () => {
    const settleCapturedA = vi.fn(async () => undefined)
    const clearCurrentB = vi.fn(async () => undefined)
    const adapter: ApplicationIsolationAdapter = {
      inspect: async () => ({ id: 'claude:project-b', targetIdentity: 'project-b', fingerprint: 'before', isolationFingerprint: 'before-owned' }),
      capture: async () => ({
        beforeFingerprint: 'before', beforeIsolationFingerprint: 'before-owned', targetIdentity: 'project-a', leaseId: 'd'.repeat(32),
        restoreIfOwned: async () => 'restored' as const, clearLease: settleCapturedA
      }),
      activateEntry: async () => undefined,
      deactivateEntry: async () => undefined,
      apply: async () => undefined,
      readback: async () => false,
      verifyTarget: async () => false,
      clearLease: clearCurrentB
    }
    const controller = new ApplicationIsolationLeaseController({
      applicationId: 'claude', adapter, system: { snapshot: async () => 'n55-read-only-path' },
      entry: async () => ({ capability: 'http-connect', id: 'n55-proven-entry', proxyUrl: 'http://127.0.0.1:18080' })
    })

    await expect(controller.enable()).resolves.toMatchObject({ available: false, code: 'STALE_OPERATION' })
    expect(settleCapturedA).toHaveBeenCalledOnce()
    expect(clearCurrentB).not.toHaveBeenCalled()
  })
})
