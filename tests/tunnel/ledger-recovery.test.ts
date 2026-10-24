// 收敛包3·件4:隧道账本损坏是单向砖 → 标记存在时走恢复流程。
// 故障注入:真账本被弄脏(合法条目 + 一条坏条目)触发官方隔离,再验证恢复、清标记、坏账本留证。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { closeSync, existsSync, openSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAdapter } from './fixtures/fake-adapter.mjs'
import {
  appendSettingEntry,
  generateSessionToken,
  ledgerFailure,
  loadLedger,
  pendingSettingEntries
} from '../../sidecar/mac/ledger.mjs'
import { recoverLedger, restoreLedger } from '../../sidecar/mac/restore.mjs'
import { DaemonSupervisor } from '../../app/main/tunnel/supervisor'
import { fakeAdapterEnv, makeTempDir, readFakeStore, removeTempDir } from './helpers'

const OUR_VALUE = { enabled: true, host: '127.0.0.1', port: 18080 }
const ORIGINAL_VALUE = null

describe('损坏账本的恢复流程(收敛包3)', () => {
  let dataDir: string
  let storePath: string

  beforeEach(() => {
    dataDir = makeTempDir('laixin-ledger-recovery-')
    storePath = join(dataDir, 'fake-system.json')
  })

  afterEach(() => {
    removeTempDir(dataDir)
  })

  function adapter() {
    return createAdapter({ ...fakeAdapterEnv(storePath) } as NodeJS.ProcessEnv)
  }

  // 制造真实故障:账本里一条合法的未恢复设置 + 一条坏条目 → loadLedger 判损坏并官方隔离。
  function quarantineLedgerWithPendingSetting() {
    appendSettingEntry(dataDir, {
      service: 'Wi-Fi', item: 'socks-proxy',
      originalValue: ORIGINAL_VALUE, writtenValue: OUR_VALUE,
      sessionToken: generateSessionToken(), time: 1
    })
    const path = join(dataDir, 'ledger.json')
    const entries = JSON.parse(readFileSync(path, 'utf8')) as unknown[]
    entries.push({ corrupted: true })
    writeFileSync(path, JSON.stringify(entries))
    expect(() => loadLedger(dataDir)).toThrow()
    expect(existsSync(join(dataDir, 'ledger-recovery-required'))).toBe(true)
    expect(readdirSync(dataDir).some((name) => name.startsWith('ledger.json.bad-'))).toBe(true)
  }

  it('隔离账本里能识别的未恢复设置被写回原值,标记清除,坏账本留证,新账本可正常读写', () => {
    quarantineLedgerWithPendingSetting()
    writeFileSync(storePath, JSON.stringify({ 'Wi-Fi/socks-proxy': OUR_VALUE }))

    const result = recoverLedger(dataDir, adapter())

    expect(result?.failed).toEqual([])
    expect(result?.diagnostics).toBeUndefined()
    expect(readFakeStore(storePath)).toEqual({})
    expect(existsSync(join(dataDir, 'ledger-recovery-required'))).toBe(false)
    expect(readdirSync(dataDir).some((name) => name.startsWith('ledger.json.bad-'))).toBe(true)
    const entries = loadLedger(dataDir)
    expect(pendingSettingEntries(dataDir)).toEqual([])
    expect(entries.some((entry) => entry.kind === 'setting' && entry.note.includes('损坏恢复'))).toBe(true)
    // 恢复后的账本可继续记账(砖已解除)
    appendSettingEntry(dataDir, {
      service: 'Wi-Fi', item: 'socks-proxy',
      originalValue: null, writtenValue: OUR_VALUE,
      sessionToken: generateSessionToken(), time: 2
    })
    expect(loadLedger(dataDir).length).toBeGreaterThan(1)
  })

  it('现值已被第三方改动时保留现值记 keptModified 语义,标记同样清除,不动他人设置', () => {
    quarantineLedgerWithPendingSetting()
    const thirdParty = { enabled: true, host: '10.0.0.9', port: 7890 }
    writeFileSync(storePath, JSON.stringify({ 'Wi-Fi/socks-proxy': thirdParty }))

    const result = recoverLedger(dataDir, adapter())

    expect(result?.failed).toEqual([])
    expect(readFakeStore(storePath)).toEqual({ 'Wi-Fi/socks-proxy': thirdParty })
    expect(existsSync(join(dataDir, 'ledger-recovery-required'))).toBe(false)
    const entries = loadLedger(dataDir)
    expect(entries.some((entry) => entry.kind === 'setting' && entry.note.includes('保留现值'))).toBe(true)
    expect(pendingSettingEntries(dataDir)).toEqual([])
  })

  it('设置写回失败时保留标记并给出可复制诊断,⛔ 假装已恢复', () => {
    quarantineLedgerWithPendingSetting()
    writeFileSync(storePath, JSON.stringify({ 'Wi-Fi/socks-proxy': OUR_VALUE }))
    const failing = createAdapter({
      ...fakeAdapterEnv(storePath),
      FAKE_ADAPTER_FAILURES: JSON.stringify({ write: [{ key: 'Wi-Fi/socks-proxy', message: '注入写失败' }] })
    } as NodeJS.ProcessEnv)

    const result = recoverLedger(dataDir, failing)

    expect(result?.failed.length).toBeGreaterThan(0)
    expect(result?.diagnostics).toContain('损坏账本恢复未完成')
    expect(result?.diagnostics).toContain('注入写失败')
    expect(existsSync(join(dataDir, 'ledger-recovery-required'))).toBe(true)
    expect(() => loadLedger(dataDir)).toThrow()
  })

  it('坏账本完全无法解析时保留标记并给出含坏文件名的诊断', () => {
    writeFileSync(join(dataDir, 'ledger.json'), '{"half":')
    expect(() => loadLedger(dataDir)).toThrow()

    const result = recoverLedger(dataDir, adapter())

    expect(result?.failed.length ?? 0).toBeGreaterThan(0)
    expect(result?.diagnostics).toContain('无法解析')
    expect(existsSync(join(dataDir, 'ledger-recovery-required'))).toBe(true)
  })

  // 独立的已隔离环境:mac 与 win 是两份随包拷贝,生产从不同时跑同一数据目录。
  function quarantinedEnv() {
    const envDataDir = makeTempDir('laixin-ledger-recovery-proc-')
    const envStorePath = join(envDataDir, 'fake-system.json')
    appendSettingEntry(envDataDir, {
      service: 'Wi-Fi', item: 'socks-proxy',
      originalValue: ORIGINAL_VALUE, writtenValue: OUR_VALUE,
      sessionToken: generateSessionToken(), time: 1
    })
    const path = join(envDataDir, 'ledger.json')
    const entries = JSON.parse(readFileSync(path, 'utf8')) as unknown[]
    entries.push({ corrupted: true })
    writeFileSync(path, JSON.stringify(entries))
    expect(() => loadLedger(envDataDir)).toThrow()
    writeFileSync(envStorePath, JSON.stringify({ 'Wi-Fi/socks-proxy': OUR_VALUE }))
    return { envDataDir, envStorePath }
  }

  function runDaemon(platform: 'mac' | 'win', args: string[], envStorePath: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const daemonPath = fileURLToPath(new URL(`../../sidecar/${platform}/tunnel-daemon.mjs`, import.meta.url))
    const fakeAdapter = fileURLToPath(new URL('./fixtures/fake-adapter.mjs', import.meta.url))
    // stdio 走文件描述符而非管道:与 daemon-process.test.ts 同款,避免挂起的子进程握住管道。
    const outPath = join(envStorePath, '..', `daemon-${platform}.out.log`)
    const outFd = openSync(outPath, 'a')
    return new Promise((resolve, reject) => {
      const child: ChildProcess = spawn(process.execPath, [daemonPath, ...args, '--adapter', fakeAdapter], {
        env: { ...process.env, FAKE_ADAPTER_STORE: envStorePath },
        stdio: ['ignore', outFd, outFd]
      })
      closeSync(outFd)
      const guard = setTimeout(() => { child.kill('SIGKILL') }, 15_000)
      child.once('error', (error) => { clearTimeout(guard); reject(error) })
      child.once('close', (code) => {
        clearTimeout(guard)
        let output = ''
        try { output = readFileSync(outPath, 'utf8') } catch { /* 无输出也照常返回 */ }
        resolve({ code, stdout: output, stderr: output })
      })
    })
  }

  it('restore 子命令对坏账本执行恢复:退出 0、标记消失、系统设置为原状(mac/win 同份代码)', async () => {
    const results = await Promise.all((['mac', 'win'] as const).map(async (platform) => {
      const { envDataDir, envStorePath } = quarantinedEnv()
      const outcome = await runDaemon(platform, ['restore', '--data-dir', envDataDir], envStorePath)
      return {
        platform, ...outcome,
        storeAfter: readFakeStore(envStorePath),
        markerAfter: existsSync(join(envDataDir, 'ledger-recovery-required')),
        envDataDir
      }
    }))
    for (const { platform, code, stdout, stderr, storeAfter, markerAfter, envDataDir } of results) {
      expect(`${platform}:${stderr}`).not.toContain('恢复流程异常')
      expect(code, `${platform} stderr=${stderr} stdout=${stdout}`).toBe(0)
      expect(stdout).not.toContain('"state":"error"')
      expect(storeAfter).toEqual({})
      expect(markerAfter).toBe(false)
      expect(readdirSync(envDataDir).some((name) => name.startsWith('ledger.json.bad-'))).toBe(true)
    }
    // 恢复语义与常规 restore 一致:恢复后没有待恢复项
    expect(restoreLedger(dataDir, adapter()).restored).toEqual([])
  })

  it('start 子命令启动前恢复坏账本:守护按 shutdown 意图正常收尾退出 0(mac 守护实测)', async () => {
    // 注:win 守护与 mac 字节级相同(见下方 cmp 断言);win 守护在 mac 上以「start+退出」
    // 结束会触发 power-events 的 powershell 探测失败重试与退出路径的环境级伪象(与恢复无关),
    // 故 start 命令的进程级证明用 mac 守护,win 侧一致性由 cmp 断言兜底。
    const { envDataDir, envStorePath } = quarantinedEnv()
    writeFileSync(join(envDataDir, 'intent.json'), `${JSON.stringify({ desired: 'shutdown', updatedAt: 1 })}\n`)
    const { code, stderr } = await runDaemon('mac', ['start', '--data-dir', envDataDir], envStorePath)
    expect(stderr).not.toContain('恢复流程异常')
    expect(code).toBe(0)
    expect(readFakeStore(envStorePath)).toEqual({})
    expect(existsSync(join(envDataDir, 'ledger-recovery-required'))).toBe(false)
  })

  it('收敛包3红线:六个共享 sidecar 文件 mac/win 字节级一致(cmp)', () => {
    for (const name of ['daemon-core.mjs', 'ledger.mjs', 'socks5.mjs', 'restore.mjs', 'local-bridge.mjs', 'xray-runner.mjs', 'tunnel-daemon.mjs']) {
      const mac = readFileSync(fileURLToPath(new URL(`../../sidecar/mac/${name}`, import.meta.url)))
      const win = readFileSync(fileURLToPath(new URL(`../../sidecar/win/${name}`, import.meta.url)))
      expect(mac.equals(win), `${name} mac/win 必须字节级相同`).toBe(true)
    }
  })

  // 审计 R1(2026-09-12 上线检查):设置条目只丢 note 等可缺字段时,旧逻辑把条目静默过滤,
  // 恢复误报成功、标记被清,系统代理仍指向本机桥且失去待恢复记录。
  // 证据 evidence/repro-ledger-recovery.json。
  function quarantineLedgerWithPartiallyDamagedSetting(damage: (entry: Record<string, unknown>) => void) {
    appendSettingEntry(dataDir, {
      service: 'Wi-Fi', item: 'socks-proxy',
      originalValue: ORIGINAL_VALUE, writtenValue: OUR_VALUE,
      sessionToken: generateSessionToken(), time: 1
    })
    const path = join(dataDir, 'ledger.json')
    const entries = JSON.parse(readFileSync(path, 'utf8')) as Array<Record<string, unknown>>
    damage(entries[0])
    writeFileSync(path, JSON.stringify(entries))
    expect(() => loadLedger(dataDir)).toThrow()
    expect(existsSync(join(dataDir, 'ledger-recovery-required'))).toBe(true)
    expect(readdirSync(dataDir).some((name) => name.startsWith('ledger.json.bad-'))).toBe(true)
  }

  it('审计 R1:条目只丢 note(原值与写入值都在)→ 存疑条目照样恢复:写回 1 次、代理回原值、标记只在全部恢复后清', () => {
    quarantineLedgerWithPartiallyDamagedSetting((entry) => { delete entry.note })
    writeFileSync(storePath, JSON.stringify({ 'Wi-Fi/socks-proxy': OUR_VALUE }))
    const base = adapter()
    let writes = 0
    const counting = { ...base, write: (target: { service: string; item: string }, value: unknown) => {
      writes += 1
      return base.write(target, value)
    } }

    const result = recoverLedger(dataDir, counting)

    expect(result?.failed).toEqual([])
    expect(result?.diagnostics).toBeUndefined()
    expect(writes).toBe(1) // 恢复函数写回 1 次(旧逻辑写回 0 次还清了标记)
    expect(readFakeStore(storePath)).toEqual({}) // 系统代理回原值,不再指向本机桥
    expect(existsSync(join(dataDir, 'ledger-recovery-required'))).toBe(false)
    expect(readdirSync(dataDir).some((name) => name.startsWith('ledger.json.bad-'))).toBe(true)
    // 重建账本里的存疑条目已补全结构:可正常读取,不再二次隔离,也没有待恢复项
    expect(() => loadLedger(dataDir)).not.toThrow()
    expect(pendingSettingEntries(dataDir)).toEqual([])
    expect(loadLedger(dataDir).some((entry) => entry.kind === 'setting' && entry.note.includes('损坏恢复:已写回原值'))).toBe(true)
  })

  it('审计 R1:存疑条目缺写入值且现值非原值 → 不覆盖现值,计入失败,标记保留', () => {
    quarantineLedgerWithPartiallyDamagedSetting((entry) => { delete entry.note; delete entry.writtenValue })
    const thirdParty = { enabled: true, host: '10.0.0.9', port: 7890 }
    writeFileSync(storePath, JSON.stringify({ 'Wi-Fi/socks-proxy': thirdParty }))

    const result = recoverLedger(dataDir, adapter())

    expect(result?.failed.length).toBe(1)
    expect(result?.failed[0]).toContain('无法判定所有权')
    expect(readFakeStore(storePath)).toEqual({ 'Wi-Fi/socks-proxy': thirdParty }) // ⛔ 覆盖第三方现值
    expect(existsSync(join(dataDir, 'ledger-recovery-required'))).toBe(true)
  })

  it('审计 R1:条目连原值都丢了(无法识别)→ 不清标记,诊断点名未识别条目数', () => {
    quarantineLedgerWithPartiallyDamagedSetting((entry) => { delete entry.note; delete entry.originalValue })
    writeFileSync(storePath, JSON.stringify({ 'Wi-Fi/socks-proxy': OUR_VALUE }))

    const result = recoverLedger(dataDir, adapter())

    expect(result?.failed.length).toBe(1)
    expect(result?.failed[0]).toContain('无法识别')
    expect(existsSync(join(dataDir, 'ledger-recovery-required'))).toBe(true)
    expect(readFakeStore(storePath)).toEqual({ 'Wi-Fi/socks-proxy': OUR_VALUE })
  })

  // 审计 R1 形态 B(2026-09-12 上线检查):已 restored 的条目丢 note + 一条完整待恢复条目。
  // 旧逻辑重建账本时把不合规条目原样写回 → 下次启动再判损坏、再隔离,ledger.json.bad-*
  // 每次多一个,主进程持续报「恢复记录损坏」。这里连跑三轮启动序列证明循环已断。
  it('审计 R1 形态 B:已恢复条目结构不合规 → 重建时补齐,连跑三轮只隔离一次', () => {
    appendSettingEntry(dataDir, {
      service: 'Wi-Fi', item: 'socks-proxy',
      originalValue: ORIGINAL_VALUE, writtenValue: OUR_VALUE,
      sessionToken: generateSessionToken(), time: 1
    })
    const path = join(dataDir, 'ledger.json')
    const [pending] = JSON.parse(readFileSync(path, 'utf8')) as Array<Record<string, unknown>>
    const settled: Record<string, unknown> = { ...pending, id: 'w-old-1', status: 'restored' }
    delete settled.note
    writeFileSync(path, JSON.stringify([settled, pending]))
    expect(() => loadLedger(dataDir)).toThrow()
    writeFileSync(storePath, JSON.stringify({ 'Wi-Fi/socks-proxy': OUR_VALUE }))

    // 守护启动序列:ledgerFailure → recoverLedger,连跑三轮。
    const failures: Array<string | undefined> = []
    for (let cycle = 0; cycle < 3; cycle += 1) {
      const failure = ledgerFailure(dataDir)
      failures.push(failure?.code)
      if (failure !== undefined) recoverLedger(dataDir, adapter())
    }

    expect(failures).toEqual(['LEDGER_CORRUPT', undefined, undefined])
    expect(readdirSync(dataDir).filter((name) => name.startsWith('ledger.json.bad-')).length).toBe(1)
    expect(existsSync(join(dataDir, 'ledger-recovery-required'))).toBe(false)
    expect(readFakeStore(storePath)).toEqual({})
    expect(pendingSettingEntries(dataDir)).toEqual([])
  })

  // 审计 R1 形态 C/D:判据从「kind 标签」改挂「有没有可恢复载荷」(service+item+原值)。
  // 旧逻辑按 kind 过滤,丢了或拼坏 kind 的条目被静默丢弃:标记照清,系统代理仍指向本机桥。
  it.each([
    ['kind 字段丢失', (entry: Record<string, unknown>) => { delete entry.kind }],
    ['kind 被拼坏成 settings', (entry: Record<string, unknown>) => { entry.kind = 'settings' }]
  ])('审计 R1 形态 C/D:%s(服务/设置项/原值/写入值都在)→ 照样写回原值并清标记', (_name, damage) => {
    quarantineLedgerWithPartiallyDamagedSetting(damage)
    writeFileSync(storePath, JSON.stringify({ 'Wi-Fi/socks-proxy': OUR_VALUE }))
    const base = adapter()
    let writes = 0
    const counting = { ...base, write: (target: { service: string; item: string }, value: unknown) => {
      writes += 1
      return base.write(target, value)
    } }

    const result = recoverLedger(dataDir, counting)

    expect(result?.failed).toEqual([])
    expect(writes).toBe(1) // 旧逻辑写回 0 次还清了标记
    expect(readFakeStore(storePath)).toEqual({}) // 系统代理回原值,不再指向本机桥
    expect(existsSync(join(dataDir, 'ledger-recovery-required'))).toBe(false)
    expect(readdirSync(dataDir).filter((name) => name.startsWith('ledger.json.bad-')).length).toBe(1)
    expect(() => loadLedger(dataDir)).not.toThrow()
    expect(pendingSettingEntries(dataDir)).toEqual([])
  })

  it('审计 R1 形态 E:条目丢服务名(没有可恢复载荷)→ 不清标记,计入失败交人工', () => {
    quarantineLedgerWithPartiallyDamagedSetting((entry) => { delete entry.service })
    writeFileSync(storePath, JSON.stringify({ 'Wi-Fi/socks-proxy': OUR_VALUE }))

    const result = recoverLedger(dataDir, adapter())

    expect(result?.failed.length).toBe(1)
    expect(result?.failed[0]).toContain('无法识别')
    expect(existsSync(join(dataDir, 'ledger-recovery-required'))).toBe(true)
    expect(readFakeStore(storePath)).toEqual({ 'Wi-Fi/socks-proxy': OUR_VALUE })
  })

  it('主进程 recoverOnBoot 遇到损坏账本也派发一次性恢复,不再直接放弃', async () => {
    quarantineLedgerWithPendingSetting()
    writeFileSync(storePath, JSON.stringify({ 'Wi-Fi/socks-proxy': OUR_VALUE }))
    let restoreSpawned = 0
    const supervisor = new DaemonSupervisor({
      dataDir,
      spawnDaemon: () => ({ on: () => undefined }),
      spawnRestore: () => {
        restoreSpawned += 1
        return { on: (event: 'exit', callback: (code: number | null, signal: string | null) => void) => { if (event === 'exit') queueMicrotask(() => callback(0, null)) } }
      }
    })
    supervisor.recoverOnBoot()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(restoreSpawned).toBe(1)
  })
})
