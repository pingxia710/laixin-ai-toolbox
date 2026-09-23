// 甲-2 故障注入(真进程):主进程 recoverOnBoot 兜底的 restore 子命令遇暂时性写失败——
// 基线是裸调一次 restoreLedger,失败即 exit 65 置「恢复未完成」等客户手动点;
// 修复后子命令自己按梯子(快速 1/2/5/10/20/30 秒)重试,杀软短暂锁注册表的窗口自愈。
import { afterEach, describe, expect, it } from 'vitest'
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { appendSettingEntry } from '../../sidecar/win/ledger.mjs'
import { makeTempDir, removeTempDir } from './helpers'

const DAEMON = fileURLToPath(new URL('../../sidecar/win/tunnel-daemon.mjs', import.meta.url))
const FLAKY_ADAPTER = fileURLToPath(new URL('./fixtures/fake-wininet-flaky-adapter.mjs', import.meta.url))

const roots: string[] = []
afterEach(() => roots.splice(0).forEach(removeTempDir))

function runDaemon(args: string[], env: NodeJS.ProcessEnv = {}, timeoutMs = 30_000): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [DAEMON, ...args], {
    encoding: 'utf8',
    timeout: timeoutMs,
    env: { ...process.env, ...env }
  })
}

/** 假适配器的操作流水里 ProxyServer 的写尝试次数(成功与失败都计)。 */
function proxyWriteAttempts(storePath: string): number {
  const opsPath = `${storePath}.ops.jsonl`
  if (!existsSync(opsPath)) return 0
  return readFileSync(opsPath, 'utf8').trim().split('\n')
    .filter((line) => { const op = JSON.parse(line) as { op: string; key?: string }; return op.key === 'ProxyServer' && (op.op === 'write' || op.op === 'write-failed') })
    .length
}

describe('restore 子命令接恢复梯子(甲-2)', () => {
  it('遇暂时性写失败:按梯子自动重试,故障松开后恢复成功、退出码 0(基线:一次失败 exit 65 永久卡死)', () => {
    const dataDir = makeTempDir('laixin-restore-ladder-')
    roots.push(dataDir)
    const storePath = join(dataDir, 'fake-wininet.json')
    appendSettingEntry(dataDir, {
      service: 'WinINET', item: 'ProxyServer', originalValue: null,
      writtenValue: { type: 'REG_SZ', data: '127.0.0.1:18080' }, sessionToken: 'entry-test', time: Date.now()
    })
    writeFileSync(storePath, JSON.stringify({ ProxyServer: { type: 'REG_SZ', data: '127.0.0.1:18080' } }))
    const started = Date.now()
    const result = runDaemon(['restore', '--data-dir', dataDir, '--adapter', FLAKY_ADAPTER], {
      FAKE_WININET_STORE: storePath,
      FAKE_WININET_FLAKY_FAIL_FIRST: '1' // 第一次写必败,第二次起松开
    })
    expect(result.status).toBe(0)
    expect(proxyWriteAttempts(storePath)).toBe(2) // 首轮失败 + 梯子重试一次(行为证据)
    expect(Date.now() - started).toBeGreaterThanOrEqual(900) // 梯子第一格 1 秒:确实等过才重试
    expect(readFileSync(storePath, 'utf8').trim()).toBe('{}') // 实际还回去了
    expect(JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8')).state).toBe('stopped-restored')
  })

  it('写权被别人占着不是暂时性失败:⛔ 空转重试,照旧如实 exit 65(护栏,基线即绿)', () => {
    const dataDir = makeTempDir('laixin-restore-ladder-held-')
    roots.push(dataDir)
    const storePath = join(dataDir, 'fake-wininet.json')
    appendSettingEntry(dataDir, {
      service: 'WinINET', item: 'ProxyServer', originalValue: null,
      writtenValue: { type: 'REG_SZ', data: '127.0.0.1:18080' }, sessionToken: 'entry-test', time: Date.now()
    })
    writeFileSync(storePath, JSON.stringify({ ProxyServer: { type: 'REG_SZ', data: '127.0.0.1:18080' } }))
    const started = Date.now()
    const result = runDaemon(['restore', '--data-dir', dataDir, '--adapter', FLAKY_ADAPTER], {
      FAKE_WININET_STORE: storePath,
      FAKE_WRITE_RIGHT: 'held' // 假适配器报写入权被占
    })
    expect(result.status).toBe(65)
    expect(proxyWriteAttempts(storePath)).toBe(0) // 一次都没写(权不在,整段不执行)
    expect(Date.now() - started).toBeLessThan(900) // 没进梯子空等
  })

  it('梯子等待中意图变成 connected(新守护接手):醒来复查让位,⛔ 把新守护写下的代理当旧账删掉(甲-2 返工,基线:删掉新连接)', () => {
    const dataDir = makeTempDir('laixin-restore-ladder-takeover-')
    roots.push(dataDir)
    const storePath = join(dataDir, 'fake-wininet.json')
    appendSettingEntry(dataDir, {
      service: 'WinINET', item: 'ProxyServer', originalValue: null,
      writtenValue: { type: 'REG_SZ', data: '127.0.0.1:18080' }, sessionToken: 'entry-test', time: Date.now()
    })
    writeFileSync(storePath, JSON.stringify({ ProxyServer: { type: 'REG_SZ', data: '127.0.0.1:18080' } }))
    const result = runDaemon(['restore', '--data-dir', dataDir, '--adapter', FLAKY_ADAPTER], {
      FAKE_WININET_STORE: storePath,
      FAKE_WININET_FLAKY_FAIL_FIRST: '1',
      // 睡眠窗口(梯子第一格 1 秒)的中途:新守护接手同一数据目录——旧账结清、写下自己的代理(18081)、意图变成 connected
      FAKE_WININET_FLAKY_TAKEOVER_MS: '300',
      FAKE_WININET_TAKEOVER_DATADIR: dataDir
    })
    // 让位 = 醒来后一个字节都没动:ProxyServer 只有首轮那一次失败尝试,⛔ 第二次 restore
    expect(proxyWriteAttempts(storePath)).toBe(1)
    // 新守护写下的设置原样还在;它的账目没有被本进程结算
    const store = JSON.parse(readFileSync(storePath, 'utf8')) as { ProxyServer?: { data?: string } }
    expect(store.ProxyServer?.data).toBe('127.0.0.1:18081')
    const ledger = JSON.parse(readFileSync(join(dataDir, 'ledger.json'), 'utf8')) as Array<{ sessionToken: string; status: string }>
    expect(ledger.find((entry) => entry.sessionToken === 'takeover-daemon')?.status).toBe('applied')
    // 本进程没还账就不算完成:如实报「恢复未完成」(完成与否的既有判据不动)
    expect(result.status).toBe(65)
  })

  it('慢速段等待中意图变成 connected(新守护接手):醒来复查让位,⛔ 把新守护写下的代理当旧账删掉(甲-2 返工补格,摘掉慢速段复查必红)', { timeout: 180_000 }, () => {
    // 故障压满整个快速梯子(首轮 + 1/2/5/10/20/30 秒 6 格 = 前 7 次尝试)和慢速段第 1 轮(第 8 次),
    // 梯子进入 30 秒一轮的慢速段;第 110 秒(慢速第 2 轮的睡眠里)新守护接手。真进程,~129 秒。
    const dataDir = makeTempDir('laixin-restore-ladder-slow-takeover-')
    roots.push(dataDir)
    const storePath = join(dataDir, 'fake-wininet.json')
    appendSettingEntry(dataDir, {
      service: 'WinINET', item: 'ProxyServer', originalValue: null,
      writtenValue: { type: 'REG_SZ', data: '127.0.0.1:18080' }, sessionToken: 'entry-test', time: Date.now()
    })
    writeFileSync(storePath, JSON.stringify({ ProxyServer: { type: 'REG_SZ', data: '127.0.0.1:18080' } }))
    const result = runDaemon(['restore', '--data-dir', dataDir, '--adapter', FLAKY_ADAPTER], {
      FAKE_WININET_STORE: storePath,
      FAKE_WININET_FLAKY_FAIL_FIRST: '8', // 前 8 次写必败:压满快速梯子 + 慢速第 1 轮,第 9 次(慢速第 2 轮醒来)才轮得到
      FAKE_WININET_FLAKY_TAKEOVER_MS: '110000', // 慢速第 2 轮睡眠(98→128 秒)中途:新守护接手
      FAKE_WININET_TAKEOVER_DATADIR: dataDir
    }, 180_000)
    // 慢速段第 2 轮醒来必须让位:ProxyServer 只有压满梯子的那 8 次失败尝试,⛔ 第 9 次恢复
    expect(proxyWriteAttempts(storePath)).toBe(8)
    // 新守护写下的设置原样还在;它的账目没有被本进程结算
    const store = JSON.parse(readFileSync(storePath, 'utf8')) as { ProxyServer?: { data?: string } }
    expect(store.ProxyServer?.data).toBe('127.0.0.1:18081')
    const ledger = JSON.parse(readFileSync(join(dataDir, 'ledger.json'), 'utf8')) as Array<{ sessionToken: string; status: string }>
    expect(ledger.find((entry) => entry.sessionToken === 'takeover-daemon')?.status).toBe('applied')
    // 本进程没还账就不算完成:如实报「恢复未完成」(完成与否的既有判据不动)
    expect(result.status).toBe(65)
  })
})
