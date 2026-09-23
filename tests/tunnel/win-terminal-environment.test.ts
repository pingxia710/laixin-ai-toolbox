import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { appendSettingEntry, loadLedger, type SettingEntry } from '../../sidecar/win/ledger.mjs'
import { composeManagedAdapters, type ManagedNetworkAdapter } from '../../sidecar/win/managed-adapter.mjs'
import { restoreLedger } from '../../sidecar/win/restore.mjs'
import {
  createTerminalEnvironmentAdapter,
  type TerminalEnvironmentAdapter,
  type TerminalProxy,
  type TerminalRun
} from '../../sidecar/win/terminal-environment.mjs'
import { makeTempDir, removeTempDir } from './helpers'

const PROXY: TerminalProxy = { host: '127.0.0.1', port: 18080 }
const COMMAND_PROCESSOR_KEY = 'HKCU\\Software\\Microsoft\\Command Processor'
const USER_ENVIRONMENT_KEY = 'HKCU\\Environment'
const AUTORUN_MARKER = 'LAIXIN_AI_TOOLBOX_TERMINAL_V1:win-cmd-autorun'
const HELPER_PATH_ARGUMENT = 'call "%USERPROFILE%\\.laixin-ai-toolbox\\terminal-proxy.cmd"'
// 0.5.5–0.5.x 写下的 AutoRun 形态:rem 打头,cmd 把整行(含 &)当注释,call 从不执行。
const LEGACY_AUTORUN_BLOCK = `rem ${AUTORUN_MARKER} BEGIN & call "%USERPROFILE%\\.laixin-ai-toolbox\\terminal-proxy.cmd" & rem ${AUTORUN_MARKER} END`
// 修复后的 AutoRun 形态:真实 call 打头,所有权标记一头在 call 参数里、一头在结尾 rem 里。
const CURRENT_AUTORUN_BLOCK = `${HELPER_PATH_ARGUMENT} ${AUTORUN_MARKER} & rem ${AUTORUN_MARKER} END`

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')

interface AutoRunState {
  exists: boolean
  type: 'REG_SZ' | 'REG_EXPAND_SZ'
  value: string
}

interface EnvironmentValue {
  type: 'REG_SZ' | 'REG_EXPAND_SZ'
  data: string
}

function fakeRegistry(autoRun: AutoRunState, environment: Map<string, EnvironmentValue>): TerminalRun {
  return (command, args) => {
    if (command !== 'reg.exe') throw new Error('UNEXPECTED_COMMAND')
    const key = args[1]
    if (key === COMMAND_PROCESSOR_KEY) return autoRunOperation(autoRun, args)
    if (key === USER_ENVIRONMENT_KEY) return environmentOperation(environment, args)
    throw new Error('UNEXPECTED_REGISTRY_KEY:' + key)
  }
}

function autoRunOperation(state: AutoRunState, args: readonly string[]): string {
  if (args[0] === 'query' && args.includes('/v')) {
    if (!state.exists) throw new Error('AUTO_RUN_MISSING')
    return 'AutoRun\t' + state.type + '\t' + state.value + '\r\n'
  }
  if (args[0] === 'query') return 'Command Processor\n'
  if (args[0] === 'add') {
    const type = args[args.indexOf('/t') + 1]
    const value = args[args.indexOf('/d') + 1]
    if ((type !== 'REG_SZ' && type !== 'REG_EXPAND_SZ') || value === undefined) throw new Error('REG_ADD_INVALID')
    state.exists = true
    state.type = type
    state.value = value
    return ''
  }
  if (args[0] === 'delete') {
    state.exists = false
    state.value = ''
    return ''
  }
  throw new Error('UNEXPECTED_REG_OPERATION')
}

function environmentOperation(state: Map<string, EnvironmentValue>, args: readonly string[]): string {
  const name = args.includes('/v') ? args[args.indexOf('/v') + 1] : undefined
  if (args[0] === 'query') {
    return ['\r\nHKCU\\Environment\r\n',
      ...[...state.entries()].map(([key, value]) => `    ${key}    ${value.type}    ${value.data}\r\n`)].join('')
  }
  if (args[0] === 'add') {
    const type = args[args.indexOf('/t') + 1]
    const data = args[args.indexOf('/d') + 1]
    if ((type !== 'REG_SZ' && type !== 'REG_EXPAND_SZ') || data === undefined || name === undefined) throw new Error('REG_ADD_INVALID')
    state.set(name, { type, data })
    return ''
  }
  if (args[0] === 'delete') {
    if (name === undefined) throw new Error('REG_DELETE_INVALID')
    state.delete(name)
    return ''
  }
  throw new Error('UNEXPECTED_REG_OPERATION')
}

// cmd 的单行解析模型:从左到右扫描,引号外的 `rem ` 词让其后的整行(含 & 连接的命令)成为注释。
// 「我们那段 AutoRun 的 call 会真的执行」的结构断言:call 出现位置之前不允许存在任何引号外的 rem,
// 且它调用的助手脚本确实已落在盘上。修复前(rem 打头)这里直接红。
function assertAutoRunCallExecutes(value: string, helperPath: string): void {
  expect(existsSync(helperPath)).toBe(true)
  expect(value.includes('\n')).toBe(false)
  const callAt = value.indexOf('call "')
  expect(callAt).toBeGreaterThan(-1)
  let quoted = false
  for (let index = 0; index < callAt; index += 1) {
    if (value[index] === '"') quoted = !quoted
    if (quoted) continue
    const atWordBoundary = index === 0 || /\s/.test(value[index - 1] ?? '')
    if (atWordBoundary && value.slice(index).startsWith('rem ')) {
      throw new Error(`AUTORUN_CALL_SWALLOWED_BY_REM:${value}`)
    }
  }
  expect(value.slice(callAt).startsWith('call "%USERPROFILE%\\.laixin-ai-toolbox\\terminal-proxy.cmd"')).toBe(true)
}

// 客户原有 AutoRun 命令不被吞:必须原样在前,紧接着的是我们追加的可执行 call。
function assertCustomerAutoRunFirst(value: string, customerCommand: string): void {
  expect(value.startsWith(customerCommand)).toBe(true)
  expect(value.slice(customerCommand.length).startsWith(' & call "')).toBe(true)
}

function applyTerminal(dataDir: string, adapter: TerminalEnvironmentAdapter): void {
  for (const item of adapter.managedItems(PROXY)) {
    appendSettingEntry(dataDir, {
      service: item.ref.service,
      item: item.ref.item,
      originalValue: adapter.read(item.ref),
      writtenValue: item.value,
      sessionToken: 'win-terminal-test',
      time: 1
    })
    adapter.write(item.ref, item.value)
  }
}

function settingEntries(dataDir: string): SettingEntry[] {
  return loadLedger(dataDir).filter((entry): entry is SettingEntry => entry.kind === 'setting')
}

describe('Windows 终端自动接入', () => {
  let root: string
  let home: string
  let dataDir: string
  let autoRun: AutoRunState
  let environment: Map<string, EnvironmentValue>
  let notifyCount: number

  beforeEach(() => {
    root = makeTempDir('laixin-terminal-win-')
    home = join(root, 'home')
    dataDir = join(root, 'data')
    mkdirSync(home, { recursive: true })
    mkdirSync(dataDir, { recursive: true })
    autoRun = { exists: true, type: 'REG_EXPAND_SZ', value: 'echo CUSTOMER_AUTORUN_SECRET' }
    environment = new Map()
    notifyCount = 0
  })

  afterEach(() => {
    removeTempDir(root)
  })

  const build = () => createTerminalEnvironmentAdapter({
    enabled: true, home, run: fakeRegistry(autoRun, environment),
    notifyEnvironmentChanged: () => { notifyCount += 1 }
  })

  it('写入标准 Windows shell 接入;跨实例恢复保留 profile/AutoRun 的客户内容、删净环境变量且账本不泄露原文', async () => {
    const profile = join(home, 'Documents', 'PowerShell', 'Microsoft.PowerShell_profile.ps1')
    const helper = join(home, '.laixin-ai-toolbox', 'terminal-proxy.cmd')
    mkdirSync(join(home, 'Documents', 'PowerShell'), { recursive: true })
    writeFileSync(profile, "Write-Output 'CUSTOMER_PROFILE_SECRET'\r\n")
    const connecting = build()
    applyTerminal(dataDir, connecting)

    const items = connecting.managedItems(PROXY)
    const cmdHelper = items.find((item) => item.ref.item === 'win-cmd-helper')
    const autoRunItem = items.find((item) => item.ref.item === 'win-cmd-autorun')
    const envItem = items.find((item) => item.ref.item === 'win-user-env-https-proxy')
    if (cmdHelper === undefined || autoRunItem === undefined || envItem === undefined) throw new Error('WINDOWS_TERMINAL_ITEMS_MISSING')
    expect(connecting.valuesEqual(connecting.read(cmdHelper.ref), cmdHelper.value)).toBe(true)
    expect(connecting.valuesEqual(connecting.read(autoRunItem.ref), autoRunItem.value)).toBe(true)
    expect(connecting.valuesEqual(connecting.read(envItem.ref), envItem.value)).toBe(true)
    const cmdSource = readFileSync(helper, 'utf8')
    expect(cmdSource).toContain('@set "HTTP_PROXY=http://127.0.0.1:18080"')
    expect(cmdSource).toContain('rem LAIXIN_AI_TOOLBOX_TERMINAL_V1:win-cmd-helper BEGIN')
    expect(cmdSource).not.toMatch(/[<>]/)
    expect(readFileSync(profile, 'utf8')).toContain('$env:HTTP_PROXY')
    // AutoRun:结构断言(修复前 rem 打头,这里红)——call 真实可执行、客户原命令在前
    assertAutoRunCallExecutes(autoRun.value, helper)
    assertCustomerAutoRunFirst(autoRun.value, 'echo CUSTOMER_AUTORUN_SECRET')
    expect(autoRun.value).not.toMatch(/[<>]/)
    // 用户级环境变量:四条写入,类型与值精确
    expect(environment.get('HTTP_PROXY')).toEqual({ type: 'REG_SZ', data: 'http://127.0.0.1:18080' })
    expect(environment.get('HTTPS_PROXY')).toEqual({ type: 'REG_SZ', data: 'http://127.0.0.1:18080' })
    expect(environment.get('ALL_PROXY')).toEqual({ type: 'REG_SZ', data: 'socks5://127.0.0.1:18080' })
    expect(environment.get('NO_PROXY')).toEqual({ type: 'REG_SZ', data: 'localhost,127.0.0.1,::1' })
    // N-23 合批:一个同步写入批次只在批末广播一次(基线每变量各一次;慢机上四次 PowerShell 各 30-40s)
    await new Promise((resolve) => setImmediate(resolve))
    expect(notifyCount).toBeGreaterThan(0)

    const ledgerSource = readFileSync(join(dataDir, 'ledger.json'), 'utf8')
    expect(ledgerSource).not.toContain('CUSTOMER_AUTORUN_SECRET')
    expect(ledgerSource).not.toContain('CUSTOMER_PROFILE_SECRET')

    appendFileSync(profile, "Write-Output 'CUSTOMER_AFTER_CONNECT'\r\n")
    autoRun.value += ' & echo CUSTOMER_AUTORUN_AFTER_CONNECT'
    const recovering = build()
    const result = restoreLedger(dataDir, recovering)

    expect(result.failed).toEqual([])
    expect(result.keptModified).toEqual([])
    expect(result.restored).toHaveLength(10)
    expect(readFileSync(profile, 'utf8')).toContain('CUSTOMER_PROFILE_SECRET')
    expect(readFileSync(profile, 'utf8')).toContain('CUSTOMER_AFTER_CONNECT')
    expect(readFileSync(profile, 'utf8')).not.toContain('LAIXIN_AI_TOOLBOX_TERMINAL_V1')
    expect(autoRun).toEqual({
      exists: true,
      type: 'REG_EXPAND_SZ',
      value: 'echo CUSTOMER_AUTORUN_SECRET & echo CUSTOMER_AUTORUN_AFTER_CONNECT'
    })
    // 我们写的环境变量一条不残留;断开广播(新实例自己的欠发位)再次发出
    expect([...environment.keys()]).toEqual([])
    await new Promise((resolve) => setImmediate(resolve))
    expect(notifyCount).toBeGreaterThan(1)
    expect(existsSync(helper)).toBe(false)
    expect(settingEntries(dataDir).every((entry) => entry.status === 'restored')).toBe(true)
  })

  it('符号链接 profile 受控拒绝，不跟随客户 dotfiles', () => {
    const source = join(root, 'customer-profile.ps1')
    const profile = join(home, 'Documents', 'WindowsPowerShell', 'Microsoft.PowerShell_profile.ps1')
    mkdirSync(join(home, 'Documents', 'WindowsPowerShell'), { recursive: true })
    writeFileSync(source, "Write-Output 'KEEP'\r\n")
    symlinkSync(source, profile)
    const adapter = build()
    const item = adapter.managedItems(PROXY).find((candidate) => candidate.ref.item === 'win-powershell5-profile')
    if (item === undefined) throw new Error('POWERSHELL_PROFILE_ITEM_MISSING')

    expect(() => adapter.preflight(PROXY)).toThrowError(/TERMINAL_ENVIRONMENT_PROFILE_UNSAFE/)
    expect(() => adapter.read(item.ref)).toThrowError(/TERMINAL_ENVIRONMENT_PROFILE_UNSAFE/)
    expect(readFileSync(source, 'utf8')).toBe("Write-Output 'KEEP'\r\n")
  })

  it('符号链接父目录同样受控拒绝，不在外部 Documents 目录创建 profile', () => {
    const source = join(root, 'customer-documents')
    mkdirSync(source)
    symlinkSync(source, join(home, 'Documents'))
    const adapter = build()

    expect(() => adapter.preflight(PROXY)).toThrowError(/TERMINAL_ENVIRONMENT_PROFILE_UNSAFE/)
    expect(existsSync(join(source, 'WindowsPowerShell', 'Microsoft.PowerShell_profile.ps1'))).toBe(false)
  })

  it('复合适配器把固定终端配置异常当可选项跳过:预检不抛、只记一句说明、客户文件不动(发布审查 R2:⛔ 挡网络)', () => {
    const source = join(root, 'customer-profile.ps1')
    const profile = join(home, 'Documents', 'WindowsPowerShell', 'Microsoft.PowerShell_profile.ps1')
    mkdirSync(join(home, 'Documents', 'WindowsPowerShell'), { recursive: true })
    writeFileSync(source, "Write-Output 'KEEP'\r\n")
    symlinkSync(source, profile)
    const terminal = build()
    const network: ManagedNetworkAdapter = {
      managedItems: () => [],
      read: () => null,
      write: () => undefined
    }
    const adapter = composeManagedAdapters(network, terminal)

    expect(() => adapter.preflight?.(PROXY)).not.toThrow()
    expect(adapter.optionalNote?.()).toContain('终端自动接入这次没启用')
    expect(adapter.managedItems(PROXY)).toEqual([])
    expect(readFileSync(source, 'utf8')).toBe("Write-Output 'KEEP'\r\n")
  })

  it('默认关闭不改目录或注册表；非法代理受控拒绝', () => {
    const guarded = createTerminalEnvironmentAdapter({ home, run: fakeRegistry(autoRun, environment) })
    expect(guarded.managedItems(PROXY)).toEqual([])
    expect(autoRun.value).toBe('echo CUSTOMER_AUTORUN_SECRET')
    expect(environment.size).toBe(0)
    expect(existsSync(join(home, '.laixin-ai-toolbox', 'terminal-proxy.cmd'))).toBe(false)

    const adapter = build()
    const invalid = { host: '127.0.0.1', port: 0 } as unknown as TerminalProxy
    expect(() => adapter.managedItems(invalid)).toThrowError(/TERMINAL_ENVIRONMENT_PROXY_INVALID/)
  })
})

describe('cmd AutoRun 块:call 必须真实执行、客户命令不被吞(修复前 rem 打头整行被注释)', () => {
  let root: string
  let home: string
  let dataDir: string
  let autoRun: AutoRunState
  let environment: Map<string, EnvironmentValue>

  beforeEach(() => {
    root = makeTempDir('laixin-autorun-')
    home = join(root, 'home')
    dataDir = join(root, 'data')
    mkdirSync(home, { recursive: true })
    mkdirSync(dataDir, { recursive: true })
    autoRun = { exists: false, type: 'REG_SZ', value: '' }
    environment = new Map()
    // 助手脚本在本组用例里手工落盘:结构断言要求 call 指向的文件真实存在。
    mkdirSync(join(home, '.laixin-ai-toolbox'), { recursive: true })
    writeFileSync(join(home, '.laixin-ai-toolbox', 'terminal-proxy.cmd'), '@echo off\r\n')
  })

  afterEach(() => removeTempDir(root))

  const build = () => createTerminalEnvironmentAdapter({
    enabled: true, home, run: fakeRegistry(autoRun, environment),
    notifyEnvironmentChanged: () => undefined
  })
  const helper = () => join(home, '.laixin-ai-toolbox', 'terminal-proxy.cmd')
  const autoRunItemOf = (adapter: TerminalEnvironmentAdapter) => {
    const item = adapter.managedItems(PROXY).find((candidate) => candidate.ref.item === 'win-cmd-autorun')
    if (item === undefined) throw new Error('AUTORUN_ITEM_MISSING')
    return item
  }

  it('客户没有 AutoRun 时:整条值就是可执行的 call(变异回 rem 打头这里必红)', () => {
    const adapter = build()
    const item = autoRunItemOf(adapter)
    adapter.write(item.ref, item.value)
    expect(autoRun.exists).toBe(true)
    expect(autoRun.value).toBe(CURRENT_AUTORUN_BLOCK)
    assertAutoRunCallExecutes(autoRun.value, helper())
  })

  it('客户已有 AutoRun 时:原命令在前照旧执行,追加的 call 同样执行,删除后原样归还', () => {
    autoRun.exists = true
    autoRun.type = 'REG_SZ'
    autoRun.value = 'echo CUSTOMER_AUTORUN_SECRET'
    const adapter = build()
    applyTerminal(dataDir, adapter)
    expect(autoRun.value).toBe('echo CUSTOMER_AUTORUN_SECRET & ' + CURRENT_AUTORUN_BLOCK)
    assertCustomerAutoRunFirst(autoRun.value, 'echo CUSTOMER_AUTORUN_SECRET')
    assertAutoRunCallExecutes(autoRun.value, helper())
    expect(autoRun.value).not.toMatch(/[<>]/)

    autoRun.value += ' & echo CUSTOMER_AUTORUN_AFTER_CONNECT'
    const result = restoreLedger(dataDir, build())
    expect(result.failed).toEqual([])
    expect(autoRun.value).toBe('echo CUSTOMER_AUTORUN_SECRET & echo CUSTOMER_AUTORUN_AFTER_CONNECT')
    expect(autoRun.type).toBe('REG_SZ')
  })

  it('0.5.x 遗留坏块:所有权认得是我们写的,连接时整段换成能执行的形态,客户命令保留', () => {
    autoRun.exists = true
    autoRun.type = 'REG_SZ'
    autoRun.value = `echo CUSTOMER_AUTORUN_SECRET & ${LEGACY_AUTORUN_BLOCK}`
    const adapter = build()
    const item = autoRunItemOf(adapter)
    adapter.write(item.ref, item.value)
    expect(autoRun.value).toBe('echo CUSTOMER_AUTORUN_SECRET & ' + CURRENT_AUTORUN_BLOCK)
    assertCustomerAutoRunFirst(autoRun.value, 'echo CUSTOMER_AUTORUN_SECRET')
    assertAutoRunCallExecutes(autoRun.value, helper())
  })

  it('旧账本(0.5.x 摘要)照样能恢复:按账本摘要精确移除坏块,客户内容与值类型不丢', () => {
    autoRun.exists = true
    autoRun.type = 'REG_EXPAND_SZ'
    autoRun.value = `echo CUSTOMER_AUTORUN_SECRET & ${LEGACY_AUTORUN_BLOCK}`
    const legacyDigest = sha256(LEGACY_AUTORUN_BLOCK)
    appendSettingEntry(dataDir, {
      service: 'TerminalEnvironment',
      item: 'win-cmd-autorun',
      originalValue: {
        kind: 'terminal-registry-state', target: 'win-cmd-autorun', exists: true, registryType: 'REG_EXPAND_SZ',
        ownBlockPresent: true, ownBlockComplete: true, ownBlockDigest: legacyDigest,
        managed: { marker: AUTORUN_MARKER, proxy: PROXY, blockDigest: legacyDigest }
      },
      writtenValue: { kind: 'terminal-environment', target: 'win-cmd-autorun', marker: AUTORUN_MARKER, proxy: PROXY, blockDigest: legacyDigest },
      sessionToken: 'legacy-05x',
      time: 1
    })
    const result = restoreLedger(dataDir, build())
    expect(result.failed).toEqual([])
    expect(result.restored).toHaveLength(1)
    expect(autoRun.value).toBe('echo CUSTOMER_AUTORUN_SECRET')
    expect(autoRun.type).toBe('REG_EXPAND_SZ')
  })

  it('外来块(标记认得但内容对不上)受控拒绝,⛔ 覆盖', () => {
    autoRun.exists = true
    autoRun.type = 'REG_SZ'
    // 两枚标记都在、中间被塞了别人的命令:摘要对不上 → 受控拒绝。
    autoRun.value = `${HELPER_PATH_ARGUMENT} ${AUTORUN_MARKER} & echo INJECTED_BY_OTHERS & rem ${AUTORUN_MARKER} END`
    const adapter = build()
    const item = autoRunItemOf(adapter)
    expect(() => adapter.write(item.ref, item.value)).toThrowError(/TERMINAL_ENVIRONMENT_OWNERSHIP_CONFLICT/)
    expect(autoRun.value).toContain('echo INJECTED_BY_OTHERS')
  })
})

describe('用户级环境变量(HKCU\\Environment):Restricted 执行策略下也生效的通道', () => {
  let root: string
  let home: string
  let dataDir: string
  let autoRun: AutoRunState
  let environment: Map<string, EnvironmentValue>
  let notifyCount: number

  beforeEach(() => {
    root = makeTempDir('laixin-user-env-')
    home = join(root, 'home')
    dataDir = join(root, 'data')
    mkdirSync(home, { recursive: true })
    mkdirSync(dataDir, { recursive: true })
    autoRun = { exists: false, type: 'REG_SZ', value: '' }
    environment = new Map()
    notifyCount = 0
  })

  afterEach(() => removeTempDir(root))

  const build = () => createTerminalEnvironmentAdapter({
    enabled: true, home, run: fakeRegistry(autoRun, environment),
    notifyEnvironmentChanged: () => { notifyCount += 1 }
  })
  const envItemOf = (adapter: TerminalEnvironmentAdapter, item: string) => {
    const managed = adapter.managedItems(PROXY).find((candidate) => candidate.ref.item === item)
    if (managed === undefined) throw new Error('USER_ENVIRONMENT_ITEM_MISSING:' + item)
    return managed
  }

  it('连接写入四条变量,一个同步写入批次批末广播一次(N-23 合批;基线每变量各一次);再连一次幂等不重复写', async () => {
    const adapter = build()
    const items = adapter.managedItems(PROXY)
    for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY']) {
      expect(items.some((candidate) => candidate.ref.item === `win-user-env-${name.toLowerCase().replace('_', '-')}`)).toBe(true)
    }
    applyTerminal(dataDir, adapter)
    const snapshot = new Map(environment)
    expect(snapshot.get('HTTP_PROXY')).toEqual({ type: 'REG_SZ', data: 'http://127.0.0.1:18080' })
    expect(snapshot.get('NO_PROXY')).toEqual({ type: 'REG_SZ', data: 'localhost,127.0.0.1,::1' })
    // 同步批次内欠着,批末恰好一次,覆盖全部四个变量
    expect(notifyCount).toBe(0)
    await new Promise((resolve) => setImmediate(resolve))
    expect(notifyCount).toBe(1)

    applyTerminal(dataDir, adapter)
    expect(environment).toEqual(snapshot)
    await new Promise((resolve) => setImmediate(resolve))
    expect(notifyCount).toBe(2)
  })

  it('外来值不覆盖:客户已设 HTTP_PROXY → 原样保留,其余照写;账本与快照都只有指纹没有原文', () => {
    environment.set('HTTP_PROXY', { type: 'REG_EXPAND_SZ', data: 'http://corp-proxy.internal:3128' })
    const adapter = build()
    applyTerminal(dataDir, adapter)
    expect(environment.get('HTTP_PROXY')).toEqual({ type: 'REG_EXPAND_SZ', data: 'http://corp-proxy.internal:3128' })
    expect(environment.get('HTTPS_PROXY')?.data).toBe('http://127.0.0.1:18080')
    const envItem = envItemOf(adapter, 'win-user-env-http-proxy')
    // 「满足接管要求」:skip 的变量不参与,到位即满足(verifySettings 的判据)
    expect(adapter.valuesEqual(adapter.read(envItem.ref), envItem.value)).toBe(true)
    const ledgerSource = readFileSync(join(dataDir, 'ledger.json'), 'utf8')
    expect(ledgerSource).not.toContain('corp-proxy.internal')
    expect(JSON.stringify(adapter.read(envItem.ref))).not.toContain('corp-proxy.internal')

    const result = restoreLedger(dataDir, build())
    expect(result.failed).toEqual([])
    expect(environment.get('HTTP_PROXY')).toEqual({ type: 'REG_EXPAND_SZ', data: 'http://corp-proxy.internal:3128' })
    expect(environment.has('HTTPS_PROXY')).toBe(false)
    expect(environment.has('ALL_PROXY')).toBe(false)
    expect(environment.has('NO_PROXY')).toBe(false)
  })

  it('外部删除其中一条后接管判定仍满足(不反抢);恢复把剩下的补删干净', () => {
    const adapter = build()
    applyTerminal(dataDir, adapter)
    environment.delete('ALL_PROXY')
    const envItem = envItemOf(adapter, 'win-user-env-all-proxy')
    expect(adapter.valuesEqual(adapter.read(envItem.ref), envItem.value)).toBe(true)

    const result = restoreLedger(dataDir, build())
    expect(result.failed).toEqual([])
    expect(result.keptModified).toEqual([])
    expect(environment.size).toBe(0)
  })

  it('连接期间客户改掉我们写的值:首次断开环境里只剩客户改的那一个,其余照删(修复前红)', () => {
    const adapter = build()
    applyTerminal(dataDir, adapter)
    environment.set('HTTPS_PROXY', { type: 'REG_SZ', data: 'http://customer-chosen:9' })

    const result = restoreLedger(dataDir, build())
    expect(result.failed).toEqual([])
    // 客户改的现值保留(⛔ 硬改回)……
    expect(environment.get('HTTPS_PROXY')).toEqual({ type: 'REG_SZ', data: 'http://customer-chosen:9' })
    // ……而仍是我们写的三个**首次断开就删净**,⛔ 残留指向已关闭的本机端口
    expect(environment.has('HTTP_PROXY')).toBe(false)
    expect(environment.has('ALL_PROXY')).toBe(false)
    expect(environment.has('NO_PROXY')).toBe(false)
    // 结算按变量:被改的那项 restored(责任了结——现值归客户,⛔ 不再 Retry 也不会误删);其余三项 restored(已删)
    const statuses = new Map(settingEntries(dataDir)
      .filter((entry) => entry.item.startsWith('win-user-env-'))
      .map((entry) => [entry.item, entry.status]))
    expect(statuses.get('win-user-env-https-proxy')).toBe('restored')
    expect(statuses.get('win-user-env-http-proxy')).toBe('restored')
    expect(statuses.get('win-user-env-all-proxy')).toBe('restored')
    expect(statuses.get('win-user-env-no-proxy')).toBe('restored')
  })

  it('恢复写入只删仍是我们的值:客户改过的现值 ⛔ 碰(直接调用适配器,不走账本门)', () => {
    const adapter = build()
    applyTerminal(dataDir, adapter)
    environment.set('HTTPS_PROXY', { type: 'REG_SZ', data: 'http://customer-chosen:9' })
    const entry = settingEntries(dataDir).find((candidate) => candidate.item === 'win-user-env-https-proxy')
    if (entry === undefined) throw new Error('ENTRY_MISSING')

    // 拿账本里那条的 originalValue(恢复形态的快照)直接驱动适配器:绕开 restoreLedger 的
    // 「整项相等才写」门,钉住「逐变量只删仍是我们的值」这层判断本身。
    adapter.write({ service: 'TerminalEnvironment', item: 'win-user-env-https-proxy' }, entry.originalValue)
    expect(environment.get('HTTPS_PROXY')).toEqual({ type: 'REG_SZ', data: 'http://customer-chosen:9' })
  })

  it('广播失败 ⛔ 把已写入的值翻成写入失败:值保持已写,恢复照常删净', () => {
    const boom = () => { throw new Error('notify channel down') }
    const adapter = createTerminalEnvironmentAdapter({
      enabled: true, home, run: fakeRegistry(autoRun, environment),
      notifyEnvironmentChanged: boom
    })
    expect(() => applyTerminal(dataDir, adapter)).not.toThrow()
    expect(environment.get('HTTPS_PROXY')).toEqual({ type: 'REG_SZ', data: 'http://127.0.0.1:18080' })

    const recovering = createTerminalEnvironmentAdapter({
      enabled: true, home, run: fakeRegistry(autoRun, environment),
      notifyEnvironmentChanged: boom
    })
    const result = restoreLedger(dataDir, recovering)
    expect(result.failed).toEqual([])
    expect(environment.size).toBe(0)
  })

  const seedLegacyWholeItemEntry = () => {
    const ours = {
      HTTP_PROXY: 'http://127.0.0.1:18080',
      HTTPS_PROXY: 'http://127.0.0.1:18080',
      ALL_PROXY: 'socks5://127.0.0.1:18080',
      NO_PROXY: 'localhost,127.0.0.1,::1'
    }
    const legacyMarker = 'LAIXIN_AI_TOOLBOX_TERMINAL_V1:win-user-environment'
    const legacyDigest = sha256(Object.entries(ours).map(([name, value]) => `${name}=${value}`).join('\n'))
    const fp = (data: string) => sha256(`env-value:${data}`)
    appendSettingEntry(dataDir, {
      service: 'TerminalEnvironment',
      item: 'win-user-environment',
      originalValue: {
        kind: 'terminal-registry-state', target: 'win-user-environment', exists: true,
        variables: { HTTP_PROXY: fp(ours.HTTP_PROXY), HTTPS_PROXY: fp(ours.HTTPS_PROXY), ALL_PROXY: fp(ours.ALL_PROXY), NO_PROXY: fp(ours.NO_PROXY) },
        managed: { marker: legacyMarker, proxy: PROXY, blockDigest: legacyDigest }
      },
      writtenValue: { kind: 'terminal-environment', target: 'win-user-environment', marker: legacyMarker, proxy: PROXY, blockDigest: legacyDigest },
      sessionToken: 'legacy-whole-item',
      time: 1
    })
  }

  it('旧账本(整项 win-user-environment):四个仍是我们写的值 → 照常全删', () => {
    for (const [name, data] of [
      ['HTTP_PROXY', 'http://127.0.0.1:18080'],
      ['HTTPS_PROXY', 'http://127.0.0.1:18080'],
      ['ALL_PROXY', 'socks5://127.0.0.1:18080'],
      ['NO_PROXY', 'localhost,127.0.0.1,::1']
    ] as const) {
      environment.set(name, { type: 'REG_SZ', data })
    }
    seedLegacyWholeItemEntry()
    const result = restoreLedger(dataDir, build())
    expect(result.failed).toEqual([])
    expect(result.restored).toHaveLength(1)
    expect(environment.size).toBe(0)
  })

  it('旧账本(整项)+外部改掉一个:整项结算语义不变(不误删仍是我们的值);残留由按变量的下一轮连接→断开清干净', () => {
    for (const [name, data] of [
      ['HTTP_PROXY', 'http://127.0.0.1:18080'],
      ['HTTPS_PROXY', 'http://127.0.0.1:18080'],
      ['ALL_PROXY', 'socks5://127.0.0.1:18080'],
      ['NO_PROXY', 'localhost,127.0.0.1,::1']
    ] as const) {
      environment.set(name, { type: 'REG_SZ', data })
    }
    seedLegacyWholeItemEntry()
    // 升级现场:客户改掉 HTTPS_PROXY 后断开——旧整项结算 kept-modified,⛔ 误删仍是我们的三个
    environment.set('HTTPS_PROXY', { type: 'REG_SZ', data: 'http://customer-chosen:9' })
    const first = restoreLedger(dataDir, build())
    expect(first.failed).toEqual([])
    expect(first.keptModified.map((entry) => entry.item)).toEqual(['win-user-environment'])
    expect(environment.get('HTTPS_PROXY')).toEqual({ type: 'REG_SZ', data: 'http://customer-chosen:9' })
    expect(environment.get('HTTP_PROXY')?.data).toBe('http://127.0.0.1:18080')

    // 新版本下一次连接→断开:按变量账目接管,三个残留删净,只剩客户改的那个
    applyTerminal(dataDir, build())
    const second = restoreLedger(dataDir, build())
    expect(second.failed).toEqual([])
    expect(environment.get('HTTPS_PROXY')).toEqual({ type: 'REG_SZ', data: 'http://customer-chosen:9' })
    expect(environment.size).toBe(1)
  })

  it('执行策略零接触:适配器全程只碰 Environment 与 Command Processor 两个键,别的键一概不写(假件见生键即抛)', () => {
    const adapter = build()
    expect(() => applyTerminal(dataDir, adapter)).not.toThrow()
    expect(() => restoreLedger(dataDir, build())).not.toThrow()
    expect(autoRun.exists).toBe(false)
  })
})

describe('OneDrive 接管「文档」时的 profile 落点(收敛包2 件6)', () => {
  let root: string
  let home: string
  let autoRun: AutoRunState
  let environment: Map<string, EnvironmentValue>

  beforeEach(() => {
    root = makeTempDir('laixin-terminal-onedrive-')
    home = join(root, 'home')
    mkdirSync(home, { recursive: true })
    autoRun = { exists: false, type: 'REG_SZ', value: '' }
    environment = new Map()
  })

  afterEach(() => removeTempDir(root))

  function runWithPersonal(personal: string | Error): TerminalRun {
    const registry = fakeRegistry(autoRun, environment)
    return (command, args) => {
      if (command === 'powershell.exe') {
        if (personal instanceof Error) throw personal
        return personal
      }
      return registry(command, args)
    }
  }

  function powershellProfileTargets(adapter: TerminalEnvironmentAdapter) {
    const items = adapter.managedItems(PROXY)
    const find = (item: string) => items.find((managed) => managed.ref.item === item)
    return [find('win-powershell5-profile'), find('win-powershell7-profile')]
  }

  it('注册表 Personal = %USERPROFILE%\\OneDrive\\文档 → profile 落在真实「文档」目录', () => {
    const adapter = createTerminalEnvironmentAdapter({
      enabled: true, home, run: runWithPersonal('%USERPROFILE%\\OneDrive\\文档')
    })
    const [ps5, ps7] = powershellProfileTargets(adapter)
    adapter.write(ps5!.ref, ps5!.value)
    adapter.write(ps7!.ref, ps7!.value)
    expect(existsSync(join(home, 'OneDrive', '文档', 'WindowsPowerShell', 'Microsoft.PowerShell_profile.ps1'))).toBe(true)
    expect(existsSync(join(home, 'OneDrive', '文档', 'PowerShell', 'Microsoft.PowerShell_profile.ps1'))).toBe(true)
    // ⛔ 落在写死的 Documents(OneDrive 接管后那里不是 $PROFILE 的家)
    expect(existsSync(join(home, 'Documents', 'WindowsPowerShell'))).toBe(false)
    // cmd helper / git bash 不受影响,仍在 HOME 根
    const managed = adapter.managedItems(PROXY).map((managed) => managed.ref.item)
    expect(managed).toContain('win-cmd-helper')
    expect(managed).toContain('win-git-bashrc')
  })

  it('注册表 Personal 已展开成绝对路径(含中文目录名)同样命中', () => {
    const redirected = join(home, 'OneDrive', '张三的文档')
    const adapter = createTerminalEnvironmentAdapter({
      enabled: true, home, run: runWithPersonal(redirected)
    })
    const [, ps7] = powershellProfileTargets(adapter)
    adapter.write(ps7!.ref, ps7!.value)
    expect(existsSync(join(redirected, 'PowerShell', 'Microsoft.PowerShell_profile.ps1'))).toBe(true)
  })

  it('注册表读不到 → 回退 Documents;展开后越出 HOME → 同样回退(⛔ 越界写)', () => {
    const fallback = createTerminalEnvironmentAdapter({
      enabled: true, home, run: runWithPersonal(new Error('reg read failed'))
    })
    const [ps5] = powershellProfileTargets(fallback)
    fallback.write(ps5!.ref, ps5!.value)
    expect(existsSync(join(home, 'Documents', 'WindowsPowerShell', 'Microsoft.PowerShell_profile.ps1'))).toBe(true)

    const outside = createTerminalEnvironmentAdapter({
      enabled: true, home, run: runWithPersonal('D:\\Redirected\\Documents')
    })
    const [, ps7] = powershellProfileTargets(outside)
    outside.write(ps7!.ref, ps7!.value)
    expect(existsSync(join(home, 'Documents', 'PowerShell', 'Microsoft.PowerShell_profile.ps1'))).toBe(true)
  })
})
