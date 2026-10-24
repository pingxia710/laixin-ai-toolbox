import { describe, expect, it } from 'vitest'
import { readGatewayDesktopRouteStatus, unavailableDesktopRouteResult } from '../../scripts/verify-codex-desktop-route-output.mjs'

describe('Codex Desktop 诊断状态读取', () => {
  it('只投影 loopback 诊断的固定 status / time / reason，不让进程或连接细节离开主进程', () => {
    const result = readGatewayDesktopRouteStatus({
      status: 'verified', at: '2026-09-13T00:00:00.000Z', reason: 'verified_socket_bound_desktop',
      pid: 777, executable: '/Applications/ChatGPT.app', socket: '127.0.0.1:12345', headers: { authorization: 'secret' }
    })

    expect(result).toEqual({ status: 'verified', at: '2026-09-13T00:00:00.000Z', reason: 'verified_socket_bound_desktop' })
    expect(JSON.stringify(result)).not.toContain('ChatGPT')
    expect(JSON.stringify(result)).not.toContain('authorization')
  })

  it('CLI、请求头、时间窗或手工 JSON 都不能伪造成可显示的严格诊断形状', () => {
    for (const value of [
      { source: 'cli', shell: 'codex', completedAnswer: true },
      { status: 'verified', at: '2026-09-13T00:00:00.000Z', reason: 'manual-claim' },
      { status: 'verified', at: null, reason: 'verified_socket_bound_desktop' },
      { status: 'verified', at: 'Sep 13 2026 (sk-fixture-must-not-echo)', reason: 'verified_socket_bound_desktop' },
      { status: 'unverified', at: null, reason: 'verified_socket_bound_desktop', userAgent: 'Codex Desktop' }
    ]) {
      const result = readGatewayDesktopRouteStatus(value)
      expect(result).toEqual(unavailableDesktopRouteResult())
      expect(JSON.stringify(result)).not.toContain('sk-fixture-must-not-echo')
    }
  })

  it('无法读取运行中 gateway 时只返回固定未验证状态', () => {
    expect(unavailableDesktopRouteResult()).toEqual({ status: 'unverified', at: null, reason: 'socket_binding_unavailable' })
  })
})
