import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { appendSettingEntry, loadLedger } from '../../sidecar/mac/ledger.mjs'
import { createEmergencyRecoveryAdapter } from '../../sidecar/mac/emergency-recovery-adapter.mjs'
import { recoverAfterAdapterLoadFailure } from '../../sidecar/mac/tunnel-daemon.mjs'
import { makeTempDir, removeTempDir } from './helpers'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach(removeTempDir))

describe('adapter 传递依赖损坏时的独立恢复通道', () => {
  it('紧急原语的系统命令带独立 deadline', async () => {
    const options: Array<Record<string, unknown> | undefined> = []
    const adapter = await createEmergencyRecoveryAdapter({
      platform: 'darwin',
      exec: (_command: string, args: readonly string[], callOptions: Record<string, unknown> = {}) => {
        options.push(callOptions)
        return args[0] === '-getsecurewebproxy' ? 'Enabled: No\nServer: \nPort: 0\n' : ''
      }
    })
    adapter.read({ service: 'Wi-Fi', item: 'secure-web-proxy' })
    expect(options[0]?.timeout).toBe(5_000)
    expect(typeof adapter.acquireWriteRight).toBe('function')
  })

  it('普通 adapter 无法加载时，最小 Mac 原语仍能按账本写回已应用代理', async () => {
    const dataDir = makeTempDir('emergency-recovery-')
    roots.push(dataDir)
    let value = { enabled: true, host: '127.0.0.1', port: 18080 }
    const calls: string[][] = []
    const adapter = await createEmergencyRecoveryAdapter({
      platform: 'darwin',
      exec: (_command: string, args: readonly string[]) => {
        calls.push([...args])
        if (args[0] === '-getsecurewebproxy') {
          return `Enabled: ${value.enabled ? 'Yes' : 'No'}\nServer: ${value.host}\nPort: ${String(value.port)}\n`
        }
        if (args[0] === '-setsecurewebproxy') value = { enabled: true, host: args[2], port: Number(args[3]) }
        if (args[0] === '-setsecurewebproxystate' && args[2] === 'off') value = { ...value, enabled: false }
        return ''
      }
    })
    appendSettingEntry(dataDir, {
      service: 'Wi-Fi', item: 'secure-web-proxy', originalValue: { enabled: false, host: '', port: 0 },
      writtenValue: { enabled: true, host: '127.0.0.1', port: 18080 }, sessionToken: 'adapter-load-failure', time: Date.now()
    })

    const result = await recoverAfterAdapterLoadFailure({ dataDir, runId: 'broken-adapter-run', recoveryOwnershipObserved: { generation: 0 }, createAdapter: () => adapter })
    expect(result).toEqual({ restored: true, handedOver: false })
    expect(value.enabled).toBe(false)
    expect(calls).toContainEqual(['-setsecurewebproxystate', 'Wi-Fi', 'off'])
    expect((loadLedger(dataDir).at(-1) as { status?: string } | undefined)?.status).toBe('restored')
  })

  it('陈旧 connected 状态快照不能让 adapter-load-failure 跳过恢复', async () => {
    const dataDir = makeTempDir('emergency-stale-state-')
    roots.push(dataDir)
    writeFileSync(join(dataDir, 'state.json'), JSON.stringify({ state: 'connected', runId: 'old-run' }))
    let value = { enabled: true, host: '127.0.0.1', port: 18080 }
    const adapter = await createEmergencyRecoveryAdapter({
      platform: 'darwin',
      exec: (_command: string, args: readonly string[]) => {
        if (args[0] === '-getsecurewebproxy') {
          return `Enabled: ${value.enabled ? 'Yes' : 'No'}\nServer: ${value.host}\nPort: ${String(value.port)}\n`
        }
        if (args[0] === '-setsecurewebproxystate' && args[2] === 'off') value = { ...value, enabled: false }
        return ''
      }
    })
    appendSettingEntry(dataDir, {
      service: 'Wi-Fi', item: 'secure-web-proxy', originalValue: { enabled: false, host: '', port: 0 },
      writtenValue: { enabled: true, host: '127.0.0.1', port: 18080 }, sessionToken: 'stale-state', time: Date.now()
    })

    const result = await recoverAfterAdapterLoadFailure({ dataDir, runId: 'new-run', recoveryOwnershipObserved: { generation: 0 }, createAdapter: () => adapter })
    expect(result).toEqual({ restored: true, handedOver: false })
    expect(value.enabled).toBe(false)
  })

  it('空账本且仍有死桥代理时不能报告已恢复', async () => {
    const dataDir = makeTempDir('emergency-empty-ledger-')
    roots.push(dataDir)
    const adapter = {
      managedItems: () => [],
      readProxyEndpoints: () => [{ host: '127.0.0.1', port: 18080 }],
      identifyPortOwner: () => ({ kind: 'none' }),
      acquireWriteRight: () => ({ acquired: true, release: () => undefined }),
      read: () => null,
      write: () => {}
    }
    const result = await recoverAfterAdapterLoadFailure({ dataDir, runId: 'empty-ledger-run', recoveryOwnershipObserved: { generation: 0 }, createAdapter: () => adapter })
    expect(result).toEqual({ restored: false, handedOver: false })
    expect(readFileSync(join(dataDir, 'state.json'), 'utf8')).toContain('尚未确认恢复')
  })

  it('紧急 Windows 适配器解析多协议 ProxyServer 并识别死桥残留', async () => {
    const adapter = await createEmergencyRecoveryAdapter({
      platform: 'win32',
      exec: (_command: string, args: readonly string[]) => {
        if (args[0] === 'query' && args.includes('ProxyEnable')) return 'ProxyEnable    REG_DWORD    0x1\n'
        if (args[0] === 'query' && args.includes('ProxyServer')) return 'ProxyServer    REG_SZ    http=127.0.0.1:18080;https=127.0.0.1:18080\n'
        return ''
      }
    })
    expect(adapter.readProxyEndpoints()).toEqual([
      { host: '127.0.0.1', port: 18080 },
      { host: '127.0.0.1', port: 18080 }
    ])
  })

  it('紧急 Windows 适配器解析 IPv6 回环死桥', async () => {
    const adapter = await createEmergencyRecoveryAdapter({
      platform: 'win32',
      exec: (_command: string, args: readonly string[]) => {
        if (args[0] === 'query' && args.includes('ProxyEnable')) return 'ProxyEnable    REG_DWORD    0x1\n'
        if (args[0] === 'query' && args.includes('ProxyServer')) return 'ProxyServer    REG_SZ    [::1]:18080\n'
        return ''
      }
    })
    expect(adapter.readProxyEndpoints()).toEqual([{ host: '::1', port: 18080 }])
  })

  it('启用但格式损坏的 ProxyServer 以检查失败处理而不是空代理', async () => {
    const adapter = await createEmergencyRecoveryAdapter({
      platform: 'win32',
      exec: (_command: string, args: readonly string[]) => {
        if (args[0] === 'query' && args.includes('ProxyEnable')) return 'ProxyEnable    REG_DWORD    0x1\n'
        if (args[0] === 'query' && args.includes('ProxyServer')) return 'ProxyServer    REG_SZ    garbage\n'
        return ''
      }
    })
    expect(() => adapter.readProxyEndpoints()).toThrow('EMERGENCY_PROXY_SERVER_INVALID')
  })

  it('紧急 Windows 适配器按注册表数值比较 REG_DWORD 而非字符串', async () => {
    const adapter = await createEmergencyRecoveryAdapter({
      platform: 'win32',
      exec: () => ''
    })
    expect(adapter.valuesEqual(
      { type: 'REG_DWORD', data: '0x0' },
      { type: 'REG_DWORD', data: '0' }
    )).toBe(true)
  })

  it('紧急 Windows 适配器按 WPAD autoDetect 位比较 REG_BINARY', async () => {
    const adapter = await createEmergencyRecoveryAdapter({ platform: 'win32', exec: () => '' })
    expect(adapter.valuesEqual(
      { type: 'REG_BINARY', data: '460000000100000008000000' },
      { type: 'REG_BINARY', data: '460000000200000008000000' }
    )).toBe(true)
  })
})
