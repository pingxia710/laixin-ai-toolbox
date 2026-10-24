import { describe, expect, it, vi } from 'vitest'
import { DiagnosticProbeError, runNetworkDiagnostics, type DiagnosticOptions, type DiagnosticSelection,
  type DiagnosticTunnel } from '../../app/main/network-diagnostics/service'

const now = 1_800_000_000_000
const connected: DiagnosticTunnel = {
  state: '已连', lastVerifiedAt: new Date(now).toISOString(), configVersion: 'cfg-path-matrix',
  nodeLabel: 'fixture-node', unrestored: '', componentMissing: ''
}

function options(overrides: Partial<DiagnosticOptions> = {}): DiagnosticOptions {
  return {
    now: () => now,
    status: () => connected,
    selection: async () => ({ mode: 'official' }),
    probe: vi.fn(async (url: string) => ({ status: url.includes('generate_204') ? 204 : 200, durationMs: 18 })),
    ...overrides
  }
}

describe('N-54 失败触发路径矩阵', () => {
  it('主路径成功时零额外探测，也不生成路径矩阵', async () => {
    const deps = options()

    const report = await runNetworkDiagnostics('codex', deps)

    expect(deps.probe).toHaveBeenCalledTimes(2)
    expect(report.pathMatrix).toBeUndefined()
  })

  it('目标已经返回 HTTP 状态时路径已通，不因服务端 5xx 误触发对照', async () => {
    const probe = vi.fn(async (url: string) => ({ status: url.includes('generate_204') ? 204 : 503, durationMs: 18 }))

    const report = await runNetworkDiagnostics('codex', options({ probe }))

    expect(probe).toHaveBeenCalledTimes(2)
    expect(report.checks.find(check => check.id === 'service')).toMatchObject({ code: 'AI_DIAG_SERVICE_ERROR', phase: 'http' })
    expect(report.pathMatrix).toBeUndefined()
  })

  it('主路径失败后用同一目标并行比较三条路径，结果按路径各自归属', async () => {
    const target = 'https://chatgpt.com/'
    const probe = vi.fn(async (url: string, route: string) => {
      if (url.includes('generate_204')) return { status: 204, durationMs: 7 }
      if (route === 'tunnel') throw new DiagnosticProbeError('unavailable', 31, 'proxy')
      if (route === 'direct') return { status: 200, durationMs: 11, phase: 'http' as const }
      if (route === 'existing-proxy') throw new DiagnosticProbeError('unavailable', 17, 'tls')
      throw new DiagnosticProbeError('unavailable', 23, 'connection')
    })

    const report = await runNetworkDiagnostics('codex', options({ probe }))

    expect(probe.mock.calls).toEqual([
      ['https://connectivitycheck.platform.hicloud.com/generate_204', 'direct'],
      [target, 'tunnel'],
      [target, 'direct'],
      [target, 'existing-proxy'],
      [target, 'laixin-tunnel']
    ])
    expect(report.pathMatrix).toEqual({
      checkedAt: report.checkedAt,
      valid: true,
      entries: [
        expect.objectContaining({ path: 'direct', state: 'reachable', phase: 'http', elapsedMs: 11 }),
        expect.objectContaining({ path: 'existing-proxy', state: 'failed', phase: 'tls', elapsedMs: 17 }),
        expect.objectContaining({ path: 'laixin-tunnel', state: 'failed', phase: 'connection', elapsedMs: 23 })
      ]
    })
  })

  it('某一路不返回时由独立时限收口，不拖死另两条路径', async () => {
    const never = new Promise<never>(() => undefined)
    const probe = vi.fn(async (url: string, route: string) => {
      if (url.includes('generate_204')) return { status: 204, durationMs: 7 }
      if (route === 'existing-proxy') return never
      if (route === 'direct') return { status: 200, durationMs: 9, phase: 'http' as const }
      throw new DiagnosticProbeError('unavailable', 15, route === 'tunnel' ? 'proxy' : 'connection')
    })
    const deps: DiagnosticOptions = {
      ...options({ probe }),
      matrixProbeTimeoutMs: 10
    }

    const report = await Promise.race([
      runNetworkDiagnostics('codex', deps),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('matrix did not settle')), 500))
    ])

    expect(report.pathMatrix?.entries).toEqual([
      expect.objectContaining({ path: 'direct', state: 'reachable' }),
      expect.objectContaining({ path: 'existing-proxy', state: 'failed' }),
      expect.objectContaining({ path: 'laixin-tunnel', state: 'failed' })
    ])
  })

  it('检查期间模型或路径配置变化时，整份旧矩阵明确失效', async () => {
    const selections: DiagnosticSelection[] = [{ mode: 'deepseek' }, { mode: 'zhipu' }]
    const report = await runNetworkDiagnostics('codex', options({
      selection: vi.fn(async () => selections.shift() ?? selections[0]),
      probe: vi.fn(async (url: string, route: string) => {
        if (url.includes('generate_204')) return { status: 204, durationMs: 7 }
        if (route === 'direct' && url.includes('deepseek')) throw new DiagnosticProbeError('unavailable', 12, 'connection')
        return { status: 200, durationMs: 9, phase: 'http' as const }
      })
    }))

    expect(report.pathMatrix).toMatchObject({ checkedAt: report.checkedAt, valid: false })
    expect(report.conclusion.ruleId).toBe('DG01_EVIDENCE_CHANGED')
  })

  it('三路径对照期间通道归属变化时，矩阵与主路径证据一起失效', async () => {
    let tunnel = connected
    const report = await runNetworkDiagnostics('codex', options({
      status: () => tunnel,
      probe: vi.fn(async (url: string, route: string) => {
        if (url.includes('generate_204')) return { status: 204, durationMs: 7 }
        if (route === 'laixin-tunnel') tunnel = { ...connected, configVersion: 'cfg-changed' }
        throw new DiagnosticProbeError('unavailable', 12, route === 'existing-proxy' ? 'tls' : 'connection')
      })
    }))

    expect(report.pathMatrix).toMatchObject({ checkedAt: report.checkedAt, valid: false })
    expect(report.conclusion.ruleId).toBe('DG01_EVIDENCE_CHANGED')
  })

  it('直连目标失败后做矩阵时也绑定来信通道代次', async () => {
    let tunnel = connected
    const report = await runNetworkDiagnostics('hermes', options({
      selection: vi.fn(async () => ({ mode: 'deepseek' as const })),
      status: () => tunnel,
      probe: vi.fn(async (url: string, route: string) => {
        if (url.includes('generate_204')) return { status: 204, durationMs: 7 }
        if (route === 'laixin-tunnel') tunnel = { ...connected, configVersion: 'cfg-direct-changed' }
        throw new DiagnosticProbeError('unavailable', 12, route === 'existing-proxy' ? 'proxy' : 'connection')
      })
    }))

    expect(report.target.route).toBe('direct')
    expect(report.pathMatrix).toMatchObject({ checkedAt: report.checkedAt, valid: false })
    expect(report.conclusion.ruleId).toBe('DG01_EVIDENCE_CHANGED')
  })

  it('系统代理或路径入口在矩阵期间变化时失效，不使用混合证据', async () => {
    const fingerprints = ['path-before', 'path-after']
    const report = await runNetworkDiagnostics('codex', options({
      pathContext: vi.fn(async () => fingerprints.shift() ?? 'path-after'),
      probe: vi.fn(async (url: string, route: string) => {
        if (url.includes('generate_204')) return { status: 204, durationMs: 7 }
        throw new DiagnosticProbeError('unavailable', 12, route === 'existing-proxy' ? 'proxy' : 'connection')
      })
    }))

    expect(report.pathMatrix).toMatchObject({ checkedAt: report.checkedAt, valid: false })
    expect(report.checks.find(check => check.id === 'service')).toMatchObject({ code: 'AI_DIAG_CONTEXT_CHANGED' })
    expect(report.conclusion.ruleId).toBe('DG01_EVIDENCE_CHANGED')
  })

  it('路径上下文读不到时矩阵失效，但不冒充已证实的配置变化', async () => {
    const report = await runNetworkDiagnostics('codex', options({
      matrixProbeTimeoutMs: 10,
      pathContext: vi.fn(async () => { throw new Error('private path context detail') }),
      probe: vi.fn(async (url: string, route: string) => {
        if (url.includes('generate_204')) return { status: 204, durationMs: 7 }
        throw new DiagnosticProbeError('unavailable', 12, route === 'existing-proxy' ? 'proxy' : 'connection')
      })
    }))

    expect(report.pathMatrix).toMatchObject({ checkedAt: report.checkedAt, valid: false })
    expect(report.checks.find(check => check.id === 'service')).toMatchObject({ code: 'AI_DIAG_PATH_CONTEXT_UNKNOWN' })
    expect(report.conclusion).toMatchObject({ ruleId: 'DG01_CONTEXT_UNREADABLE', title: '本次路径对照无法核对' })
    expect(JSON.stringify(report)).not.toContain('private path context detail')
  })

  it('原始错误、URL、IP、代理地址和证书正文都不进入矩阵快照', async () => {
    const secrets = 'https://private.example/ 10.0.0.8 proxy.local:7890 CERTIFICATE BODY'
    const report = await runNetworkDiagnostics('codex', options({
      probe: vi.fn(async (url: string) => {
        if (url.includes('generate_204')) return { status: 204, durationMs: 7 }
        throw Object.assign(new Error(secrets), { url, certificate: secrets })
      })
    }))

    expect(report.pathMatrix?.entries).toHaveLength(3)
    expect(JSON.stringify(report)).not.toContain(secrets)
    expect(JSON.stringify(report)).not.toContain('private.example')
    expect(JSON.stringify(report)).not.toContain('10.0.0.8')
    expect(JSON.stringify(report)).not.toContain('proxy.local')
  })
})
