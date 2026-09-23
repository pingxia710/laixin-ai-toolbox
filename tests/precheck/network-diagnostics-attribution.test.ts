import { describe, expect, it, vi } from 'vitest'
import { DiagnosticProbeError, runNetworkDiagnostics, type DiagnosticOptions, type DiagnosticSelection, type DiagnosticTunnel } from '../../app/main/network-diagnostics/service'

const now = 1_800_000_000_000
const connected: DiagnosticTunnel = {
  state: '已连', lastVerifiedAt: new Date(now).toISOString(), configVersion: 'cfg-2', nodeLabel: 'fixture-node', unrestored: '', componentMissing: ''
}

function diagnostic(overrides: Partial<DiagnosticOptions> = {}): DiagnosticOptions {
  return {
    now: () => now,
    status: () => connected,
    selection: async () => ({ mode: 'deepseek', routed: true, serviceRunning: true, observedClientCall: null }),
    probe: vi.fn(async (url: string) => ({ status: url.includes('generate_204') ? 204 : 200, durationMs: 18 })),
    ...overrides
  }
}

describe('DG-01 同次证据归因', () => {
  it('单个国内探测地址失败：目标仍有响应时不说整机断网或账号失效', async () => {
    const report = await runNetworkDiagnostics('codex', diagnostic({
      probe: vi.fn(async (url: string) => {
        if (url.includes('generate_204')) throw new DiagnosticProbeError('unavailable', 21)
        return { status: 200, durationMs: 18 }
      })
    }))

    expect(report.conclusion).toMatchObject({ status: 'unknown', ruleId: 'DG01_APPLICATION_UNCONFIRMED', scope: 'application' })
    expect(report.conclusion.evidence.map(item => item.code)).toContain('AI_DIAG_SERVICE_REACHABLE')
    expect(`${report.conclusion.summary}${report.conclusion.nextStep}`).not.toMatch(/整机断网|账号失效/)
  })

  it('国内模型不要求外网；本机 API 服务停止时优先指出本机问题', async () => {
    const report = await runNetworkDiagnostics('codex', diagnostic({
      status: () => ({ ...connected, state: '未配置', lastVerifiedAt: '' }),
      selection: async () => ({ mode: 'deepseek', routed: true, serviceRunning: false, observedClientCall: null })
    }))

    expect(report.checks.find(check => check.id === 'tunnel')).toMatchObject({ state: 'not-checked', code: 'AI_DIAG_DIRECT_SERVICE' })
    expect(report.conclusion).toMatchObject({ status: 'blocked', ruleId: 'DG01_LOCAL_SERVICE_DOWN', scope: 'local-service' })
    expect(report.conclusion.nextStep).toContain('重启本机 API 服务')
  })

  it.each([401, 403, 429])('未带客户认证的根地址返回 %s：只保留响应边界，不判断 Key、欠费或封号', async (status) => {
    const report = await runNetworkDiagnostics('codex', diagnostic({
      probe: vi.fn(async (url: string) => ({ status: url.includes('generate_204') ? 204 : status, durationMs: 18 }))
    }))

    expect(report.conclusion).toMatchObject({ status: 'limited', ruleId: 'DG01_TARGET_RESPONSE_BOUNDARY', scope: 'target-service' })
    expect(`${report.conclusion.summary}${report.conclusion.nextStep}`).not.toMatch(/Key 错|欠费|封号/)
  })

  it('通道有效但目标不可达：只定位当前路径，无节点侧证据不说服务器故障', async () => {
    const report = await runNetworkDiagnostics('codex', diagnostic({
      selection: async () => ({ mode: 'official' }),
      probe: vi.fn(async (url: string) => {
        if (url.includes('generate_204')) return { status: 204, durationMs: 18 }
        throw new DiagnosticProbeError('unavailable', 35)
      })
    }))

    expect(report.conclusion).toMatchObject({ status: 'unknown', ruleId: 'DG01_TARGET_PATH_UNCONFIRMED', scope: 'target-path' })
    expect(report.conclusion.summary).toContain('经当前通道')
    expect(report.conclusion.summary).not.toContain('服务器故障')
  })

  it('诊断期间切换配置：旧目标证据失效并要求重新检查', async () => {
    const selections: DiagnosticSelection[] = [
      { mode: 'deepseek', routed: true, serviceRunning: true, observedClientCall: null },
      { mode: 'zhipu', routed: true, serviceRunning: true, observedClientCall: null }
    ]
    const report = await runNetworkDiagnostics('codex', diagnostic({ selection: vi.fn(async () => selections.shift() ?? selections[0]) }))

    expect(report.checks.find(check => check.id === 'service')).toMatchObject({ state: 'unknown', code: 'AI_DIAG_CONTEXT_CHANGED' })
    expect(report.conclusion).toMatchObject({ status: 'unknown', ruleId: 'DG01_EVIDENCE_CHANGED', scope: 'diagnostic-context' })
    expect(report.conclusion.nextStep).toContain('重新检查')
  })

  it('通道校验在探测期间跨过有效期：状态和配置未变也要使旧证据失效', async () => {
    let currentNow = now
    const nearExpiry = { ...connected, lastVerifiedAt: new Date(now - 89_000).toISOString() }
    const report = await runNetworkDiagnostics('codex', diagnostic({
      now: () => currentNow,
      status: () => nearExpiry,
      selection: async () => ({ mode: 'official', observedClientCall: new Date(now - 1_000).toISOString() }),
      probe: vi.fn(async (url: string) => {
        if (!url.includes('generate_204')) currentNow += 2_000
        return { status: url.includes('generate_204') ? 204 : 200, durationMs: 18 }
      })
    }))

    expect(report.checks.find(check => check.id === 'service')).toMatchObject({ state: 'unknown', code: 'AI_DIAG_TUNNEL_CHANGED' })
    expect(report.conclusion).toMatchObject({ status: 'unknown', ruleId: 'DG01_EVIDENCE_CHANGED', scope: 'diagnostic-context' })
    expect(report.conclusion.nextStep).toContain('重新检查')
  })

  it('通道校验临近过期但结束时已有新鲜记录：保持本次结果，不误报证据变化', async () => {
    let currentNow = now
    let currentTunnel = { ...connected, lastVerifiedAt: new Date(now - 89_000).toISOString() }
    const report = await runNetworkDiagnostics('codex', diagnostic({
      now: () => currentNow,
      status: () => currentTunnel,
      selection: async () => ({ mode: 'official', observedClientCall: new Date(now - 1_000).toISOString() }),
      probe: vi.fn(async (url: string) => {
        if (!url.includes('generate_204')) {
          currentNow += 2_000
          currentTunnel = { ...currentTunnel, lastVerifiedAt: new Date(currentNow).toISOString() }
        }
        return { status: url.includes('generate_204') ? 204 : 200, durationMs: 18 }
      })
    }))

    expect(report.checks.find(check => check.id === 'service')).toMatchObject({ state: 'passed', code: 'AI_DIAG_SERVICE_REACHABLE' })
    expect(report.conclusion).toMatchObject({ status: 'clear', ruleId: 'DG01_NO_BLOCKER_FOUND', scope: 'none' })
    expect(`${report.conclusion.summary}${report.conclusion.nextStep}`).not.toMatch(/证据已失效|重新检查/)
  })

  it('诊断期间刚发生正常请求：使用同配置的最新调用证据，不沿用开始时的未确认状态', async () => {
    const selections: DiagnosticSelection[] = [
      { mode: 'deepseek', routed: true, serviceRunning: true, observedClientCall: null },
      { mode: 'deepseek', routed: true, serviceRunning: true, observedClientCall: new Date(now - 1_000).toISOString() }
    ]
    const report = await runNetworkDiagnostics('codex', diagnostic({ selection: vi.fn(async () => selections.shift() ?? selections[0]) }))

    expect(report.checks.find(check => check.id === 'service')).toMatchObject({ state: 'passed', code: 'AI_DIAG_SERVICE_REACHABLE' })
    expect(report.checks.find(check => check.id === 'application')).toMatchObject({ state: 'passed', code: 'AI_DIAG_APPLICATION_OBSERVED' })
    expect(report.conclusion).toMatchObject({ status: 'clear', ruleId: 'DG01_NO_BLOCKER_FOUND', scope: 'none' })
  })

  it('同一配置的本机服务运行态变化：属于运行证据更新，不误判模型配置变化', async () => {
    const selections: DiagnosticSelection[] = [
      { mode: 'deepseek', routed: true, serviceRunning: false, observedClientCall: null },
      { mode: 'deepseek', routed: true, serviceRunning: true, observedClientCall: new Date(now - 1_000).toISOString() }
    ]
    const report = await runNetworkDiagnostics('codex', diagnostic({ selection: vi.fn(async () => selections.shift() ?? selections[0]) }))

    expect(report.checks.find(check => check.id === 'service')?.code).not.toBe('AI_DIAG_CONTEXT_CHANGED')
    expect(report.checks.find(check => check.id === 'application')).toMatchObject({ state: 'passed', code: 'AI_DIAG_APPLICATION_OBSERVED' })
    expect(report.conclusion).toMatchObject({ status: 'clear', ruleId: 'DG01_NO_BLOCKER_FOUND' })
  })

  it('读不到通道或无法归因：如实显示未知，并给重新检查这一个下一步', async () => {
    const report = await runNetworkDiagnostics('codex', diagnostic({
      status: () => { throw new Error('fixture unreadable') },
      selection: async () => { throw new Error('fixture unreadable') }
    }))

    expect(report.checks.find(check => check.id === 'tunnel')).toMatchObject({ state: 'unknown', code: 'AI_DIAG_TUNNEL_UNKNOWN' })
    expect(report.conclusion).toMatchObject({ status: 'unknown', ruleId: 'DG01_CONTEXT_UNREADABLE', scope: 'diagnostic-context' })
    expect(report.conclusion.nextStep).toContain('重新检查')
  })

  it('正常对照：同次目标响应且刚观察到应用调用，不报故障', async () => {
    const report = await runNetworkDiagnostics('hermes', diagnostic({
      selection: async () => ({ mode: 'deepseek', routed: true, serviceRunning: true, observedClientCall: new Date(now - 1_000).toISOString() })
    }))

    expect(report.conclusion).toMatchObject({ status: 'clear', ruleId: 'DG01_NO_BLOCKER_FOUND', scope: 'none' })
    expect(report.conclusion.summary).not.toMatch(/故障|断网|失效/)
  })

  it('旧应用成功时间不再当作本次成功；报告也带统一过期边界', async () => {
    const report = await runNetworkDiagnostics('codex', diagnostic({
      selection: async () => ({ mode: 'deepseek', routed: true, serviceRunning: true, observedClientCall: new Date(now - 30 * 60_000).toISOString() })
    }))

    expect(report.checks.find(check => check.id === 'application')).toMatchObject({ state: 'not-checked', code: 'AI_DIAG_APPLICATION_STALE' })
    expect(report.conclusion.status).toBe('unknown')
    expect(report.validUntil).toBe(report.checkedAt + 10 * 60_000)
  })
})
