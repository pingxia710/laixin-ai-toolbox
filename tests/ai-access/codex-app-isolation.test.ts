import { describe, expect, it, vi } from 'vitest'
import { CodexAppIsolationController, type CodexIsolationAdapter, type CodexIsolationSystemGuard } from '../../app/main/ai-access/codex-app-isolation'

const codexConfiguration = { id: 'codex:user-config', targetIdentity: 'codex-target-a', fingerprint: 'before-fingerprint', isolationFingerprint: 'before-isolation-fingerprint' }
const laixinEntry = { capability: 'http-connect' as const, id: 'laixin-entry:verified', proxyUrl: 'http://127.0.0.1:18080' }

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise })
  return { promise, resolve, reject }
}

function fixture(overrides: Partial<CodexIsolationAdapter> = {}, applicationId: 'codex' | 'claude' | 'hermes' = 'codex') {
  let current = 'before-fingerprint'
  let restoreCount = 0
  const adapter: CodexIsolationAdapter = {
    inspect: vi.fn(async () => ({ ...codexConfiguration, fingerprint: current })),
    capture: vi.fn(async () => ({
      beforeFingerprint: current,
      beforeIsolationFingerprint: current === 'before-fingerprint' ? 'before-isolation-fingerprint' : current,
      targetIdentity: 'codex-target-a',
      leaseId: 'a'.repeat(32),
      restoreIfOwned: async () => {
        restoreCount += 1
        if (current === 'laixin-isolation') current = 'before-fingerprint'
        return current === 'before-fingerprint' ? 'restored' : 'preserved-external'
      }
    })),
    activateEntry: vi.fn(async () => undefined),
    deactivateEntry: vi.fn(async () => undefined),
    apply: vi.fn(async () => { current = 'laixin-isolation' }),
    readback: vi.fn(async () => current === 'laixin-isolation'),
    verifyTarget: vi.fn(async () => current === 'laixin-isolation'),
    ...overrides
  }
  const system: CodexIsolationSystemGuard = {
    snapshot: vi.fn(async () => 'system-proxy|pac|dns|route:unchanged')
  }
  return {
    controller: new CodexAppIsolationController({ applicationId, adapter, system, entry: async () => laixinEntry }),
    adapter, system, externalChange: () => { current = 'customer-final-value' },
    restoreCount: () => restoreCount
  }
}

describe('N-56 Codex 模型 API 隔离', () => {
  it('只在来信入口有路径证据时改受管 Codex 配置；系统代理、PAC、DNS 和路由逐项保持不变', async () => {
    const f = fixture()

    await expect(f.controller.enable()).resolves.toMatchObject({ available: true, phase: 'available', code: 'AVAILABLE' })

    expect(f.adapter.apply).toHaveBeenCalledTimes(1)
    expect(f.adapter.verifyTarget).toHaveBeenCalledTimes(1)
    expect(f.system.snapshot).toHaveBeenCalledTimes(2)
    expect(f.controller.status()).toEqual(expect.objectContaining({ application: 'codex', scope: 'model-api-egress', capability: 'http-connect', mode: 'application-only', systemNetwork: 'unmanaged', action: 'enable', intentGeneration: expect.any(Number) }))
    expect(JSON.stringify(f.controller.status())).not.toContain('127.0.0.1')
  })

  it.each([
    ['配置写入失败', { apply: vi.fn(async () => { throw new Error('write failed') }) }, 'CONFIG_WRITE_FAILED'],
    ['写后读回不一致', { readback: vi.fn(async () => false) }, 'CONFIG_READBACK_MISMATCH'],
    ['目标复验失败', { verifyTarget: vi.fn(async () => false) }, 'TARGET_UNREACHABLE']
  ] as const)('%s 时完整回滚且不宣布可用', async (_name, overrides, code) => {
    const f = fixture(overrides)

    await expect(f.controller.enable()).resolves.toMatchObject({ available: false, phase: 'limited', code })

    expect(f.adapter.capture).toHaveBeenCalledTimes(1)
    expect(f.restoreCount()).toBe(1)
    expect(f.controller.status()).toMatchObject({ available: false, code })
  })

  it('入口端口不可用或配置路径不明时 fail closed，不写 Codex 配置', async () => {
    const unavailable = fixture()
    const controller = new CodexAppIsolationController({
      applicationId: 'codex', adapter: unavailable.adapter, system: unavailable.system, entry: async () => undefined
    })
    await expect(controller.enable()).resolves.toMatchObject({ phase: 'limited', code: 'ENTRY_UNAVAILABLE' })
    expect(unavailable.adapter.apply).not.toHaveBeenCalled()

    const unknownConfig = fixture({ inspect: vi.fn(async () => undefined) })
    await expect(unknownConfig.controller.enable()).resolves.toMatchObject({ phase: 'limited', code: 'CONFIG_PATH_UNKNOWN' })
    expect(unknownConfig.adapter.apply).not.toHaveBeenCalled()
  })

  it('只接受明确的 HTTP/CONNECT 能力入口，不能把任意模型网关值当作网络代理', async () => {
    const f = fixture()
    const controller = new CodexAppIsolationController({
      applicationId: 'codex', adapter: f.adapter, system: f.system,
      entry: async () => ({ ...laixinEntry, capability: 'model-gateway' } as unknown as typeof laixinEntry)
    })

    await expect(controller.enable()).resolves.toMatchObject({ phase: 'limited', code: 'ENTRY_UNAVAILABLE' })
    expect(f.adapter.activateEntry).not.toHaveBeenCalled()
    expect(f.adapter.apply).not.toHaveBeenCalled()
  })

  it('检查与快照之间 Codex 配置已变化时，旧动作失效且不写入', async () => {
    const clearLease = vi.fn(async () => undefined)
    const f = fixture({
      clearLease,
      capture: vi.fn(async () => ({ beforeFingerprint: 'customer-new-value', beforeIsolationFingerprint: 'customer-new-value', targetIdentity: 'codex-target-a', leaseId: 'b'.repeat(32), restoreIfOwned: async () => 'preserved-external' as const }))
    })

    await expect(f.controller.enable()).resolves.toMatchObject({ available: false, code: 'STALE_OPERATION' })
    expect(f.adapter.apply).not.toHaveBeenCalled()
    expect(f.adapter.activateEntry).not.toHaveBeenCalled()
    expect(clearLease).toHaveBeenCalledWith('b'.repeat(32))
  })

  it('检查与快照之间目标身份已变化时，旧动作失效且不绑定入口或写入配置', async () => {
    const f = fixture({
      capture: vi.fn(async () => ({ beforeFingerprint: 'before-fingerprint', beforeIsolationFingerprint: 'before-isolation-fingerprint', targetIdentity: 'codex-target-b', leaseId: 'b'.repeat(32), restoreIfOwned: async () => 'preserved-external' as const }))
    })

    await expect(f.controller.enable()).resolves.toMatchObject({ available: false, code: 'STALE_OPERATION' })
    expect(f.adapter.activateEntry).not.toHaveBeenCalled()
    expect(f.adapter.apply).not.toHaveBeenCalled()
  })

  it('检查与快照之间仅客户注释变化时也使旧动作失效，不覆盖该受管块', async () => {
    const f = fixture({
      capture: vi.fn(async () => ({ beforeFingerprint: 'before-fingerprint', beforeIsolationFingerprint: 'customer-comment-change', targetIdentity: 'codex-target-a', leaseId: 'b'.repeat(32), restoreIfOwned: async () => 'preserved-external' as const }))
    })

    await expect(f.controller.enable()).resolves.toMatchObject({ available: false, code: 'STALE_OPERATION' })
    expect(f.adapter.apply).not.toHaveBeenCalled()
  })

  it('系统代理、PAC、DNS 或默认路由任一观察值变化时，拒绝可用状态并恢复 Codex 配置', async () => {
    let observations = 0
    const f = fixture()
    f.system.snapshot = vi.fn(async () => ++observations === 1
      ? 'proxy=off|pac=none|dns=customer|route=vpn'
      : 'proxy=off|pac=changed|dns=customer|route=vpn')

    await expect(f.controller.enable()).resolves.toMatchObject({ available: false, phase: 'limited', code: 'SYSTEM_NETWORK_CHANGED' })

    expect(f.restoreCount()).toBe(1)
    expect(f.adapter.deactivateEntry).toHaveBeenCalledOnce()
  })

  it('恢复受管配置或私有会话失败时，给出固定失败码而不伪称已经恢复', async () => {
    const clearLease = vi.fn(async () => undefined)
    const f = fixture({
      clearLease,
      capture: vi.fn(async () => ({ beforeFingerprint: 'before-fingerprint', beforeIsolationFingerprint: 'before-isolation-fingerprint', targetIdentity: 'codex-target-a', leaseId: 'b'.repeat(32), restoreIfOwned: async () => { throw new Error('fixture restore failed') } })),
      verifyTarget: vi.fn(async () => false)
    })

    await expect(f.controller.enable()).resolves.toMatchObject({ available: false, phase: 'limited', code: 'RESTORE_FAILED' })
    expect(f.adapter.deactivateEntry).toHaveBeenCalledOnce()
    expect(clearLease).not.toHaveBeenCalled()
    await expect(f.controller.disable()).resolves.toMatchObject({ available: false, phase: 'limited', code: 'RESTORE_FAILED' })
  })

  it('旧代次的入口绑定失败不能覆盖客户随后发起的关闭状态', async () => {
    const binding = deferred<void>()
    const f = fixture({ activateEntry: vi.fn(async () => binding.promise) })
    const enabling = f.controller.enable()
    await vi.waitFor(() => expect(f.adapter.activateEntry).toHaveBeenCalledOnce())
    const disabling = f.controller.disable()
    binding.reject(new Error('fixture entry unavailable'))

    await expect(enabling).resolves.toMatchObject({ available: false, phase: 'limited', code: 'STALE_OPERATION' })
    await expect(disabling).resolves.toMatchObject({ phase: 'restored', action: 'disable', code: 'RESTORED' })
    expect(f.controller.status()).toMatchObject({ phase: 'restored', action: 'disable', code: 'RESTORED' })
  })

  it('客户中途改 Codex 配置时，旧动作失效并保留客户最终值', async () => {
    const verification = deferred<boolean>()
    const f = fixture({ verifyTarget: vi.fn(async () => verification.promise) })
    const enabling = f.controller.enable()
    await vi.waitFor(() => expect(f.adapter.apply).toHaveBeenCalledOnce())
    f.externalChange()
    const disabling = f.controller.disable()
    verification.resolve(true)

    await expect(enabling).resolves.toMatchObject({ available: false, code: 'STALE_OPERATION' })
    await disabling
    expect(f.restoreCount()).toBe(1)
    expect(f.controller.status()).toMatchObject({ phase: 'restored', code: 'EXTERNAL_VALUE_PRESERVED' })
  })

  it('目标复验期间客户改动配置时，标为外改保留并且不覆盖客户最终值', async () => {
    const verification = deferred<boolean>()
    const f = fixture({ verifyTarget: vi.fn(async () => verification.promise) })
    const enabling = f.controller.enable()
    await vi.waitFor(() => expect(f.adapter.apply).toHaveBeenCalledOnce())
    f.externalChange()
    verification.resolve(true)

    await expect(enabling).resolves.toMatchObject({ available: false, mode: 'disabled', phase: 'restored', code: 'EXTERNAL_VALUE_PRESERVED' })
    expect(f.controller.status()).toMatchObject({ mode: 'disabled', phase: 'restored', code: 'EXTERNAL_VALUE_PRESERVED' })
    expect(f.restoreCount()).toBe(1)
  })

  it('快速开启、关闭、重新开启时，旧代次不能覆盖新状态', async () => {
    const firstVerification = deferred<boolean>()
    let checks = 0
    const f = fixture({ verifyTarget: vi.fn(async () => ++checks === 1 ? firstVerification.promise : true) })
    const first = f.controller.enable()
    await vi.waitFor(() => expect(f.adapter.apply).toHaveBeenCalledOnce())
    const disabling = f.controller.disable()
    const secondPending = f.controller.enable()
    firstVerification.resolve(true)
    await disabling
    const second = await secondPending

    await expect(first).resolves.toMatchObject({ available: false, code: 'STALE_OPERATION' })
    expect(second).toMatchObject({ available: true, phase: 'available' })
    expect(f.controller.status()).toMatchObject({ available: true, phase: 'available' })
  })

  it('退出、崩溃恢复与重复恢复都仅还原本租约仍拥有的值', async () => {
    const f = fixture()
    await f.controller.enable()
    await expect(f.controller.recover()).resolves.toMatchObject({ phase: 'restored', code: 'RESTORED' })
    await expect(f.controller.recover()).resolves.toMatchObject({ phase: 'restored', code: 'RESTORED' })
    expect(f.restoreCount()).toBe(1)
  })

  it('新控制器启动恢复仅消耗持久租约，绝不重新绑定入口或写入配置', async () => {
    const f = fixture({ recoverLease: vi.fn(async () => 'restored' as const) })
    const restarted = new CodexAppIsolationController({ applicationId: 'codex', adapter: f.adapter, system: f.system, entry: async () => laixinEntry })

    await expect(restarted.recover()).resolves.toMatchObject({ phase: 'restored', code: 'RESTORED' })
    expect(restarted.status()).toMatchObject({ phase: 'restored', code: 'RESTORED' })
    await expect(restarted.recover()).resolves.toMatchObject({ phase: 'restored', code: 'RESTORED' })
    expect(f.adapter.recoverLease).toHaveBeenCalledTimes(2)
    expect(f.adapter.activateEntry).not.toHaveBeenCalled()
    expect(f.adapter.apply).not.toHaveBeenCalled()
  })

  it.each(['codex', 'claude', 'hermes'] as const)('%s 持久租约恢复重试成功后，状态和再次关闭不再保留旧失败', async applicationId => {
    const recoverLease = vi.fn(async () => 'restored' as const).mockRejectedValueOnce(new Error('fixture recovery failed'))
    const f = fixture({ recoverLease }, applicationId)
    await expect(f.controller.recover()).resolves.toMatchObject({ code: 'RESTORE_FAILED' })
    await expect(f.controller.disable()).resolves.toMatchObject({ code: 'RESTORE_FAILED' })

    const recovered = await f.controller.recover()

    expect(recovered).toMatchObject({ application: applicationId, phase: 'restored', code: 'RESTORED' })
    expect(f.controller.status()).toEqual(recovered)
    await expect(f.controller.disable()).resolves.toMatchObject({ mode: 'disabled', phase: 'restored', code: 'RESTORED' })
    expect(f.adapter.apply).not.toHaveBeenCalled()
    expect(f.adapter.activateEntry).not.toHaveBeenCalled()
  })

  it('配置租约已恢复但私有入口仍清理失败时，恢复重试不能解除失败保护', async () => {
    const deactivateEntry = vi.fn(async (): Promise<void> => { throw new Error('fixture transport cleanup failed') })
    const f = fixture({ deactivateEntry, recoverLease: vi.fn(async () => 'none' as const) })
    await f.controller.enable()
    await expect(f.controller.disable()).resolves.toMatchObject({ code: 'RESTORE_FAILED' })
    await expect(f.controller.recover()).resolves.toMatchObject({ code: 'RESTORE_FAILED' })
    expect(f.controller.status()).toMatchObject({ code: 'RESTORE_FAILED' })

    deactivateEntry.mockResolvedValueOnce(undefined)
    const recovered = await f.controller.recover()
    expect(recovered).toMatchObject({ mode: 'disabled', phase: 'restored', code: 'RESTORED' })
    expect(f.controller.status()).toEqual(recovered)
    expect(deactivateEntry).toHaveBeenCalledTimes(3)
  })

  it('缺少持久恢复接口时，恢复重试不能仅凭内存无租约清除旧失败', async () => {
    const f = fixture({ deactivateEntry: vi.fn(async () => { throw new Error('fixture cleanup failed') }) })
    await f.controller.enable()
    await expect(f.controller.disable()).resolves.toMatchObject({ code: 'RESTORE_FAILED' })
    await expect(f.controller.recover()).resolves.toMatchObject({ code: 'RESTORE_FAILED' })
    expect(f.controller.status()).toMatchObject({ code: 'RESTORE_FAILED' })
  })

  it('持久恢复保留外部配置后，状态也明确标为外部值已保留', async () => {
    const f = fixture({ recoverLease: vi.fn(async () => 'preserved-external' as const) })
    const recovered = await f.controller.recover()
    expect(recovered).toMatchObject({ mode: 'disabled', phase: 'restored', code: 'EXTERNAL_VALUE_PRESERVED' })
    expect(f.controller.status()).toEqual(recovered)
  })

  it('写入前发现配置陈旧并保留外部值后，状态不再停在配置中', async () => {
    const f = fixture({ apply: vi.fn(async () => { f.externalChange(); return 'stale' as const }) })
    const result = await f.controller.enable()
    expect(result).toMatchObject({ mode: 'disabled', phase: 'restored', code: 'EXTERNAL_VALUE_PRESERVED' })
    expect(f.controller.status()).toEqual(result)
    expect(f.adapter.verifyTarget).not.toHaveBeenCalled()
  })

  it('长期目标健康复验失败时，立即撤销仍属于本租约的配置和私有入口，不留下死代理', async () => {
    let calls = 0
    const f = fixture({ verifyTarget: vi.fn(async () => ++calls === 1) })
    await expect(f.controller.enable()).resolves.toMatchObject({ available: true })

    await expect(f.controller.reverify()).resolves.toMatchObject({ available: false, code: 'TARGET_UNREACHABLE' })

    expect(f.restoreCount()).toBe(1)
    expect(f.adapter.deactivateEntry).toHaveBeenCalledOnce()
    await expect(f.controller.reverify()).resolves.toMatchObject({ code: 'TARGET_UNREACHABLE' })
    expect(f.adapter.deactivateEntry).toHaveBeenCalledOnce()
  })

  it('健康复验发现客户切换 Key 或模型后的配置变化时保留最终值，不把旧租约宣称可用', async () => {
    const f = fixture()
    await expect(f.controller.enable()).resolves.toMatchObject({ available: true })
    f.externalChange()

    await expect(f.controller.reverify()).resolves.toMatchObject({ available: false, code: 'EXTERNAL_VALUE_PRESERVED' })
    expect(f.controller.status()).toMatchObject({ mode: 'disabled', phase: 'restored', code: 'EXTERNAL_VALUE_PRESERVED' })
    await expect(f.controller.reverify()).resolves.toEqual(f.controller.status())
    expect(f.adapter.verifyTarget).toHaveBeenCalledOnce()
    expect(f.adapter.deactivateEntry).toHaveBeenCalledOnce()
  })

  it('健康复验的旧结果不能覆盖客户随后发起的关闭意图', async () => {
    const health = deferred<boolean>()
    let checks = 0
    const f = fixture({ verifyTarget: vi.fn(async () => ++checks === 1 ? true : health.promise) })
    await f.controller.enable()

    const reverify = f.controller.reverify()
    await vi.waitFor(() => expect(f.adapter.verifyTarget).toHaveBeenCalledTimes(2))
    const disabling = f.controller.disable()
    health.resolve(false)

    await reverify
    await expect(disabling).resolves.toMatchObject({ phase: 'restored', action: 'disable', code: 'RESTORED' })
    expect(f.controller.status()).toMatchObject({ phase: 'restored', action: 'disable', code: 'RESTORED' })
  })

  it('长期健康复验只验目标、不重复写配置或累积动作记录', async () => {
    const f = fixture()
    await f.controller.enable()
    await expect(f.controller.enable()).resolves.toMatchObject({ available: true, phase: 'available' })
    for (let index = 0; index < 10_000; index += 1) await f.controller.reverify()

    expect(f.adapter.apply).toHaveBeenCalledTimes(1)
    expect(f.adapter.verifyTarget).toHaveBeenCalledTimes(10_001)
    expect(f.controller.debugOperationCount()).toBe(0)
  })
})
