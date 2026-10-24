// 甲-6 报告 §五的尾巴(创始人窗口指令 2026-09-16):start/stop 的本机异常在 translateActionError
// 就地翻成受控码,但本机故障记录里**一笔都没有**——客服查 FaultLog 时这两条路径是空白。
// 甲-1 返工合入(948011a)后此文件解封,补上:翻译的同时记一笔,归类与桥层兜底同源
// (actionLocalFault → AI_DIAG_TUNNEL_ACTION_FAILED + tunnel_local_fault +「错误名:fs码」),
// ⛔ 原始消息与路径;NetworkAccountError 是受控网络失败、有自己的口径,⛔ 记成通道本机故障。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BridgeRegistry } from '../../app/main/bridge/bridge-registry'
import { registerActions } from '../../app/main/actions/tunnel'
import { recordFault } from '../../app/main/diagnostics/context'
import type { TunnelService } from '../../app/main/tunnel/tunnel-service'
import { NetworkAccountError } from '../../app/main/tunnel/account-client'

vi.mock('../../app/main/diagnostics/context', async (importOriginal) => {
  return { ...(await importOriginal<object>()), recordFault: vi.fn() }
})

const recordFaultMock = vi.mocked(recordFault)
afterEach(() => recordFaultMock.mockClear())

function stubService(overloads: Partial<Record<'start' | 'stop' | 'status', () => unknown>>): TunnelService {
  return overloads as unknown as TunnelService
}

function registryWith(service: TunnelService): BridgeRegistry {
  const registry = new BridgeRegistry()
  registerActions(registry, { service })
  return registry
}

describe('start/stop 本机异常在翻译处留证(甲-6 §五尾巴)', () => {
  it('stop 抛本地写失败 → 受控码文案照旧,且故障记录里有一笔(错误名:fs码,⛔ 带路径的原始消息)', async () => {
    const registry = registryWith(stubService({
      stop: async () => {
        const failure = new Error("EACCES: permission denied, open '/Users/x/Library/Application Support/laixin/tunnel/intent.json'")
        ;(failure as NodeJS.ErrnoException).code = 'EACCES'
        throw failure
      }
    }))
    const result = await registry.execute('tunnel.stop', undefined) as { outcome: string; code: string; message: string }
    expect(result.outcome).toBe('rejected')
    expect(result.code).toBe('TUNNEL_LOCAL_WRITE_FAILED')
    // 留证:归类与桥层兜底同源——通道码 + tunnel_local_fault +「错误名:fs码」
    expect(recordFaultMock).toHaveBeenCalledTimes(1)
    const fault = recordFaultMock.mock.calls[0]?.[0]
    expect(fault?.network).toBe('AI_DIAG_TUNNEL_ACTION_FAILED')
    expect(fault?.note).toBe('tunnel_local_fault')
    expect(fault?.noteParams).toEqual(['Error:EACCES'])
    expect(JSON.stringify(fault)).not.toContain('/Users/x/Library')
  })

  it('start 抛程序错误(TypeError) → TUNNEL_LOCAL_UNEXPECTED 照旧,故障记录同样有一笔', async () => {
    const registry = registryWith(stubService({
      start: async () => { throw new TypeError('Cannot read properties of undefined') }
    }))
    const result = await registry.execute('tunnel.start', undefined) as { outcome: string; code: string }
    expect(result.outcome).toBe('rejected')
    expect(result.code).toBe('TUNNEL_LOCAL_UNEXPECTED')
    expect(recordFaultMock).toHaveBeenCalledTimes(1)
    const fault = recordFaultMock.mock.calls[0]?.[0]
    expect(fault?.network).toBe('AI_DIAG_TUNNEL_ACTION_FAILED')
    expect(fault?.noteParams).toEqual(['TypeError'])
  })

  it('NetworkAccountError(受控网络失败) → 不往本机故障记录里塞通道故障(基线即绿,守口径)', async () => {
    const registry = registryWith(stubService({
      start: async () => { throw new NetworkAccountError('NETWORK_LOGIN_REQUIRED') }
    }))
    const result = await registry.execute('tunnel.start', undefined) as { outcome: string; code: string }
    expect(result.outcome).toBe('rejected')
    expect(result.code).toBe('NETWORK_LOGIN_REQUIRED')
    expect(recordFaultMock).not.toHaveBeenCalled()
  })
})
