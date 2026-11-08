import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { setTimeout as sleep } from 'node:timers/promises'
import { baselineReport, startBaselineRun, type BaselineRun } from './baseline'
import { monotonicNow } from './monotonic-now'
import { resourceSnapshot } from './resource-snapshot'

// N-88 基准基础:采集正确性(单调时钟/阶段结果/分位)+ 九阶段连通演练(真实子进程与
// 回环 I/O,保活句持有界)+ 慢机注入下的可重复门槛。⛔ 本机毫秒数当全机型 SLA。
const delayMs = 15

async function httpStage(): Promise<void> {
  // 真实回环请求:有实际 I/O,保活句柄由 server 持有(⛔ 空 await 让 Node 静默退出)。
  const server = createServer((_req, res) => { res.writeHead(200); res.end('{}') })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const port = (server.address() as { port: number }).port
    await fetch(`http://127.0.0.1:${port}/x`, { signal: AbortSignal.timeout(500) })
  } finally {
    await new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) })
  }
}

describe('N-88 基准采集基础', () => {
  it('单调时钟与资源快照:可读、句柄数非负或显式 null', () => {
    const before = monotonicNow()
    const snapshot = resourceSnapshot()
    expect(monotonicNow()).toBeGreaterThanOrEqual(before)
    expect(snapshot).not.toBeNull()
    expect(snapshot!.rssBytes).toBeGreaterThan(0)
    expect(snapshot!.handles === null || snapshot!.handles >= 0).toBe(true)
  })

  it('阶段计时按单调时钟;ok/timeout/error 三态入样;失败后样本保留', async () => {
    const run = startBaselineRun('unit-tri-state', ['合成'])
    await run.stage('account-request', async () => { await sleep(delayMs) })
    const first = run.samplesSoFar().find((sample) => sample.stage === 'account-request')
    expect(first!.durationMs).toBeGreaterThanOrEqual(delayMs - 2)
    await expect(run.stage('config-claim', async () => {
      await sleep(5)
      throw Object.assign(new Error('boom'), { baselineTimeout: true })
    })).rejects.toThrow('boom')
    await expect(run.stage('bridge-start', async () => { throw new Error('err') })).rejects.toThrow('err')
    const finished = run.finish()
    expect(finished.samples.map((sample) => sample.outcome)).toEqual(['ok', 'timeout', 'error'])
    expect(finished.samples[0]!.durationMs).toBeGreaterThan(0)
  })

  it('报告分位与资源上限:多次运行 p50≤p95;boundary 自述边界', async () => {
    const runs: BaselineRun[] = []
    for (let index = 0; index < 5; index += 1) {
      const run = startBaselineRun('unit-report', ['合成'])
      await run.stage('account-request', () => httpStage())
      await run.stage('tunnel-establish', async () => { await sleep(delayMs) })
      runs.push(run.finish())
    }
    const report = baselineReport(runs)
    expect(report.runs).toBe(5)
    expect(report.totalMsP50!).toBeLessThanOrEqual(report.totalMsP95!)
    const establish = report.stages.find((stage) => stage.stage === 'tunnel-establish')!
    expect(establish.p50Ms).toBeGreaterThanOrEqual(delayMs - 2)
    expect(report.boundaries.join('\n')).toContain('SLA')
    expect(report.resourceCeiling.rssBytes).toBeGreaterThan(0)
  })
})

describe('N-88 九阶段连通演练(真实回环/真守护件,慢机注入)', () => {
  it('正常与慢化注入各一轮:门槛用相对比例而非绝对毫秒', { timeout: 60_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'n88-baseline-'))
    try {
      const { runConnectionScenario } = await import('./connection-scenario')
      const normal = await runConnectionScenario(dir, { slowFactor: 1, label: 'normal' })
      const slowed = await runConnectionScenario(dir, { slowFactor: 6, label: 'slow-machine' })
      const normalReport = baselineReport([normal])
      const slowReport = baselineReport([slowed])
      // 门槛示例(相对):慢机注入的总耗时应显著高于正常轮;各阶段都出了数。
      expect(slowReport.totalMsP50!).toBeGreaterThan(normalReport.totalMsP50!)
      expect(normalReport.stages.map((stage) => stage.stage)).toContain('bridge-start')
      expect(normalReport.stages.map((stage) => stage.stage)).toContain('settings-write')
      expect(normalReport.stages.map((stage) => stage.stage)).toContain('reconnect-recovery') // 断线恢复阶段必须真实出数
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
