import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { closeSync, openSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connect, createServer } from 'node:net'
import { appendIntentEntry, loadLedger, type SettingEntry } from '../../sidecar/mac/ledger.mjs'
import {
  fakeAdapterEnv,
  fileExists,
  makeTempDir,
  readFakeStore,
  readJsonFile,
  removeTempDir,
  startFakeUpstream,
  waitFor,
  writeIntentFile,
  type FakeUpstream
} from './helpers'
import type { DaemonState } from '../../sidecar/mac/daemon-core.mjs'

const FAKE_ADAPTER = fileURLToPath(new URL('./fixtures/fake-adapter.mjs', import.meta.url))
const FAKE_MAIN = fileURLToPath(new URL('./fixtures/fake-main.mjs', import.meta.url))
const EXIT_IP = '203.0.113.7'

function settingEntries(dataDir: string): SettingEntry[] {
  return loadLedger(dataDir).filter((entry): entry is SettingEntry => entry.kind === 'setting')
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// SIGKILL 终止的进程 exitCode 恒为 null(信号在 signalCode),等「已退出」要用这个。
function childExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null
}

describe.each(['mac', 'win'])('%s 守护入口跨进程行为(回环与假设置)', (platform) => {
  const DAEMON_PATH = fileURLToPath(new URL(`../../sidecar/${platform}/tunnel-daemon.mjs`, import.meta.url))
  let dataDir: string
  let storePath: string
  let upstream: FakeUpstream
  let bridgePort: number
  const children: ChildProcess[] = []

  beforeEach(async () => {
    dataDir = makeTempDir('laixin-daemon-proc-')
    storePath = join(dataDir, 'fake-system.json')
    upstream = await startFakeUpstream()
    const reservation = createServer()
    await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve))
    const address = reservation.address()
    if (address === null || typeof address === 'string') throw new Error('NO_TEST_PORT')
    bridgePort = address.port
    await new Promise<void>((resolve) => reservation.close(() => resolve()))
  })

  afterEach(async () => {
    for (const child of children.splice(0)) {
      if (child.exitCode === null && child.pid !== undefined && processAlive(child.pid)) {
        child.kill('SIGKILL')
      }
    }
    await upstream.killAll()
    // 连主进程/守护 SIGKILL 的场景也必须释放自己启动的原生内核监听。
    await expect.poll(() => new Promise<boolean>((resolve) => {
      const socket = connect({ host: '127.0.0.1', port: bridgePort })
      socket.on('connect', () => { socket.destroy(); resolve(true) })
      socket.on('error', () => resolve(false))
      socket.setTimeout(200, () => { socket.destroy(); resolve(false) })
    }), { timeout: 3_000 }).toBe(false)
    removeTempDir(dataDir)
  })

  function spawnDaemon(extraEnv: NodeJS.ProcessEnv = {}) {
    const errPath = join(dataDir, `daemon-${children.length}.err.log`)
    const errFd = openSync(errPath, 'a')
    const child = spawn(
      process.execPath,
      [
        DAEMON_PATH,
        'start',
        '--data-dir',
        dataDir,
        '--adapter',
        FAKE_ADAPTER,
        '--intent-poll-ms',
        '50',
        '--parent-poll-ms',
        '50',
        '--verify-interval-ms',
        '60000'
      ],
      { env: { ...process.env, ...fakeAdapterEnv(storePath), ...extraEnv }, stdio: ['ignore', 'ignore', errFd] }
    )
    closeSync(errFd)
    children.push(child)
    return child
  }

  function connectIntent() {
    return {
      desired: 'connected',
      sessionToken: 'proc-test',
      bridgePort,
      connector: { kind: 'loopback-probe', host: '127.0.0.1', port: upstream.port, exitIp: EXIT_IP }
    }
  }

  function stateOf(): DaemonState {
    return readJsonFile<DaemonState>(join(dataDir, 'state.json'))
  }

  it('判据 2 后半(跨进程):杀掉并重起 sidecar → 读账本意图仍是「用户主动断开」→ 仍不连', async () => {
    // 意图已持久化(账本 + 意图文件)
    writeIntentFile(dataDir, { desired: 'user-disconnected' })
    appendIntentEntry(dataDir, { intent: 'user-disconnected', time: Date.now() })

    const daemon = spawnDaemon()
    // 守护起来后待命:不发起任何连接
    await waitFor(() => fileExists(join(dataDir, 'state.json')))
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 300))
    expect(upstream.connectionCount()).toBe(0)
    expect(['user-disconnected', 'stopped-restored']).toContain(stateOf().state)
    expect(daemon.pid !== undefined && processAlive(daemon.pid)).toBe(true)

    // 杀掉重起一次,仍不连
    daemon.kill('SIGTERM')
    await waitFor(() => daemon.exitCode !== null)
    const daemon2 = spawnDaemon()
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 300))
    expect(upstream.connectionCount()).toBe(0)
    expect(
      loadLedger(dataDir)
        .filter((entry) => entry.kind === 'intent')
        .at(-1)
    ).toMatchObject({ intent: 'user-disconnected' })
    daemon2.kill('SIGTERM')
    await waitFor(() => daemon2.exitCode !== null)
  })

  it('判据 3①:主进程 kill -9 → 守护按账本恢复并退出,账目「已恢复」,假系统读数还原', async () => {
    writeIntentFile(dataDir, connectIntent())
    const fakeMain = spawn(process.execPath, [FAKE_MAIN, dataDir, DAEMON_PATH, 'start', '--data-dir', dataDir, '--adapter', FAKE_ADAPTER, '--intent-poll-ms', '50', '--parent-poll-ms', '50'], {
      env: { ...process.env, ...fakeAdapterEnv(storePath) }
    })
    children.push(fakeMain)
    let daemonPid = 0
    fakeMain.stdout?.on('data', (chunk: Buffer) => {
      const match = chunk.toString('utf8').match(/DAEMON_PID=(\d+)/)
      if (match !== null) {
        daemonPid = Number.parseInt(match[1], 10)
      }
    })

    await waitFor(() => fileExists(join(dataDir, 'state.json')) && stateOf().state === 'connected', 10_000)
    expect(settingEntries(dataDir).every((entry) => entry.status === 'applied')).toBe(true)
    expect(readFakeStore(storePath)['Wi-Fi/socks-proxy']).toEqual({
      enabled: true,
      host: '127.0.0.1',
      port: bridgePort
    })
    await waitFor(() => daemonPid !== 0, 5_000)

    // 主进程崩溃(kill -9,⛔ 清理机会)
    fakeMain.kill('SIGKILL')
    await waitFor(() => !processAlive(daemonPid), 10_000)

    const entries = settingEntries(dataDir)
    expect(entries.length).toBeGreaterThan(0)
    expect(entries.every((entry) => entry.status === 'restored')).toBe(true)
    expect(readFakeStore(storePath)).toEqual({})
    // 交付证据:kill 之后的实际磁盘状态
    const evidence = {
      ledger: readFileSync(join(dataDir, 'ledger.json'), 'utf8'),
      fakeSystem: fileExists(storePath) ? readFileSync(storePath, 'utf8') : '(无存)',
      daemonErr: fileExists(join(dataDir, 'daemon.err.log'))
        ? readFileSync(join(dataDir, 'daemon.err.log'), 'utf8')
        : ''
    }
    process.stdout.write(`\n[判据3① kill 后磁盘状态]\n${JSON.stringify(evidence, null, 2)}\n`)
  }, 20_000)

  it('判据 3③(sidecar 跨进程重起):守护被 SIGKILL 留下未恢复账,重起先恢复再待命', async () => {
    writeIntentFile(dataDir, connectIntent())
    const daemon = spawnDaemon()
    await waitFor(() => fileExists(join(dataDir, 'state.json')) && stateOf().state === 'connected', 10_000)

    daemon.kill('SIGKILL') // 守护崩溃:账目停在 applied,假系统仍是我们的值
    await waitFor(() => childExited(daemon))
    expect(settingEntries(dataDir).some((entry) => entry.status === 'applied')).toBe(true)
    expect(readFakeStore(storePath)['Wi-Fi/socks-proxy']).toBeDefined()

    writeIntentFile(dataDir, { desired: 'user-disconnected' })
    const daemon2 = spawnDaemon()
    await waitFor(() => fileExists(join(dataDir, 'state.json')), 10_000)
    try {
      await waitFor(
        () => settingEntries(dataDir).every((entry) => entry.status === 'restored'),
        10_000
      )
    } catch (error) {
      const diagnostics = readdirSync(dataDir)
        .filter((name) => name.endsWith('.err.log'))
        .map((name) => `${name}:\n${readFileSync(join(dataDir, name), 'utf8')}`)
        .join('\n')
      process.stdout.write(`\n[3③ 诊断]\nledger: ${readFileSync(join(dataDir, 'ledger.json'), 'utf8')}\n${diagnostics}\n`)
      throw error
    }
    expect(readFakeStore(storePath)).toEqual({})
    process.stdout.write(
      `\n[判据3③ 重起后磁盘状态]\n${readFileSync(join(dataDir, 'ledger.json'), 'utf8')}\nfake-system: ${readFileSync(storePath, 'utf8')}\n`
    )
    daemon2.kill('SIGTERM')
    await waitFor(() => daemon2.exitCode !== null)
  }, 25_000)

  it('CLI status:打印 state 与账本未恢复项(JSON),rc=0', () => {
    writeIntentFile(dataDir, { desired: 'user-disconnected' })
    const output = execFileSync(process.execPath, [DAEMON_PATH, 'status', '--data-dir', dataDir], {
      encoding: 'utf8'
    })
    const parsed = JSON.parse(output) as { state: { state: string }; intent: string | null; unrestored: unknown[] }
    expect(parsed.state.state).toBe('idle')
    expect(parsed.unrestored).toEqual([])
  })
})
