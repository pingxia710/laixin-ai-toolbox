import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { BridgeRegistry } from '../../app/main/bridge/bridge-registry'
import { registerActions } from '../../app/main/actions/official-account'
import { AiAccessService } from '../../app/main/ai-access/service'
import { createDeepSeekAdapters, observedConfigurationExecution } from '../../app/main/ai-access/adapters'
import { createConfigurationExecutionObserver } from '../../app/main/ai-access/configuration-execution-observer'
import { createManagedTextFile } from '../../app/main/ai-access/file'
import { codexAccountKey } from '../../app/main/codex-usage/normalize'
import type { OfficialAccount } from '../../app/shared/official-account'
import type { CodexCommand } from '../../app/main/codex-usage/runtime'
import type * as InventoryModule from '../../app/main/shells/inventory'
import type * as OfficialAccountModule from '../../app/main/ai-access/official-account'

const runtime = vi.hoisted(() => ({
  home: '', environment: {} as NodeJS.ProcessEnv,
  access: undefined as Pick<AiAccessService, 'codexOfficialLoginRoot'> | undefined,
  key: vi.fn<() => Promise<string | null>>(),
  executables: vi.fn(async () => ['/fixture/codex']),
  readCodex: vi.fn<(commands: readonly CodexCommand[] | null, cwd: string, env?: NodeJS.ProcessEnv) => void>(),
  readClaude: vi.fn<(executable: string | null, cwd: string, env: NodeJS.ProcessEnv) => Promise<OfficialAccount>>()
}))
vi.mock('electron', () => ({ app: { getPath: () => runtime.home } }))
vi.mock('../../app/main/actions/ai-access', () => ({ productionAiAccessService: () => runtime.access }))
vi.mock('../../app/main/ai-access/added-accounts', () => ({ sharedAddedOfficialAccounts: () => ({ key: runtime.key }) }))
vi.mock('../../app/main/shells/context', () => ({ shellInventory: () => ({ environment: () => runtime.environment }) }))
vi.mock('../../app/main/shells/inventory', async importOriginal => ({
  ...await importOriginal<typeof InventoryModule>(),
  trustedCliExecutables: runtime.executables,
  trustedCliExecutable: async () => '/fixture/claude'
}))
vi.mock('../../app/main/ai-access/official-account', async importOriginal => {
  const actual = await importOriginal<typeof OfficialAccountModule>()
  return {
    ...actual,
    readClaudeOfficialAccount: runtime.readClaude,
    readCodexOfficialAccount: (commands: readonly CodexCommand[] | null, cwd: string, env?: NodeJS.ProcessEnv) => {
      runtime.readCodex(commands, cwd, env)
      // Replace only the installed executable with the local protocol fixture; retain the
      // production reader, subprocess environment, identity normalization, and bridge gate.
      return actual.readCodexOfficialAccount([
        { executable: process.execPath, args: [resolve('tests/ai-access/fixtures/codex-account-root-server.mjs'), cwd] }
      ], cwd, env)
    }
  }
})

const customIdentity = { type: 'chatgpt', email: 'custom@example.test', planType: 'plus' }
const defaultIdentity = { type: 'chatgpt', email: 'default@example.test', planType: 'pro' }
const readSnapshot = async (shell = 'codex'): Promise<OfficialAccount> => {
  const registry = new BridgeRegistry()
  registerActions(registry)
  return JSON.parse(((await registry.execute('officialaccount.read', { shell })) as { snapshot: string }).snapshot) as OfficialAccount
}

async function setupRoot(source: 'startup' | 'environment' | 'default'): Promise<string> {
  const custom = join(runtime.home, 'custom codex')
  const standard = join(runtime.home, '.codex')
  for (const [directory, identity] of [[custom, customIdentity], [standard, defaultIdentity]] as const) {
    await mkdir(directory)
    await writeFile(join(directory, 'auth.json'), JSON.stringify(identity))
  }
  if (source === 'startup') await writeFile(join(runtime.home, '.zshenv'), `export CODEX_HOME="${custom}"\n`)
  if (source === 'environment') runtime.environment.CODEX_HOME = custom
  const observer = createConfigurationExecutionObserver({
    platform: 'darwin', home: runtime.home, policyFilePresence: async () => 'absent', run: async () => ''
  })
  const access = new AiAccessService(
    { read: async () => ({ version: 1, selected: {} }), write: async () => { throw new Error('unexpected state write') } },
    createDeepSeekAdapters({
      home: runtime.home, platform: 'darwin', file: createManagedTextFile(),
      configurationExecution: observedConfigurationExecution(runtime.home, 'darwin', runtime.environment),
      observeConfigurationExecution: observer
    })
  )
  runtime.access = access
  vi.spyOn(access, 'codexOfficialLoginRoot')
  runtime.key.mockResolvedValue(codexAccountKey(source === 'default' ? defaultIdentity : customIdentity))
  return source === 'default' ? standard : custom
}

// Finder/startup-file coverage uses POSIX paths; it is not a Windows native acceptance claim.
describe.skipIf(process.platform === 'win32')('Codex 官方账号卡片使用登录同一配置目录', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    runtime.home = await mkdtemp(join(tmpdir(), 'official-account-root-'))
    runtime.environment = { OFFICIAL_ACCOUNT_FIXTURE_BASE: runtime.home }
    runtime.access = undefined
  })
  afterEach(async () => { await rm(runtime.home, { recursive: true, force: true }) })

  it.each(['startup', 'environment', 'default'] as const)('%s 根经真实目录解析后传给身份读取，不误读另一个目录', async source => {
    const root = await setupRoot(source)
    const initialAuth = await readFile(join(root, 'auth.json'), 'utf8')
    const account = await readSnapshot()
    expect(account).toEqual({
      state: 'signed-in', accountKey: codexAccountKey(source === 'default' ? defaultIdentity : customIdentity),
      accountLabel: source === 'default' ? 'de***@example.test' : 'cu***@example.test',
      plan: source === 'default' ? 'pro' : 'plus'
    })
    expect(runtime.access!.codexOfficialLoginRoot).toHaveBeenCalledTimes(1)
    expect(runtime.readCodex).toHaveBeenCalledWith(
      [{ executable: '/fixture/codex', args: ['app-server', '--listen', 'stdio://'] }], runtime.home,
      { ...runtime.environment, CODEX_HOME: root }
    )
    expect(runtime.executables).toHaveBeenCalledWith('codex', process.platform, runtime.home, { ...runtime.environment, CODEX_HOME: root })
    expect(await readFile(join(root, 'auth.json'), 'utf8')).toBe(initialAuth)
    expect(JSON.stringify(account)).not.toContain(runtime.home)
  })

  it('没有添加账号时，仍然不解析配置目录或读取账号', async () => {
    await setupRoot('startup')
    runtime.key.mockResolvedValue(null)
    expect(await readSnapshot()).toEqual({ state: 'signed-out', accountLabel: null, plan: null })
    expect(runtime.access!.codexOfficialLoginRoot).not.toHaveBeenCalled()
    expect(runtime.readCodex).not.toHaveBeenCalled()
    expect(runtime.executables).not.toHaveBeenCalled()
  })

  it('配置根无法确认时不猜默认目录或启动账号读取', async () => {
    await setupRoot('startup')
    await writeFile(join(runtime.home, '.zshenv'), 'export CODEX_HOME="$DYNAMIC_ROOT"\n')
    await expect(readSnapshot()).rejects.toMatchObject({ code: 'ACTION_FAILED' })
    expect(runtime.readCodex).not.toHaveBeenCalled()
    expect(runtime.executables).not.toHaveBeenCalled()
  })

  it('Claude 原有身份读取环境不变，也不调用 Codex 取根', async () => {
    await setupRoot('startup')
    const account: OfficialAccount = { state: 'signed-in', accountKey: codexAccountKey(customIdentity), accountLabel: 'cu***@example.test', plan: 'max' }
    runtime.readClaude.mockResolvedValue(account)
    expect(await readSnapshot('claude')).toEqual(account)
    expect(runtime.readClaude).toHaveBeenCalledWith('/fixture/claude', runtime.home, runtime.environment)
    expect(runtime.access!.codexOfficialLoginRoot).not.toHaveBeenCalled()
    expect(runtime.readCodex).not.toHaveBeenCalled()
  })
})
