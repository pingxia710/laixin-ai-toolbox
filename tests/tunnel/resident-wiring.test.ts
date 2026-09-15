// 常驻接线(主进程侧,0.5.0):启动参数、按开关校准、装不上时回落老路、校准与运行时注册的先后无关。
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeResidentRuntime, residentLogDir, residentSpecFor } from '../../app/main/tunnel/resident-bridge'
import { calibrateResident, resetResidentRuntime, setResidentRuntime } from '../../app/main/tunnel/resident-owner'
import type { ResidentOutcome, ResidentSpec } from '../../app/main/tunnel/platform/resident'

// env 用两个字段代表「launch.env 原样透传」这件事,⛔ 把真实放行钥匙抄进来:
// 那把钥匙有一道闸管着它只许出现在 platform/{mac,win}.ts 与适配器本体,测试也没有理由扩散它。
const launch = { daemonPath: '/app/sidecar/tunnel-daemon.mjs', adapterPath: '/app/sidecar/managed-adapter.mjs', env: { TOOLBOX_FAKE_GUARD_KEY: '1', ELECTRON_RUN_AS_NODE: '1' } }

function makeRuntime(options: { supported?: boolean; installOutcome?: ResidentOutcome; alivePid?: number } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'resident-wiring-'))
  if (options.alivePid !== undefined) {
    writeFileSync(join(dataDir, 'daemon.lock'), JSON.stringify({ token: 't', pid: options.alivePid, runId: 'r', at: Date.now() }))
  }
  const calls: Array<{ op: 'install' | 'uninstall' | 'wake'; spec?: ResidentSpec }> = []
  const runtime = makeResidentRuntime({
    dataDir,
    platform: 'macos',
    supported: options.supported ?? true,
    probeInstalled: () => false,
    spec: () => residentSpecFor({ executable: '/Applications/工具箱.app/Contents/MacOS/工具箱', launch, dataDir, logDir: '/logs' }),
    install: async (spec) => { calls.push({ op: 'install', spec }); return options.installOutcome ?? { installed: true } },
    uninstall: async () => { calls.push({ op: 'uninstall' }) },
    wake: async () => { calls.push({ op: 'wake' }); return { woken: true } }
  })
  return { runtime, calls, dataDir, cleanup: () => rmSync(dataDir, { recursive: true, force: true }) }
}

describe('常驻接线', () => {
  afterEach(() => { resetResidentRuntime() })

  it('常驻守护的启动参数:带 --resident 1,⛔ --parent-ipc(守护会直接抛),⛔ --run-id(它自己发)', () => {
    const spec = residentSpecFor({ executable: '/工具箱', launch, dataDir: '/data', logDir: '/logs' })
    expect(spec.args).toEqual([
      '/app/sidecar/tunnel-daemon.mjs', 'start', '--data-dir', '/data', '--adapter', '/app/sidecar/managed-adapter.mjs', '--resident', '1'
    ])
    expect(spec.env).toEqual({ TOOLBOX_FAKE_GUARD_KEY: '1', ELECTRON_RUN_AS_NODE: '1' })
    expect(spec.logDir).toBe('/logs')
  })

  it('守护日志落到 <userData>/logs(一键上报按这个路径收)', () => {
    expect(residentLogDir('/Users/x/Library/Application Support/工具箱')).toBe('/Users/x/Library/Application Support/工具箱/logs')
  })

  it('校准:开关开就装、关就卸,armed() 跟着走', async () => {
    const h = makeRuntime()
    expect(h.runtime.bridge.armed()).toBe(false)
    await h.runtime.calibrate(true)
    expect(h.calls.map((c) => c.op)).toEqual(['install'])
    expect(h.runtime.bridge.armed()).toBe(true)
    await h.runtime.calibrate(false)
    expect(h.calls.map((c) => c.op)).toEqual(['install', 'uninstall'])
    expect(h.runtime.bridge.armed()).toBe(false)
    h.cleanup()
  })

  it('装不上就如实记下没装——⛔ 因为常驻装不上就不给客户连网', async () => {
    const h = makeRuntime({ installOutcome: { installed: false, reason: '目录不可写' } })
    const outcome = await h.runtime.calibrate(true)
    // 正向证据:确实试过装(⛔ 只断言 armed 是 false——根本没试也长这样)
    expect(h.calls.map((c) => c.op)).toEqual(['install'])
    expect(outcome.installed).toBe(false)
    // armed 为假 → 守护监管走 spawn 老路,最坏不比上一版差
    expect(h.runtime.bridge.armed()).toBe(false)
    h.cleanup()
  })

  it('开发态不装常驻,但也 ⛔ 报成失败', async () => {
    const h = makeRuntime({ supported: false })
    const outcome = await h.runtime.calibrate(true)
    expect(h.calls).toEqual([])
    expect(outcome.installed).toBe(false)
    expect(h.runtime.bridge.armed()).toBe(false)
    h.cleanup()
  })

  it('席位锁上是活人才算守护在跑', () => {
    const alive = makeRuntime({ alivePid: process.pid })
    expect(alive.runtime.bridge.alive()).toBe(true)
    alive.cleanup()
    // 正向证据在上一行:同一套实现对活着的 pid 说 true,对没有锁的目录说 false
    const none = makeRuntime()
    expect(none.runtime.bridge.alive()).toBe(false)
    none.cleanup()
    // 锁在但持有者早没了(崩溃、断电):不算在跑
    const dead = makeRuntime({ alivePid: 2_147_483_646 })
    expect(dead.runtime.bridge.alive()).toBe(false)
    dead.cleanup()
  })

  it('校准来得比运行时早:记下,注册时补跑——⛔ 让两边互相等', async () => {
    const h = makeRuntime()
    // 桌面片先起来,通道片还没装配好
    expect(await calibrateResident(true)).toBeUndefined()
    expect(h.calls).toEqual([])
    // 通道片装配完 → 补跑
    setResidentRuntime(h.runtime)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(h.calls.map((c) => c.op)).toEqual(['install'])
    expect(h.runtime.bridge.armed()).toBe(true)
    h.cleanup()
  })

  it('运行时先注册:校准直接跑,⛔ 还要等一轮', async () => {
    const h = makeRuntime()
    setResidentRuntime(h.runtime)
    await calibrateResident(true)
    expect(h.calls.map((c) => c.op)).toEqual(['install'])
    h.cleanup()
  })
})
