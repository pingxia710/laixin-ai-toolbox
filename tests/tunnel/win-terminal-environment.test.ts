import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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

interface AutoRunState {
  exists: boolean
  type: 'REG_SZ' | 'REG_EXPAND_SZ'
  value: string
}

function fakeRegistry(state: AutoRunState): TerminalRun {
  return (command, args) => {
    if (command !== 'reg.exe') throw new Error('UNEXPECTED_COMMAND')
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

  beforeEach(() => {
    root = makeTempDir('laixin-terminal-win-')
    home = join(root, 'home')
    dataDir = join(root, 'data')
    mkdirSync(home, { recursive: true })
    mkdirSync(dataDir, { recursive: true })
    autoRun = { exists: true, type: 'REG_EXPAND_SZ', value: 'echo CUSTOMER_AUTORUN_SECRET' }
  })

  afterEach(() => {
    removeTempDir(root)
  })

  it('写入标准 Windows shell 接入；跨实例恢复保留 profile/AutoRun 的客户内容且账本不泄露原文', () => {
    const profile = join(home, 'Documents', 'PowerShell', 'Microsoft.PowerShell_profile.ps1')
    mkdirSync(join(home, 'Documents', 'PowerShell'), { recursive: true })
    writeFileSync(profile, "Write-Output 'CUSTOMER_PROFILE_SECRET'\r\n")
    const connecting = createTerminalEnvironmentAdapter({ enabled: true, home, run: fakeRegistry(autoRun) })
    applyTerminal(dataDir, connecting)

    const items = connecting.managedItems(PROXY)
    const cmdHelper = items.find((item) => item.ref.item === 'win-cmd-helper')
    const autoRunItem = items.find((item) => item.ref.item === 'win-cmd-autorun')
    if (cmdHelper === undefined || autoRunItem === undefined) throw new Error('WINDOWS_TERMINAL_ITEMS_MISSING')
    expect(connecting.valuesEqual(connecting.read(cmdHelper.ref), cmdHelper.value)).toBe(true)
    expect(connecting.valuesEqual(connecting.read(autoRunItem.ref), autoRunItem.value)).toBe(true)
    const cmdSource = readFileSync(join(home, '.laixin-ai-toolbox', 'terminal-proxy.cmd'), 'utf8')
    expect(cmdSource).toContain('@set "HTTP_PROXY=http://127.0.0.1:18080"')
    expect(cmdSource).toContain('rem LAIXIN_AI_TOOLBOX_TERMINAL_V1:win-cmd-helper BEGIN')
    expect(cmdSource).not.toMatch(/[<>]/)
    expect(readFileSync(profile, 'utf8')).toContain('$env:HTTP_PROXY')
    expect(autoRun.value).toContain('call "%USERPROFILE%\\.laixin-ai-toolbox\\terminal-proxy.cmd"')
    expect(autoRun.value).toContain('rem LAIXIN_AI_TOOLBOX_TERMINAL_V1:win-cmd-autorun BEGIN')
    expect(autoRun.value).not.toMatch(/[<>]/)

    const ledgerSource = readFileSync(join(dataDir, 'ledger.json'), 'utf8')
    expect(ledgerSource).not.toContain('CUSTOMER_AUTORUN_SECRET')
    expect(ledgerSource).not.toContain('CUSTOMER_PROFILE_SECRET')

    appendFileSync(profile, "Write-Output 'CUSTOMER_AFTER_CONNECT'\r\n")
    autoRun.value += ' & echo CUSTOMER_AUTORUN_AFTER_CONNECT'
    const recovering = createTerminalEnvironmentAdapter({ enabled: true, home, run: fakeRegistry(autoRun) })
    const result = restoreLedger(dataDir, recovering)

    expect(result.failed).toEqual([])
    expect(result.keptModified).toEqual([])
    expect(result.restored).toHaveLength(6)
    expect(readFileSync(profile, 'utf8')).toContain('CUSTOMER_PROFILE_SECRET')
    expect(readFileSync(profile, 'utf8')).toContain('CUSTOMER_AFTER_CONNECT')
    expect(readFileSync(profile, 'utf8')).not.toContain('LAIXIN_AI_TOOLBOX_TERMINAL_V1')
    expect(autoRun).toEqual({
      exists: true,
      type: 'REG_EXPAND_SZ',
      value: 'echo CUSTOMER_AUTORUN_SECRET & echo CUSTOMER_AUTORUN_AFTER_CONNECT'
    })
    expect(existsSync(join(home, '.laixin-ai-toolbox', 'terminal-proxy.cmd'))).toBe(false)
    expect(settingEntries(dataDir).every((entry) => entry.status === 'restored')).toBe(true)
  })

  it('符号链接 profile 受控拒绝，不跟随客户 dotfiles', () => {
    const source = join(root, 'customer-profile.ps1')
    const profile = join(home, 'Documents', 'WindowsPowerShell', 'Microsoft.PowerShell_profile.ps1')
    mkdirSync(join(home, 'Documents', 'WindowsPowerShell'), { recursive: true })
    writeFileSync(source, "Write-Output 'KEEP'\r\n")
    symlinkSync(source, profile)
    const adapter = createTerminalEnvironmentAdapter({ enabled: true, home, run: fakeRegistry(autoRun) })
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
    const adapter = createTerminalEnvironmentAdapter({ enabled: true, home, run: fakeRegistry(autoRun) })

    expect(() => adapter.preflight(PROXY)).toThrowError(/TERMINAL_ENVIRONMENT_PROFILE_UNSAFE/)
    expect(existsSync(join(source, 'WindowsPowerShell', 'Microsoft.PowerShell_profile.ps1'))).toBe(false)
  })

  it('复合适配器把固定终端配置异常当可选项跳过:预检不抛、只记一句说明、客户文件不动(发布审查 R2:⛔ 挡网络)', () => {
    const source = join(root, 'customer-profile.ps1')
    const profile = join(home, 'Documents', 'WindowsPowerShell', 'Microsoft.PowerShell_profile.ps1')
    mkdirSync(join(home, 'Documents', 'WindowsPowerShell'), { recursive: true })
    writeFileSync(source, "Write-Output 'KEEP'\r\n")
    symlinkSync(source, profile)
    const terminal = createTerminalEnvironmentAdapter({ enabled: true, home, run: fakeRegistry(autoRun) })
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
    const guarded = createTerminalEnvironmentAdapter({ home, run: fakeRegistry(autoRun) })
    expect(guarded.managedItems(PROXY)).toEqual([])
    expect(autoRun.value).toBe('echo CUSTOMER_AUTORUN_SECRET')
    expect(existsSync(join(home, '.laixin-ai-toolbox', 'terminal-proxy.cmd'))).toBe(false)

    const adapter = createTerminalEnvironmentAdapter({ enabled: true, home, run: fakeRegistry(autoRun) })
    const invalid = { host: '127.0.0.1', port: 0 } as unknown as TerminalProxy
    expect(() => adapter.managedItems(invalid)).toThrowError(/TERMINAL_ENVIRONMENT_PROXY_INVALID/)
  })
})

describe('OneDrive 接管「文档」时的 profile 落点(收敛包2 件6)', () => {
  let root: string
  let home: string
  let autoRun: AutoRunState

  beforeEach(() => {
    root = makeTempDir('laixin-terminal-onedrive-')
    home = join(root, 'home')
    mkdirSync(home, { recursive: true })
    autoRun = { exists: false, type: 'REG_SZ', value: '' }
  })

  afterEach(() => removeTempDir(root))

  function runWithPersonal(personal: string | Error): TerminalRun {
    const registry = fakeRegistry(autoRun)
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
