import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createDaemon, type DaemonState } from '../../sidecar/mac/daemon-core.mjs'
import { appendSettingEntry, loadLedger, type SettingEntry } from '../../sidecar/mac/ledger.mjs'
import { composeManagedAdapters, type ManagedNetworkAdapter } from '../../sidecar/mac/managed-adapter.mjs'
import { restoreLedger } from '../../sidecar/mac/restore.mjs'
import {
  createTerminalEnvironmentAdapter,
  type TerminalEnvironmentAdapter,
  type TerminalProxy
} from '../../sidecar/mac/terminal-environment.mjs'
import { FakeClock, flushMicrotasks, makeTempDir, readJsonFile, removeTempDir, waitFor, writeIntentFile } from './helpers'

const PROXY: TerminalProxy = { host: '127.0.0.1', port: 18080 }
const EXIT_IP = '203.0.113.33'

function terminalItems(adapter: TerminalEnvironmentAdapter) {
  return adapter.managedItems(PROXY)
}

function applyTerminal(dataDir: string, adapter: TerminalEnvironmentAdapter): void {
  for (const item of terminalItems(adapter)) {
    appendSettingEntry(dataDir, {
      service: item.ref.service,
      item: item.ref.item,
      originalValue: adapter.read(item.ref),
      writtenValue: item.value,
      sessionToken: 'terminal-test',
      time: 1
    })
    adapter.write(item.ref, item.value)
  }
}

function settingEntries(dataDir: string): SettingEntry[] {
  return loadLedger(dataDir).filter((entry): entry is SettingEntry => entry.kind === 'setting')
}

describe('macOS 终端自动接入', () => {
  let root: string
  let home: string
  let dataDir: string

  beforeEach(() => {
    root = makeTempDir('laixin-terminal-mac-')
    home = join(root, 'home')
    dataDir = join(root, 'data')
    mkdirSync(home, { recursive: true })
    mkdirSync(dataDir, { recursive: true })
  })

  afterEach(() => {
    removeTempDir(root)
  })

  it('连接写受管 hook；新实例恢复时保留客户内容且账本不含客户 profile 秘密', () => {
    const profile = join(home, '.zshenv')
    const secret = 'customer-token-do-not-store'
    writeFileSync(profile, "export CUSTOMER_TOKEN='customer-token-do-not-store'\n")

    const connecting = createTerminalEnvironmentAdapter({ enabled: true, home })
    applyTerminal(dataDir, connecting)

    const helper = readFileSync(join(home, '.laixin-ai-toolbox', 'terminal-proxy.sh'), 'utf8')
    expect(helper).toContain('HTTP_PROXY')
    expect(helper).toContain('http://127.0.0.1:18080')
    expect(helper).toContain('ALL_PROXY')
    expect(helper).toContain('NO_PROXY')
    expect(readFileSync(profile, 'utf8')).toContain('LAIXIN_AI_TOOLBOX_TERMINAL_V1:mac-zshenv')
    expect(readFileSync(join(home, '.config', 'fish', 'conf.d', 'laixin-ai-toolbox.fish'), 'utf8')).toContain('source')

    const ledgerSource = readFileSync(join(dataDir, 'ledger.json'), 'utf8')
    expect(ledgerSource).not.toContain(secret)
    expect(ledgerSource).not.toContain('CUSTOMER_TOKEN')

    appendFileSync(profile, 'export CUSTOMER_CHANGE=keep\n')
    const recovering = createTerminalEnvironmentAdapter({ enabled: true, home })
    const result = restoreLedger(dataDir, recovering)

    expect(result.failed).toEqual([])
    expect(result.keptModified).toEqual([])
    expect(result.restored).toHaveLength(7)
    expect(readFileSync(profile, 'utf8')).toContain("export CUSTOMER_TOKEN='customer-token-do-not-store'")
    expect(readFileSync(profile, 'utf8')).toContain('export CUSTOMER_CHANGE=keep')
    expect(readFileSync(profile, 'utf8')).not.toContain('LAIXIN_AI_TOOLBOX_TERMINAL_V1')
    expect(existsSync(join(home, '.laixin-ai-toolbox', 'terminal-proxy.sh'))).toBe(false)
    expect(existsSync(join(home, '.laixin-ai-toolbox', 'terminal-proxy.fish'))).toBe(false)
    expect(existsSync(join(home, '.bashrc'))).toBe(false)
    expect(settingEntries(dataDir).every((entry) => entry.status === 'restored')).toBe(true)
  })

  it('有工具箱标记但内容被改过时，恢复保留客户当前内容并明确未恢复', () => {
    const adapter = createTerminalEnvironmentAdapter({ enabled: true, home })
    applyTerminal(dataDir, adapter)
    const helper = join(home, '.laixin-ai-toolbox', 'terminal-proxy.sh')
    appendFileSync(helper, '# customer changed file while connected\n')
    const source = readFileSync(helper, 'utf8').replace('HTTP_PROXY', 'CUSTOMER_HTTP_PROXY')
    writeFileSync(helper, source)

    const result = restoreLedger(dataDir, createTerminalEnvironmentAdapter({ enabled: true, home }))

    expect(result.restored).toHaveLength(6)
    expect(result.keptModified).toHaveLength(1)
    expect(readFileSync(helper, 'utf8')).toContain('CUSTOMER_HTTP_PROXY')
    expect(settingEntries(dataDir).find((entry) => entry.item === 'mac-sh-helper')?.status).toBe('kept-modified')
  })

  it('符号链接 profile 受控拒绝，不跟随也不替换客户文件', () => {
    const source = join(root, 'dotfiles-zshenv')
    const profile = join(home, '.zshenv')
    writeFileSync(source, 'export DOTFILES=keep\n')
    symlinkSync(source, profile)
    const adapter = createTerminalEnvironmentAdapter({ enabled: true, home })
    const zsh = terminalItems(adapter).find((item) => item.ref.item === 'mac-zshenv')
    if (zsh === undefined) throw new Error('MISSING_ZSH_ITEM')

    expect(() => adapter.preflight(PROXY)).toThrowError(/TERMINAL_ENVIRONMENT_PROFILE_UNSAFE/)
    expect(() => adapter.read(zsh.ref)).toThrowError(/TERMINAL_ENVIRONMENT_PROFILE_UNSAFE/)
    expect(readFileSync(source, 'utf8')).toBe('export DOTFILES=keep\n')
  })

  it('符号链接父目录同样受控拒绝，不在外部配置目录创建 hook', () => {
    const source = join(root, 'customer-config')
    mkdirSync(source)
    symlinkSync(source, join(home, '.config'))
    const adapter = createTerminalEnvironmentAdapter({ enabled: true, home })

    expect(() => adapter.preflight(PROXY)).toThrowError(/TERMINAL_ENVIRONMENT_PROFILE_UNSAFE/)
    expect(existsSync(join(source, 'fish', 'conf.d', 'laixin-ai-toolbox.fish'))).toBe(false)
  })

  it('复合适配器把固定终端配置异常当可选项跳过:预检不抛、只记一句说明、客户文件不动(发布审查 R2:⛔ 挡网络)', () => {
    const source = join(root, 'dotfiles-zshenv')
    const profile = join(home, '.zshenv')
    writeFileSync(source, 'export DOTFILES=keep\n')
    symlinkSync(source, profile)
    const terminal = createTerminalEnvironmentAdapter({ enabled: true, home })
    const network: ManagedNetworkAdapter = {
      managedItems: () => [],
      read: () => null,
      write: () => undefined
    }
    const adapter = composeManagedAdapters(network, terminal)

    expect(() => adapter.preflight?.(PROXY)).not.toThrow()
    expect(adapter.optionalNote?.()).toContain('终端自动接入这次没启用')
    expect(adapter.managedItems(PROXY)).toEqual([])
    expect(readFileSync(source, 'utf8')).toBe('export DOTFILES=keep\n')
  })

  it('默认关闭，测试或意外启动不会触客户目录；非法代理也受控拒绝', () => {
    const guarded = createTerminalEnvironmentAdapter({ home })
    expect(guarded.managedItems(PROXY)).toEqual([])
    expect(existsSync(join(home, '.zshenv'))).toBe(false)

    const adapter = createTerminalEnvironmentAdapter({ enabled: true, home })
    const invalid = { host: '127.0.0.1', port: 0 } as unknown as TerminalProxy
    expect(() => adapter.managedItems(invalid)).toThrowError(/TERMINAL_ENVIRONMENT_PROXY_INVALID/)
  })

  it('只在桥和出口复验成功后才写终端 hook；主动断开统一恢复', async () => {
    let networkValue: unknown = null
    const networkAdapter: ManagedNetworkAdapter = {
      managedItems: () => [{ ref: { service: 'test', item: 'proxy' }, value: true }],
      read: () => networkValue,
      write: (_ref, value) => { networkValue = value }
    }
    const terminal = createTerminalEnvironmentAdapter({ enabled: true, home })
    const adapter = composeManagedAdapters(networkAdapter, terminal)
    const clock = new FakeClock()
    writeIntentFile(dataDir, {
      desired: 'connected',
      sessionToken: 'terminal-daemon',
      bridgePort: PROXY.port,
      connector: { kind: 'loopback-probe', host: '127.0.0.1', port: 1, exitIp: EXIT_IP }
    })
    const daemon = createDaemon({
      dataDir,
      clock,
      adapter,
      connectorFactory: () => ({
        kind: 'loopback-probe',
        start: async () => undefined,
        stop: async () => undefined,
        localProxyPort: () => 1,
        onLost: () => undefined,
        verify: async () => ({ exitIp: EXIT_IP })
      }),
      bridgeFactory: () => ({ listen: async () => undefined, close: async () => undefined }),
      parentAlive: () => true,
      onExit: () => undefined,
      intentPollMs: 50,
      parentPollMs: 50,
      verifyIntervalMs: 5_000
    })

    await daemon.run()
    expect(readJsonFile<DaemonState>(join(dataDir, 'state.json')).state).toBe('connected')
    expect(networkValue).toBe(true)
    expect(existsSync(join(home, '.zshenv'))).toBe(true)
    expect(settingEntries(dataDir)).toHaveLength(8)

    appendFileSync(join(home, '.zshenv'), 'export AFTER_CONNECT=keep\n')
    writeIntentFile(dataDir, { desired: 'user-disconnected', sessionToken: 'terminal-stop' })
    clock.advance(50)
    await waitFor(() => readJsonFile<DaemonState>(join(dataDir, 'state.json')).state === 'stopped-restored')
    await flushMicrotasks()

    expect(networkValue).toBeNull()
    expect(readFileSync(join(home, '.zshenv'), 'utf8')).toContain('export AFTER_CONNECT=keep')
    expect(readFileSync(join(home, '.zshenv'), 'utf8')).not.toContain('LAIXIN_AI_TOOLBOX_TERMINAL_V1')
    expect(settingEntries(dataDir).every((entry) => entry.status === 'restored')).toBe(true)
    daemon.requestShutdown()
  })

  it('桥启动失败时不写入任何终端 profile', async () => {
    const terminal = createTerminalEnvironmentAdapter({ enabled: true, home })
    const clock = new FakeClock()
    writeIntentFile(dataDir, {
      desired: 'connected',
      sessionToken: 'terminal-verify-failure',
      bridgePort: PROXY.port,
      connector: { kind: 'loopback-probe', host: '127.0.0.1', port: 1, exitIp: EXIT_IP }
    })
    const daemon = createDaemon({
      dataDir,
      clock,
      adapter: composeManagedAdapters({
        managedItems: () => [{ ref: { service: 'test', item: 'proxy' }, value: true }],
        read: () => null,
        write: () => undefined
      }, terminal),
      connectorFactory: () => ({
        kind: 'loopback-probe',
        start: async () => undefined,
        stop: async () => undefined,
        localProxyPort: () => 1,
        onLost: () => undefined,
        verify: async () => ({ exitIp: EXIT_IP })
      }),
      bridgeFactory: () => ({
        listen: async () => { throw new Error('BRIDGE_UNAVAILABLE') },
        close: async () => undefined
      }),
      parentAlive: () => true,
      onExit: () => undefined
    })

    await daemon.run()

    expect(settingEntries(dataDir)).toHaveLength(0)
    expect(existsSync(join(home, '.zshenv'))).toBe(false)
    daemon.requestShutdown()
  })
})
