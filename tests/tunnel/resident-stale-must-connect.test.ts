// 甲-10 返工验收补:按产品要求断言,⛔ 断言 armed 的取值(那是实现细节,换一种修法就会误红、被人再改一次)。
// 网络硬标准(创始人 2026-09-13):点了连接不管发生什么都要连上,⛔ 放弃式处理。
//  ① 存量管理员任务与当前安装不一致、且叫不醒(任务指向的程序已不在 / 属于别的账号):客户点连接必须连上——
//     自起发生、守护在、放弃位为 false。无论走「叫醒失败回落自起」还是「不一致直接自起」,这条都该绿。
//  ② 存量任务一致、叫得醒:席位上由任务拉起的那一份承载,⛔ 自起第二份。
import { expect, it } from 'vitest'
import { writeFileSync } from 'node:fs'
import { currentProcessStartedAt } from '../../sidecar/mac/ledger.mjs'
import { instanceLockPath } from '../../sidecar/shared/instance-lock.mjs'
import { makeResidentRuntime } from '../../app/main/tunnel/resident-bridge'
import { DaemonSupervisor } from '../../app/main/tunnel/supervisor'
import { RESIDENT_TASK_LEGACY, type ResidentOutcome } from '../../app/main/tunnel/platform/resident'
import { makeTempDir, removeTempDir } from './helpers'

async function clickConnect(outcome: Pick<ResidentOutcome, 'installed' | 'existingTaskStale' | 'staleTaskPaths' | 'unmanagedStale'>, taskCanStartDaemon: boolean) {
  const dataDir = makeTempDir('resident-stale-')
  let spawns = 0
  const wakeCalls: Array<readonly string[] | undefined> = []
  try {
    const runtime = makeResidentRuntime({
      dataDir, platform: 'windows', supported: true, probeInstalled: () => false,
      spec: () => ({ executable: 'x', args: [], env: {}, logDir: dataDir }),
      install: async () => outcome,
      wake: async (_platform, taskPaths) => {
        wakeCalls.push(taskPaths)
        // 叫得醒 = 任务拉起的守护抢到席位(席位锁写成本进程身份,判活为真);叫不醒 = 席位始终空着
        if (taskCanStartDaemon) writeFileSync(instanceLockPath(dataDir), JSON.stringify({ token: 't', pid: process.pid, runId: 'task', at: Date.now(), startedAt: currentProcessStartedAt() }))
        return { woken: true }
      }
    })
    await runtime.calibrate(true)
    const supervisor = new DaemonSupervisor({
      dataDir, resident: runtime.bridge, wait: async () => undefined, scheduleRestart: () => undefined,
      spawnDaemon: () => { spawns += 1; return { on: () => undefined } },
      spawnRestore: () => undefined
    })
    supervisor.ensureRunning()
    for (let i = 0; i < 500 && supervisor.waking; i += 1) await new Promise((resolve) => setTimeout(resolve, 1))
    return { spawns, running: supervisor.isRunning(), surrendered: supervisor.surrendered, wakeCalls }
  } finally { removeTempDir(dataDir) }
}

it('① 普通存量任务不一致且叫不醒:点连接仍自起，保住既有连接兜底', async () => {
  const result = await clickConnect({ installed: false, existingTaskStale: true }, false)
  expect(result.surrendered).toBe(false)
  expect(result.running).toBe(true)
  expect(result.spawns).toBeGreaterThanOrEqual(1)
})

it('② 存量任务一致且叫得醒:由任务那一份承载,⛔ 自起第二份', async () => {
  const result = await clickConnect({ installed: true }, true)
  expect(result.running).toBe(true)
  expect(result.surrendered).toBe(false)
  expect(result.spawns).toBe(0)
})

it('③ 仅历史根目录任务残留且叫得醒:叫醒它并由它承载，⛔ 主进程并行自起', async () => {
  const result = await clickConnect({ installed: false, existingTaskStale: true, staleTaskPaths: [RESIDENT_TASK_LEGACY] }, true)
  expect(result.wakeCalls).toEqual([[RESIDENT_TASK_LEGACY]])
  expect(result.running).toBe(true)
  expect(result.spawns).toBe(0)
})

it('④ 特殊字符降级后旧任务停不掉且叫不醒:⛔ 自起与它抢设置，先还原并给管理员自救', async () => {
  const result = await clickConnect({ installed: false, existingTaskStale: true, unmanagedStale: true, staleTaskPaths: [RESIDENT_TASK_LEGACY] }, false)
  expect(result.surrendered).toBe(true)
  expect(result.running).toBe(false)
  expect(result.spawns).toBe(0)
})
