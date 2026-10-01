// stderr 接流的行级合并(接线层红测):守护/恢复子进程的 stderr 基线每个 chunk 落一行
// (appendFileSync 同步写)。真实子进程一行常被管道切成多个 chunk,几百字节一行的日志会被
// 撕成数行、每 chunk 一次同步写盘。本用例经生产接线(registerActions → productionDeps 的
// spawn 接流)断言:同一行的多个 chunk 只落一行,行序保持,进程退出时尾巴冲洗不丢。
// 未修代码上红(每 chunk 一行);变异回逐 chunk 落盘也红。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const control = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({
  app: {
    getPath: () => control.userData,
    isPackaged: false,
    getVersion: () => '0.6.1'
  },
  dialog: { showOpenDialog: async () => ({ canceled: true }) },
  powerMonitor: { on: () => {}, removeListener: () => {} },
  safeStorage: { isEncryptionAvailable: () => false }
}))

import { BridgeRegistry } from '../../app/main/bridge/bridge-registry'
import { registerActions } from '../../app/main/actions/tunnel'
import type { SpawnedDaemon } from '../../app/main/tunnel/supervisor'

const SIDECAR_DIR = fileURLToPath(new URL('../../sidecar/mac', import.meta.url))
const roots: string[] = []

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  roots.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }))
})

/** 可控的假恢复子进程:stderr 是真实 EventEmitter,exit 可手动触发(冲洗尾巴的接线点)。 */
function fakeRestoreChild(): SpawnedDaemon & { stderr: EventEmitter; exit: () => void } {
  const stderr = new EventEmitter()
  const lifecycle = new EventEmitter()
  const child = {
    pid: 4321,
    stderr,
    on: (event: string, callback: () => void) => { lifecycle.on(event, callback); return child },
    once: (event: string, callback: () => void) => { lifecycle.once(event, callback); return child },
    kill: () => undefined
  } as unknown as SpawnedDaemon & { stderr: EventEmitter; exit: () => void }
  return Object.assign(child, { exit: () => { lifecycle.emit('exit') } })
}

// 账本留 1 条未结算账目 → 构造时 recoverOnBoot 派一次性恢复子进程(注入假 child)。
function setup(): { logPath: string; child: ReturnType<typeof fakeRestoreChild> } {
  const dataDir = mkdtempSync(join(tmpdir(), 'stderr-wire-'))
  const userData = mkdtempSync(join(tmpdir(), 'stderr-user-'))
  roots.push(dataDir, userData)
  control.userData = userData
  writeFileSync(join(dataDir, 'ledger.json'), JSON.stringify([{
    id: 'w-fixture-1', kind: 'setting', service: 'networksetup', item: 'webproxy-eth0',
    sessionToken: 'tok-fixture', note: '', status: 'applied',
    originalValue: { enabled: false }, writtenValue: { enabled: true, host: '127.0.0.1', port: 18080 },
    time: 1
  }]))
  const child = fakeRestoreChild()
  registerActions(new BridgeRegistry(), {
    platform: 'macos',
    dataDir,
    sidecarDir: SIDECAR_DIR,
    spawnDaemon: () => { throw new Error('本用例不派守护') },
    spawnRestore: () => child
  })
  return { logPath: join(userData, 'logs', 'tunnel-daemon.log'), child }
}

const restoreStderrLines = (logPath: string): string[] =>
  existsSync(logPath) ? readFileSync(logPath, 'utf8').split('\n').filter((line) => line.includes('restore-stderr')) : []

describe('stderr 接流按行合并(生产接线)', () => {
  // 同文件内 TunnelService 是进程级单例:两个场景并进一个用例,共用同一次接流。
  it('同一行多个 chunk 只落一行;行序保持;退出时无换行的尾巴冲洗成最后一行', () => {
    const { logPath, child } = setup()
    child.stderr.emit('data', Buffer.from('par'))
    child.stderr.emit('data', Buffer.from('tial line\nsec'))
    child.stderr.emit('data', Buffer.from('ond\n'))
    let lines = restoreStderrLines(logPath)
    // 未修代码:3 个 chunk = 3 行('par' / 'tial line' / 'second')→ 红。
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('restore-stderr partial line')
    expect(lines[1]).toContain('restore-stderr second')

    // 尾巴没有换行结尾:进程退出时冲洗成最后一行(⛔ 丢尾)。
    child.stderr.emit('data', Buffer.from('done line\n'))
    child.stderr.emit('data', Buffer.from('tail without newline'))
    child.exit()
    lines = restoreStderrLines(logPath)
    expect(lines).toHaveLength(4)
    expect(lines[2]).toContain('restore-stderr done line')
    expect(lines[3]).toContain('restore-stderr tail without newline')
  })
})
