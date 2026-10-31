// N-88 本地采样入口(vitest 环境):npx vitest run tests/perf/sample-baseline.ts
// 输出 20 轮 normal + 8 轮 slowFactor=6 的基线 JSON 到 stdout(开发参考,⛔ SLA)。
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'vitest'
import { runConnectionScenario } from './connection-scenario'
import { baselineReport } from './baseline'

it('输出基线采样 JSON', { timeout: 5 * 60_000 }, async () => {
  const normalRuns = []
  const slowRuns = []
  for (let index = 0; index < 20; index += 1) {
    const dir = mkdtempSync(join(tmpdir(), 'n88-r-'))
    try { normalRuns.push(await runConnectionScenario(dir, { slowFactor: 1, label: 'normal' })) } finally { rmSync(dir, { recursive: true, force: true }) }
  }
  for (let index = 0; index < 8; index += 1) {
    const dir = mkdtempSync(join(tmpdir(), 'n88-s-'))
    try { slowRuns.push(await runConnectionScenario(dir, { slowFactor: 6, label: 'slow-machine' })) } finally { rmSync(dir, { recursive: true, force: true }) }
  }
  const report = { generatedAt: new Date().toISOString(), machine: 'dev-mac-arm64 单机参考(⛔ 全机型 SLA)',
    normal: baselineReport(normalRuns), slowFactor6: baselineReport(slowRuns) }
  console.log('BASELINE_JSON_BEGIN')
  console.log(JSON.stringify(report, null, 2))
  console.log('BASELINE_JSON_END')
})
