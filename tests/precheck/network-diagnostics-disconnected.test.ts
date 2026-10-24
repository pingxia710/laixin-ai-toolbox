import { describe, expect, it, vi } from 'vitest'
import { runNetworkDiagnostics, DiagnosticProbeError, type DiagnosticOptions } from '../../app/main/network-diagnostics/service'
import { parseDiagnosticReport } from '../../app/renderer/src/pages/network-diagnostics'

function fixture() {
  return {
    now: () => 1_800_000_000_000,
    status: () => ({ state: '未连', lastVerifiedAt: '', configVersion: '', nodeLabel: '', unrestored: '', componentMissing: '' }),
    pathContext: vi.fn(async () => 'same-path'),
    matrixProbeTimeoutMs: 10,
    probe: vi.fn(async (url: string, route: string) => {
      if (route === 'existing-proxy') throw new DiagnosticProbeError('unavailable', 5, 'proxy')
      if (route !== 'direct') throw new Error('must not dial an unavailable tunnel')
      return { status: url.includes('generate_204') ? 204 : 200, durationMs: 3 }
    })
  } satisfies DiagnosticOptions
}

describe('通道不可用时的独立路径检查', () => {
  it('直连与已有代理仍检查，没有来信入口不探测、不建链，报告可被界面读取', async () => {
    const deps = fixture()
    const report = await runNetworkDiagnostics('codex', deps)
    expect(report.pathMatrix).toMatchObject({ valid: true, entries: [
      { path: 'direct', state: 'reachable' }, { path: 'existing-proxy', state: 'failed' },
      { path: 'laixin-tunnel', state: 'unavailable' }
    ] })
    expect(deps.probe.mock.calls.map(call => call[1])).toEqual(['direct', 'direct', 'existing-proxy'])
    expect(deps.pathContext).toHaveBeenCalledTimes(2)
    expect(report.checks[2]).toMatchObject({ state: 'unknown', code: 'AI_DIAG_PRIMARY_PATH_UNAVAILABLE' })
    expect(parseDiagnosticReport(JSON.stringify(report))).toEqual(report)
  })
  it('独立路径超时有界，配置变化使本次对照失效，原始错误不外泄', async () => {
    const deps = fixture()
    let reads = 0
    const report = await runNetworkDiagnostics('codex', { ...deps,
      pathContext: async () => String(++reads),
      probe: async (url, route) => {
        if (url.includes('generate_204')) return { status: 204, durationMs: 1 }
        if (route === 'direct') return new Promise(() => undefined)
        throw new Error('private-proxy-password')
      }
    })
    expect(report.pathMatrix).toMatchObject({ valid: false, entries: [
      { state: 'failed' }, { state: 'failed' }, { state: 'unavailable' }
    ] })
    expect(report.conclusion.ruleId).toBe('DG01_EVIDENCE_CHANGED')
    expect(JSON.stringify(report)).not.toContain('private-proxy-password')
  })
  it('通道状态未知时不以矩阵成功冒充主路径已通', async () => {
    const report = await runNetworkDiagnostics('codex', { ...fixture(), status: () => { throw new Error('unknown') } })
    expect(report.pathMatrix?.entries[0].state).toBe('reachable')
    expect(report.checks[1].state).toBe('unknown')
    expect(report.checks[2].state).toBe('unknown')
    expect(report.conclusion.status).not.toBe('clear')
  })
})
