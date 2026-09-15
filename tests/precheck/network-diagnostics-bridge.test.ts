import { afterEach, expect, it, vi } from 'vitest'
const fake = vi.hoisted(() => ({
  closeAllConnections: vi.fn(async () => undefined), setProxy: vi.fn(async () => undefined),
  fetch: vi.fn(async () => new Response(null, { status: 200 })), fromPartition: vi.fn()
}))
vi.mock('electron', () => ({ session: { fromPartition: fake.fromPartition } }))
import { probeDiagnosticUrl, type DiagnosticProbeError } from '../../app/main/network-diagnostics/electron-probe'
import { registerActions } from '../../app/main/actions/network-diagnostics'
import { BridgeRegistry } from '../../app/main/bridge/bridge-registry'
import { DEFAULT_BRIDGE_PORT } from '../../app/main/tunnel/tunnel-service'
import { parseDiagnosticReport } from '../../app/renderer/src/pages/network-diagnostics'

afterEach(() => { vi.clearAllMocks() })

it('固定目标经私有无凭据会话检查，不使用系统或默认浏览器会话', async () => {
  fake.fromPartition.mockReturnValue(fake)
  await probeDiagnosticUrl('https://chatgpt.com/', 'tunnel')
  expect(fake.fromPartition).toHaveBeenCalledWith('toolbox-network-diagnostic-tunnel', { cache: false })
  expect(fake.setProxy).toHaveBeenCalledWith({ mode: 'fixed_servers', proxyRules: `http://127.0.0.1:${DEFAULT_BRIDGE_PORT}`, proxyBypassRules: '<-loopback>' })
  expect(fake.fetch).toHaveBeenCalledWith('https://chatgpt.com/', expect.objectContaining({
    method: 'HEAD', redirect: 'manual', credentials: 'omit', cache: 'no-store', signal: expect.any(AbortSignal)
  }))
  expect(fake.closeAllConnections).toHaveBeenCalledTimes(2)
})

it('探测把超时归为固定类别，不把底层错误文字带到诊断层', async () => {
  fake.fromPartition.mockReturnValue(fake)
  fake.fetch.mockRejectedValueOnce(new DOMException('private-detail', 'TimeoutError'))
  await expect(probeDiagnosticUrl('https://chatgpt.com/', 'tunnel')).rejects.toMatchObject<Partial<DiagnosticProbeError>>({
    name: 'DiagnosticProbeError', kind: 'timeout'
  })
})

it('任意URL、私有地址和错误路由在创建会话前拒绝', async () => {
  for (const url of ['http://127.0.0.1/', 'https://chatgpt.com/?token=private', 'https://evil.invalid/']) {
    await expect(probeDiagnosticUrl(url, 'tunnel')).rejects.toThrow('DIAGNOSTIC_TARGET_INVALID')
  }
  await expect(probeDiagnosticUrl('https://chatgpt.com/', 'direct')).rejects.toThrow('DIAGNOSTIC_TARGET_INVALID')
  expect(fake.fromPartition).not.toHaveBeenCalled()
})

it('桥拒绝额外地址参数，并合并重复点击，不同时切换诊断目标', async () => {
  const registry = new BridgeRegistry()
  let finish!: (value: { status: number, durationMs: number }) => void
  const probe = vi.fn(() => new Promise<{ status: number, durationMs: number }>((resolve) => { finish = resolve }))
  registerActions(registry, { probe, status: () => ({ state: '未配置', lastVerifiedAt: '', configVersion: '', nodeLabel: '', unrestored: '', componentMissing: '' }) })
  await expect(registry.execute('networkdiagnostics.run', { software: 'codex', url: 'http://localhost/' })).rejects.toMatchObject({ code: 'ACTION_PARAMS_INVALID' })
  await expect(registry.execute('networkdiagnostics.run', { software: 'unknown' })).rejects.toMatchObject({ code: 'ACTION_FAILED' })
  const first = registry.execute('networkdiagnostics.run', { software: 'codex' })
  const second = registry.execute('networkdiagnostics.run', { software: 'codex' })
  await expect(registry.execute('networkdiagnostics.run', { software: 'claude' })).rejects.toMatchObject({ code: 'ACTION_FAILED' })
  finish({ status: 204, durationMs: 8 })
  const results = await Promise.all([first, second])
  expect(results[0]).toEqual(results[1]); expect(probe).toHaveBeenCalledTimes(1)
  const report = parseDiagnosticReport((results[0] as { snapshot: string }).snapshot)
  expect(report.software).toBe('codex')
  expect(() => parseDiagnosticReport(JSON.stringify({ ...report, checks: report.checks.map((check) => ({ ...check, code: 'PRIVATE_VALUE' })) }))).toThrow('DIAGNOSTIC_REPORT_INVALID')
})
