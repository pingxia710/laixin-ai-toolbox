// 候选甲-6:本地故障(磁盘满/目录不可写/程序错误)时,「说对症、指对路、留得下证据」。
// 基线三层灭失:①importConfig 的本地异常原样上抛 → 桥层兜底成 ACTION_FAILED → 界面让客户
// 「重新导入配置包」,照做无用;②桥层兜底 catch 不收 error,唯一诊断进 console.error(打包 GUI 蒸发);
// ③守护 handleConnectFailure 全文无一行 log,连接器保留的细节在最后一环被丢。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { chmodSync } from 'node:fs'
import { join } from 'node:path'
import { importConfig } from '../../app/main/tunnel/import-service'
import { TRUST_LINES } from '../../app/main/tunnel/trust'
import { faultNoteText, sanitizeFaultRecord } from '../../app/shared/fault-log-types'
import { faultParamsForLocalError } from '../../app/main/diagnostics/context'
import { createDaemon } from '../../sidecar/win/daemon-core.mjs'
import { createAdapter } from './fixtures/fake-wininet-adapter.mjs'
import { buildPackageEntries, writePackageDir } from './fixtures/package-builder'
import { makeTempDir, removeTempDir, writeIntentFile } from './helpers'

const NOW = Date.parse('2026-10-01T00:00:00Z')
const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn() })

describe('importConfig 本地故障如实说(甲-6 链①)', () => {
  function importInto(dataDir: string, packagePath: string) {
    const built = buildPackageEntries()
    const dir = writePackageDir(packagePath, built)
    return importConfig({
      dataDir,
      picker: () => Promise.resolve(dir),
      trust: { whitelistDigests: [built.digest], signingPublicKeys: [] },
      now: () => NOW,
      sourceLineOf: (validated) => TRUST_LINES[validated.trust.tier]
    })
  }

  it('数据目录只读 → 受控拒绝 TUNNEL_LOCAL_WRITE_FAILED + 如实文案(基线:原样上抛,桥层兜底成「重新导入配置包」)', async () => {
    const dataDir = makeTempDir('laixin-j6-import-')
    const packageDir = makeTempDir('laixin-j6-pkg-')
    cleanups.push(() => { chmodSync(dataDir, 0o755); removeTempDir(dataDir) })
    cleanups.push(() => removeTempDir(packageDir))
    chmodSync(dataDir, 0o555) // 目录不可写的真实现场
    const outcome = await importInto(dataDir, join(packageDir, 'pkg'))
    expect(outcome.outcome).toBe('rejected')
    expect(outcome.outcome === 'rejected' && outcome.code).toBe('TUNNEL_LOCAL_WRITE_FAILED')
    expect(outcome.outcome === 'rejected' && outcome.message).toContain('磁盘')
    // 误导文案一个字都不许出现:照它做(重新导入)没用,真因是目录不可写
    expect(outcome.outcome === 'rejected' && outcome.message).not.toContain('重新导入')
  })

  it('可写目录 + 合法包:照常导入(正向,⛔ 把好事误判成写入失败)', async () => {
    const dataDir = makeTempDir('laixin-j6-import-ok-')
    const packageDir = makeTempDir('laixin-j6-pkg-ok-')
    cleanups.push(() => removeTempDir(dataDir))
    cleanups.push(() => removeTempDir(packageDir))
    const outcome = await importInto(dataDir, join(packageDir, 'pkg'))
    expect(outcome.outcome).toBe('imported')
  })
})

describe('守护失败路径留证(甲-6 链③):handleConnectFailure 补 log', () => {
  it('连接失败把错误名/码+截断首行写进守护日志(基线:一行都不写,细节全丢)', async () => {
    vi.useFakeTimers()
    const dataDir = makeTempDir('laixin-j6-daemon-')
    cleanups.push(() => removeTempDir(dataDir))
    const base = createAdapter({ FAKE_WININET_STORE: join(dataDir, 'registry.json') })
    const logLines: string[] = []
    const longTail = 'X'.repeat(400)
    const failing = Object.assign(new Error(`ssh 握手被拒,主机密钥不符\n${longTail}`), { code: '节点身份不符' })
    writeIntentFile(dataDir, { desired: 'connected', sessionToken: 'j6', bridgePort: 18080,
      connector: { kind: 'loopback-probe', host: '127.0.0.1', port: 1, exitIp: '203.0.113.1' } })
    const daemon = createDaemon({ dataDir, adapter: base, parentAlive: () => true, onExit: () => undefined,
      clock: { now: Date.now,
        setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms) as unknown as number,
        setInterval: (fn: () => void, ms: number) => setInterval(fn, ms) as unknown as number,
        clearTimer: (id: number) => clearTimeout(id as unknown as NodeJS.Timeout) },
      log: (line: string) => logLines.push(line),
      connectorFactory: () => ({ kind: 'loopback-probe', start: async () => { throw failing }, stop: async () => undefined,
        localProxyPort: () => 1, onLost: () => undefined, verify: async () => ({ exitIp: '203.0.113.1' }) }),
      bridgeFactory: () => ({ listen: async () => undefined, close: async () => undefined, isAlive: () => true, onLost: () => undefined })
    })
    const running = daemon.run()
    await vi.advanceTimersByTimeAsync(0)
    // 致命码(节点身份不符在 FATAL_CODES)→ handleConnectFailure 收口,这一环必须留证
    const evidence = logLines.filter((line) => line.includes('节点身份不符'))
    expect(evidence.length).toBeGreaterThan(0)
    // 错误名与截断首行在,第二段长尾巴不在(截断钉死)
    expect(evidence[0]).toContain('Error')
    expect(evidence[0]).toContain('ssh 握手被拒,主机密钥不符')
    expect(evidence[0]).not.toContain(longTail)
    daemon.requestShutdown()
    await vi.advanceTimersByTimeAsync(1)
    await running
  })
})

describe('故障留痕的清洗形状(甲-6:FB-1 白名单口径)', () => {
  it('faultParamsForLocalError:错误名+fs 码,⛔ 带路径的原始消息', () => {
    const withPath = Object.assign(new Error("ENOENT: open '/Users/laixin/secret/config.json'"), { code: 'ENOENT' })
    const params = faultParamsForLocalError(withPath)
    expect(params[0]).toContain('Error')
    expect(params[0]).toContain('ENOENT')
    expect(JSON.stringify(params)).not.toContain('/Users/laixin')
    // 程序错误(无 fs 码)也留得下:TypeError 名号
    expect(faultParamsForLocalError(new TypeError('x is not a function'))[0]).toContain('TypeError')
  })

  it('新说明模板过白名单清洗:sanitize 收下,渲染成人话;路径形状进不了参数', () => {
    const record = sanitizeFaultRecord({ at: new Date(NOW).toISOString(), version: '9.9.9-test',
      network: 'AI_DIAG_TUNNEL_ACTION_FAILED', note: 'tunnel_local_fault', noteParams: ['Error:ENOSPC'] })
    expect(record).toBeDefined()
    expect(faultNoteText('tunnel_local_fault', ['Error:ENOSPC'])).toContain('Error:ENOSPC')
    // 白名单口径:带路径的长参数被参数闸丢掉(整条记录仍在,只丢参数)
    const dirty = sanitizeFaultRecord({ at: new Date(NOW).toISOString(), version: '9.9.9-test',
      network: 'AI_DIAG_TUNNEL_ACTION_FAILED', note: 'tunnel_local_fault', noteParams: ['/Users/laixin/secret-path'] })
    expect(dirty?.noteParams).toBeUndefined()
  })
})
