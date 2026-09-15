// Windows 守护入口真进程(sidecar/win/tunnel-daemon.mjs):CLI status / restore /
// 默认适配器加载闸(未放行 → REAL_ADAPTER_GUARD,rc≠0)。全部只碰临时文件。
import { afterEach, describe, expect, it } from 'vitest'
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { appendSettingEntry } from '../../sidecar/win/ledger.mjs'
import { makeTempDir, removeTempDir } from './helpers'

const DAEMON = fileURLToPath(new URL('../../sidecar/win/tunnel-daemon.mjs', import.meta.url))
const FAKE_ADAPTER = fileURLToPath(new URL('./fixtures/fake-wininet-adapter.mjs', import.meta.url))

const roots: string[] = []
afterEach(() => roots.splice(0).forEach(removeTempDir))

function runDaemon(args: string[], env: NodeJS.ProcessEnv = {}): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [DAEMON, ...args], {
    encoding: 'utf8',
    timeout: 20_000,
    env: { ...process.env, ...env }
  })
}

describe('win 守护入口(CLI,真进程)', () => {
  it('status:空目录 → idle + 无未恢复项(JSON)', () => {
    const dataDir = makeTempDir('laixin-win-entry-')
    roots.push(dataDir)
    const result = runDaemon(['status', '--data-dir', dataDir])
    expect(result.status).toBe(0)
    const parsed = JSON.parse(result.stdout) as { state: { state: string }; unrestored: unknown[] }
    expect(parsed.state.state).toBe('idle')
    expect(parsed.unrestored).toEqual([])
  })

  it('默认适配器未放行 → 守卫拒绝,进程 rc≠0 且报 REAL_ADAPTER_GUARD(闸能响)', () => {
    const dataDir = makeTempDir('laixin-win-entry-')
    roots.push(dataDir)
    const result = runDaemon(['start', '--data-dir', dataDir], { TOOLBOX_REAL_NETWORK_ADAPTER: '' })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('REAL_ADAPTER_GUARD')
  })

  it('W4-1 空成功:无账本 + 代理指着我们候选口 → restore 关掉残留(退出码 0 + 回执带字段)', () => {
    const dataDir = makeTempDir('laixin-win-entry-')
    roots.push(dataDir)
    const storePath = join(dataDir, 'fake-wininet.json')
    writeFileSync(storePath, JSON.stringify({
      ProxyEnable: { type: 'REG_DWORD', data: '1' },
      ProxyServer: { type: 'REG_SZ', data: '127.0.0.1:18080' }
    }))
    const result = runDaemon(['restore', '--data-dir', dataDir, '--adapter', FAKE_ADAPTER], {
      FAKE_WININET_STORE: storePath
    })
    expect(result.status).toBe(0)
    const receipt = JSON.parse(result.stdout) as { residueClearedProxyPort?: number }
    expect(receipt.residueClearedProxyPort).toBe(18080)
    const store = JSON.parse(readFileSync(storePath, 'utf8')) as Record<string, { data: string }>
    expect(store.ProxyEnable.data).toBe('0')
    // 客户自己的回环代理(不在我们的口集合)⛔ 被顺手关掉
  })

  it('W4-1 反向:回环代理但不是我们的口 → 兜底 ⛔ 开火', () => {
    const dataDir = makeTempDir('laixin-win-entry-')
    roots.push(dataDir)
    const storePath = join(dataDir, 'fake-wininet.json')
    writeFileSync(storePath, JSON.stringify({
      ProxyEnable: { type: 'REG_DWORD', data: '1' },
      ProxyServer: { type: 'REG_SZ', data: '127.0.0.1:7897' }
    }))
    const result = runDaemon(['restore', '--data-dir', dataDir, '--adapter', FAKE_ADAPTER], {
      FAKE_WININET_STORE: storePath
    })
    expect(result.status).toBe(0)
    const receipt = JSON.parse(result.stdout) as { residueClearedProxyPort?: number }
    expect(receipt.residueClearedProxyPort).toBeUndefined()
    const store = JSON.parse(readFileSync(storePath, 'utf8')) as Record<string, { data: string }>
    expect(store.ProxyEnable.data).toBe('1')
  })

  it('restore --adapter 假适配器:按账本把四键读数恢复为原值', () => {
    const dataDir = makeTempDir('laixin-win-entry-')
    roots.push(dataDir)
    const storePath = join(dataDir, 'fake-wininet.json')
    // 预置「系统里还有我们写的值」:账本 applied 项 + 假 WinINET 存储里是写入值
    appendSettingEntry(dataDir, {
      service: 'WinINET',
      item: 'ProxyEnable',
      originalValue: null,
      writtenValue: { type: 'REG_DWORD', data: '1' },
      sessionToken: 'entry-test',
      time: Date.now()
    })
    writeFileSync(storePath, JSON.stringify({ ProxyEnable: { type: 'REG_DWORD', data: '1' } }))
    const result = runDaemon(['restore', '--data-dir', dataDir, '--adapter', FAKE_ADAPTER], {
      FAKE_WININET_STORE: storePath
    })
    expect(result.status).toBe(0)
    const receipt = JSON.parse(result.stdout) as { restored: number; keptModified: string[]; failed: string[] }
    expect(receipt.restored).toBe(1)
    expect(readFileSync(storePath, 'utf8').trim()).toBe('{}')
  })
})
