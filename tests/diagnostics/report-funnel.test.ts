import { describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildReportBody } from '../../app/main/diagnostics/report-bundle'
import { collectLocalFiles, nodeReportFiles } from '../../app/main/diagnostics/report-collect'

// N-79:连接漏斗台账进诊断包——采集到、白名单验形、被改写的行整条丢弃。
const okAttempt = {
  trigger: 'connect',
  startedAt: 1_700_000_000_000,
  stages: [
    { name: 'connector-start', durationMs: 320, outcome: 'ok', at: 1_700_000_000_000 },
    { name: 'settings-write', durationMs: 45, outcome: 'error', code: '已有代理控制', at: 1_700_000_000_320 }
  ],
  outcome: 'fatal',
  endedAt: 1_700_000_000_365,
  code: '已有代理控制'
}

describe('连接漏斗台账进诊断包(N-79)', () => {
  it('采集到 connection-funnel.json,包内含白名单字段,自由文本行被丢弃', async () => {
    const tunnelDataDir = join(tmpdir(), `laixin-funnel-report-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(tunnelDataDir, { recursive: true })
    writeFileSync(join(tunnelDataDir, 'connection-funnel.json'), JSON.stringify({
      attempts: [
        okAttempt,
        // 被改写的行:trigger 自由文本 + 阶段名非法,⛔ 进包。
        { trigger: '<script>x</script>', startedAt: 1, stages: [{ name: 'BAD NAME!', durationMs: 1, outcome: 'ok' }], outcome: 'connected', endedAt: 2 }
      ]
    }))
    const files = await collectLocalFiles({ userDataPath: tunnelDataDir, tunnelDataDir, files: nodeReportFiles })
    expect(files.connectionFunnel).toBeDefined()

    const body = buildReportBody({ connectionFunnel: files.connectionFunnel })
    const funnel = (body as { connectionFunnel?: Array<Record<string, unknown>> }).connectionFunnel
    expect(funnel).toHaveLength(1)
    expect(funnel![0]!.trigger).toBe('connect')
    expect(funnel![0]!.outcome).toBe('fatal')
    expect(funnel![0]!.code).toBe('已有代理控制')
    const stages = funnel![0]!.stages as Array<Record<string, unknown>>
    expect(stages).toHaveLength(2)
    expect(stages[1]!.code).toBe('已有代理控制')
    const raw = JSON.stringify(body)
    expect(raw).not.toContain('<script>')
    expect(raw).not.toContain('BAD NAME')
  })

  it('没有台账文件时包里如实缺席,不造空段', () => {
    const body = buildReportBody({})
    expect((body as Record<string, unknown>).connectionFunnel).toBeUndefined()
  })

})
