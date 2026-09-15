// 收敛包3·件1:守护进程崩溃自愈。
// 故障注入:intent.json 写入半截 JSON(杀软/同步盘弄脏的典型产物)、未捕获异常真抛出。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readdirSync, writeFileSync } from 'node:fs'
import { createLoopbackProbeConnector, type Connector } from '../../sidecar/mac/connectors.mjs'
import { createDaemon, installCrashBailout, intentPath } from '../../sidecar/mac/daemon-core.mjs'
import { appendSettingEntry, generateSessionToken } from '../../sidecar/mac/ledger.mjs'
import { createAdapter, type FakeAdapter } from './fixtures/fake-adapter.mjs'
import {
  FakeClock,
  fakeAdapterEnv,
  flushMicrotasks,
  makeTempDir,
  readJsonFile,
  removeTempDir,
  startFakeUpstream,
  writeIntentFile,
  type FakeUpstream
} from './helpers'
import type { DaemonState } from '../../sidecar/mac/daemon-core.mjs'

const EXIT_IP = '203.0.113.7'
const BRIDGE_PORT = 18080

describe('守护崩溃自愈(收敛包3·件1)', () => {
  let dataDir: string
  let storePath: string
  let upstream: FakeUpstream
  let clock: FakeClock
  let adapter: FakeAdapter
  let exited: number | undefined

  beforeEach(async () => {
    dataDir = makeTempDir('laixin-daemon-crash-')
    storePath = `${dataDir}/fake-system.json`
    upstream = await startFakeUpstream()
    clock = new FakeClock()
    adapter = createAdapter({ ...fakeAdapterEnv(storePath) } as NodeJS.ProcessEnv)
    exited = undefined
  })

  afterEach(async () => {
    await upstream.killAll()
    removeTempDir(dataDir)
  })

  function spawnDaemon() {
    return createDaemon({
      random: () => 0,
      dataDir,
      clock,
      adapter,
      connectorFactory: () => {
        const connector: Connector = createLoopbackProbeConnector({
          kind: 'loopback-probe', host: '127.0.0.1', port: upstream.port, exitIp: EXIT_IP
        })
        return connector
      },
      bridgeFactory: () => ({ listen: () => undefined, close: () => undefined }),
      parentAlive: () => true,
      onExit: (code) => { exited = code },
      intentPollMs: 100,
      parentPollMs: 100,
      verifyIntervalMs: 5_000
    })
  }

  it('intent.json 被写坏:守护不死、状态可见「意图文件已损坏并重置」、坏文件改名留证', async () => {
    writeIntentFile(dataDir, { desired: 'user-disconnected', updatedAt: 1 })
    const daemon = spawnDaemon()
    await daemon.run()
    clock.advance(100)
    await flushMicrotasks()
    expect(exited).toBeUndefined()

    // 真实故障:半截 JSON 写入 intent.json
    writeFileSync(intentPath(dataDir), '{"desired":"conn')
    clock.advance(100)
    await flushMicrotasks()
    clock.advance(100)
    await flushMicrotasks()

    expect(exited).toBeUndefined()
    const state = readJsonFile<DaemonState>(`${dataDir}/state.json`)
    expect(state.message).toBe('意图文件已损坏并重置')
    expect(readdirSync(dataDir).some((name) => name.startsWith('intent.json.corrupt-'))).toBe(true)
    // 后续 tick 不重复刷状态,守护继续工作
    clock.advance(300)
    await flushMicrotasks()
    expect(exited).toBeUndefined()
  })

  it('未捕获异常兜底:先按账本恢复系统代理、写错误状态,再退出(⛔ 代理悬空退出)', async () => {
    // 真实故障注入:账本一条已生效设置 + 系统设置仍是我们写的代理(代理还挂着),模拟崩溃现场
    appendSettingEntry(dataDir, {
      service: 'Wi-Fi', item: 'socks-proxy',
      originalValue: null, writtenValue: { enabled: true, host: '127.0.0.1', port: BRIDGE_PORT },
      sessionToken: generateSessionToken(), time: clock.now()
    })
    writeFileSync(storePath, JSON.stringify({ 'Wi-Fi/socks-proxy': { enabled: true, host: '127.0.0.1', port: BRIDGE_PORT } }))
    expect(readJsonFile(storePath)).toEqual({ 'Wi-Fi/socks-proxy': { enabled: true, host: '127.0.0.1', port: BRIDGE_PORT } })

    let exitCode: number | undefined
    let exitCalls = 0
    const bailout = installCrashBailout({
      dataDir,
      adapterOf: () => adapter,
      exit: (code: number) => { exitCode = code; exitCalls += 1 }
    })
    // 真实抛出未捕获异常路径:process.emit 模拟,不真的杀掉测试进程
    const raised = process.emit('uncaughtException', new Error('注入的未捕获异常'))
    // 二次异常不再重复处理(只退出一次)
    process.emit('uncaughtException', new Error('第二次'))
    bailout.dispose()

    expect(raised).toBe(true)
    expect(exitCalls).toBe(1)
    expect(exitCode).toBe(70)
    // 系统代理已恢复原状(写回原值)
    expect(readJsonFile(storePath)).toEqual({})
    const state = readJsonFile<DaemonState>(`${dataDir}/state.json`)
    expect(state.state).toBe('error')
    expect(state.message).toContain('已恢复原设置')
  })

  it('未捕获异常但账本不可用时:仍写状态并退出,不悬空', async () => {
    let exitCode: number | undefined
    const bailout = installCrashBailout({
      dataDir,
      adapterOf: () => { throw new Error('适配器不可用') },
      exit: (code: number) => { exitCode = code }
    })
    process.emit('uncaughtException', new Error('注入'))
    bailout.dispose()
    expect(exitCode).toBe(70)
  })
})
