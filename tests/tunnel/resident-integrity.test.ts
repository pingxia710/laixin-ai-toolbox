// 常驻守护自检与自卸（0.5.0 · Mac 卸载流程）。
// 客户感受那一条：把应用拖进废纸篓之后，电脑的网必须是好的，也不留指向已删程序的东西。
// macOS 没有卸载器可挂钩子，这时候主进程多半早退了，唯一还占着客户系统代理的是守护自己，
// 所以判据全在守护侧：程序文件没了 → 按账本还原 → 删常驻项 → 可以退出。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createAdapter } from './fixtures/fake-adapter.mjs'
import { appendSettingEntry, generateSessionToken, loadLedger } from '../../sidecar/mac/ledger.mjs'
import {
  RESIDENT_LABEL,
  createResidentIntegrityCheck,
  macAgentPath,
  removeResident,
  residentBinaryMissing,
  runResidentSelfHeal
} from '../../sidecar/mac/resident-integrity.mjs'
import { fakeAdapterEnv, makeTempDir, readFakeStore, removeTempDir } from './helpers'

const ITEM_REF = { service: 'Wi-Fi', item: 'socks-proxy' }
const CUSTOMER_VALUE = { enabled: false, host: '', port: 0 }
const OUR_VALUE = { enabled: true, host: '127.0.0.1', port: 18080 }

describe('常驻守护自检与自卸', () => {
  let dataDir: string
  let home: string
  let storePath: string

  beforeEach(() => {
    dataDir = makeTempDir('laixin-resident-integrity-')
    home = makeTempDir('laixin-resident-home-')
    storePath = join(dataDir, 'fake-system.json')
    mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true })
  })
  afterEach(() => {
    removeTempDir(dataDir)
    removeTempDir(home)
  })

  function adapter(extraFailures?: unknown) {
    return createAdapter(fakeAdapterEnv(storePath, extraFailures))
  }

  /** 模拟「守护连上了」：客户原本没开代理，我们把代理改到本机中继，并把原值记进账本。 */
  function connectedState(): void {
    const ours = adapter()
    ours.write(ITEM_REF, OUR_VALUE)
    appendSettingEntry(dataDir, { ...ITEM_REF, originalValue: CUSTOMER_VALUE, writtenValue: OUR_VALUE, sessionToken: generateSessionToken(), time: 1 })
  }

  function plist(): string {
    return macAgentPath(home, RESIDENT_LABEL)
  }

  function installPlist(): void {
    writeFileSync(plist(), '<plist/>')
  }

  it('宽限期：连续 N 次探不到才算被删，中间探到一次就清零（⛔ 把更新中的一瞬当成卸载）', () => {
    const present = new Set(['/app/Toolbox'])
    const check = createResidentIntegrityCheck({ paths: ['/app/Toolbox'], threshold: 3, exists: (path) => present.has(path) })
    expect(check.check()).toMatchObject({ missing: false, misses: 0 })
    present.delete('/app/Toolbox')
    expect(check.check()).toMatchObject({ missing: false, misses: 1 })
    expect(check.check()).toMatchObject({ missing: false, misses: 2 })
    // mac 更新是原地换 bundle，路径会短暂消失又回来：回来即清零
    present.add('/app/Toolbox')
    expect(check.check()).toMatchObject({ missing: false, misses: 0 })
    present.delete('/app/Toolbox')
    check.check(); check.check()
    expect(check.check()).toMatchObject({ missing: true, misses: 3, absent: ['/app/Toolbox'] })
  })

  it('路径没给（开发态/参数没传到）一律当作还在，⛔ 凭不知道就去拆客户的连接', () => {
    expect(residentBinaryMissing(undefined as unknown as string)).toBe(false)
    expect(residentBinaryMissing('')).toBe(false)
    expect(residentBinaryMissing('/definitely/not/here/Toolbox')).toBe(true)
    expect(() => createResidentIntegrityCheck({ paths: [] })).toThrow('RESIDENT_INTEGRITY_PATHS_REQUIRED')
  })

  it('应用被删：按账本把客户的原设置写回去，删掉 LaunchAgent，并告诉守护可以退出了', () => {
    connectedState()
    installPlist()
    expect(readFakeStore(storePath)[`${ITEM_REF.service}/${ITEM_REF.item}`]).toEqual(OUR_VALUE)

    const outcome = runResidentSelfHeal({ dataDir, adapter: adapter(), home, platform: 'darwin' })

    expect(outcome).toMatchObject({ restored: 1, unrestored: 0, residentRemoved: true, shouldExit: true })
    // 客户的电脑回到原样：代理还回去了
    expect(readFakeStore(storePath)[`${ITEM_REF.service}/${ITEM_REF.item}`]).toEqual(CUSTOMER_VALUE)
    // 不留任何指向已删程序的东西
    expect(existsSync(plist())).toBe(false)
    // 还原走的是账本（条目被标成已恢复），⛔ 另写一套写回系统设置的代码。
    // 先断言账目确实有——every() 对空数组返回 true，账本一条都没有时这一句会绿得毫无意义。
    const settings = loadLedger(dataDir).filter((entry) => entry.kind === 'setting')
    expect(settings.map((entry) => entry.status)).toEqual(['restored'])
  })

  it('⛔ 动客户的连接意图：客户只是把应用挪到别的文件夹，从新位置重开要能自己接着连', () => {
    // 自检判「程序不在了」看的是路径，而「挪走」和「删掉」在路径上一模一样，分不出来也不该分：
    // 两种都得先把客户的系统设置还回去。区别在后面——挪走的话应用还在，客户从新位置一开，
    // 工具箱要按「我本来是连着的」自己连上。撑住这条的是「自愈 ⛔ 碰意图文件」：
    // 意图还是 connected，主进程启动时就会接续。哪天自愈顺手把意图写成 shutdown，
    // 客户就变成「挪个位置就得自己重点一次连接」，而且没人会发现。
    connectedState()
    installPlist()
    const intentPath = join(dataDir, 'intent.json')
    const intent = JSON.stringify({ desired: 'connected', sessionToken: 'abc', updatedAt: 1 })
    writeFileSync(intentPath, intent)

    const outcome = runResidentSelfHeal({ dataDir, adapter: adapter(), home, platform: 'darwin' })

    expect(outcome.shouldExit).toBe(true)
    expect(readFileSync(intentPath, 'utf8')).toBe(intent)
  })

  it('⛔ 对自己 launchctl bootout（那是给自己发 SIGTERM，会把还原打断）', () => {
    connectedState()
    installPlist()
    const calls: string[] = []
    const outcome = runResidentSelfHeal({ dataDir, adapter: adapter(), home, platform: 'darwin', run: (file) => { calls.push(file); return '' } })
    expect(outcome.shouldExit).toBe(true)
    expect(calls).toEqual([])
  })

  it('还原没还干净：保留常驻、不退出，留在原地下一轮再试（plist 一删就再没人能还了）', () => {
    connectedState()
    installPlist()
    const failing = adapter({ write: [{ key: `${ITEM_REF.service}/${ITEM_REF.item}`, message: '写回失败' }] })

    const outcome = runResidentSelfHeal({ dataDir, adapter: failing, home, platform: 'darwin' })

    expect(outcome.shouldExit).toBe(false)
    expect(outcome.residentRemoved).toBe(false)
    expect(outcome.unrestored).toBe(1)
    expect(existsSync(plist())).toBe(true)

    // 下一轮写回成功就走完：同一份账本继续还，⛔ 从头再来
    const second = runResidentSelfHeal({ dataDir, adapter: adapter(), home, platform: 'darwin' })
    expect(second).toMatchObject({ unrestored: 0, residentRemoved: true, shouldExit: true })
    expect(readFakeStore(storePath)[`${ITEM_REF.service}/${ITEM_REF.item}`]).toEqual(CUSTOMER_VALUE)
    expect(existsSync(plist())).toBe(false)
  })

  it('设置锁被别人占着：照实回报 settingsBusy 并等下一轮，⛔ 抛异常把守护打死', () => {
    connectedState()
    installPlist()
    // 用另一个活着的 pid 冒名持锁（本进程持锁是可重入的，测不出跨进程竞争）
    writeFileSync(join(dataDir, 'settings.lock'), JSON.stringify({ token: 'other', pid: livePid(), owner: 'other', at: Date.now() }), { mode: 0o600 })
    const outcome = runResidentSelfHeal({ dataDir, adapter: adapter(), home, platform: 'darwin', lockTimeoutMs: 200 })
    expect(outcome.settingsBusy).toBe(true)
    expect(outcome.shouldExit).toBe(false)
    expect(existsSync(plist())).toBe(true)
    rmSync(join(dataDir, 'settings.lock'), { force: true })
  })

  it('Windows 侧卸的是登录计划任务（不杀进程，所以这边没有自杀问题）；没建过也算成功', () => {
    const calls: Array<readonly string[]> = []
    expect(removeResident({ platform: 'win32', run: (file, args) => { calls.push([file, ...args]); return '' } })).toMatchObject({ removed: true })
    expect(calls).toEqual([['schtasks.exe', '/delete', '/tn', RESIDENT_LABEL, '/f']])
    expect(removeResident({
      platform: 'win32',
      run: () => { throw new Error('ERROR: The system cannot find the file specified.') }
    })).toMatchObject({ removed: true })
    expect(removeResident({ platform: 'win32', run: () => { throw new Error('拒绝访问') } })).toMatchObject({ removed: false })
  })

  it('常驻标签与主进程那份字面量一致（改一处不改另一处 = 主进程装的守护自己卸不掉）', () => {
    const source = readFileSync(join(__dirname, '..', '..', 'app', 'main', 'tunnel', 'platform', 'resident.ts'), 'utf8')
    expect(source).toContain(`RESIDENT_LABEL = '${RESIDENT_LABEL}'`)
    expect(macAgentPath('/Users/someone')).toBe(`/Users/someone/Library/LaunchAgents/${RESIDENT_LABEL}.plist`)
  })
})

/** 一个确实活着、又不是本进程的 pid：用父进程；没有就退回本进程（可重入路径下锁判据仍成立）。 */
function livePid(): number {
  const parent = process.ppid
  return Number.isInteger(parent) && parent > 1 && parent !== process.pid ? parent : process.pid
}
