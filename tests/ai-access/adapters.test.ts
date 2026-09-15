import { access, chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createDeepSeekAdapters, observedConfigurationExecution, type HermesModelKey } from '../../app/main/ai-access/adapters'
import type { ManagedTextFile } from '../../app/main/ai-access/deepseek-config'
import { createProjectConfigurationTargetStore } from '../../app/main/ai-access/configuration-target'
import type { AiGateway, GatewayRoute } from '../../app/main/ai-access/gateway'
import { AiAccessService, type AiAccessState } from '../../app/main/ai-access/service'
import { trustedHermesCommandCandidates } from '../../app/main/shells/inventory'

function files() {
  const data = new Map<string, string>()
  const io: ManagedTextFile = {
    read: async (path) => data.get(path),
    write: async (path, contents) => { data.set(path, contents) },
    remove: async (path) => { data.delete(path) },
    withConfigWriteLock: async (_lockPath, task) => task()
  }
  return { io, data }
}

function officialHermesConsoleScript(): string {
  return [
    '#!/bin/sh',
    `'''exec' "$(dirname -- "$(realpath -- "$0")")"/'python3' "$0" "$@"`,
    "' '''",
    '# -*- coding: utf-8 -*-',
    'import sys',
    'from hermes_cli.main import main',
    'if __name__ == "__main__":',
    '    if sys.argv[0].endswith("-script.pyw"):',
    '        sys.argv[0] = sys.argv[0][:-11]',
    '    elif sys.argv[0].endswith(".exe"):',
    '        sys.argv[0] = sys.argv[0][:-4]',
    '    sys.exit(main())',
    ''
  ].join('\n')
}

/**
 * The restart tests exercise service state and shell-file behavior. A structural gateway keeps
 * them deterministic: the sandbox need not grant a listener merely to prove target selection.
 */
function acceptingGateway(options: { readonly failFixedPort?: boolean; readonly allocatedPort?: number } = {}): AiGateway {
  let running = false
  let routes: readonly GatewayRoute[] = []
  const gateway = {
    baseUrl: null as string | null,
    async start(port: number): Promise<number> {
      if (options.failFixedPort && port !== 0) throw new Error('fixture port is occupied')
      const allocated = port || options.allocatedPort || 19_361
      gateway.baseUrl = `http://127.0.0.1:${String(allocated)}`
      running = true
      return allocated
    },
    async stop(): Promise<void> {
      running = false
      gateway.baseUrl = null
      routes = []
    },
    setRoutes(next: readonly GatewayRoute[]): void { routes = next },
    snapshot() {
      return {
        running,
        baseUrl: gateway.baseUrl,
        startedAt: running ? '2026-09-13T00:00:00.000Z' : null,
        requests: [],
        routes: routes.map(route => ({
          shell: route.shell,
          provider: route.provider,
          model: route.model,
          baseUrl: `${gateway.baseUrl}/${route.shell}/${route.provider}${route.shell === 'claude' ? '' : '/v1'}`,
          upstream: route.endpoint
        }))
      }
    },
    clientAcceptances: () => ({}),
    onClientFailure(): void {},
    async probe(): Promise<{ ok: true }> { return { ok: true } }
  }
  return gateway as unknown as AiGateway
}

describe('三个壳的 DeepSeek 适配器', () => {
  it('接管前核对要读得出客户现在配的接口地址：codex 读 TOML、claude 读 settings 的 env', async () => {
    const f = files()
    f.data.set('/customer/.codex/config.toml', 'model = "gpt-5"\nmodel_provider = "ccswitch"\n\n[model_providers.ccswitch]\nbase_url = "http://127.0.0.1:57548/v1"\n')
    f.data.set('/customer/.claude/settings.json', JSON.stringify({
      env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:57547', ANTHROPIC_AUTH_TOKEN: 'sk-ccswitch-leftover-0123456789' }
    }))
    const adapters = createDeepSeekAdapters({ home: '/customer', platform: 'darwin', file: f.io })
    const codex = adapters.find(adapter => adapter.shell === 'codex')!
    const claude = adapters.find(adapter => adapter.shell === 'claude')!
    await expect(codex.readCurrentBaseUrl!()).resolves.toBe('http://127.0.0.1:57548/v1')
    await expect(claude.readCurrentBaseUrl!()).resolves.toBe('http://127.0.0.1:57547')
    // 读不出（配置坏掉 / 没有第三方地址）就返回 undefined，⛔ 让核对整个报错。
    f.data.set('/customer/.claude/settings.json', '{ 这不是 JSON')
    await expect(claude.readCurrentBaseUrl!()).resolves.toBeUndefined()
    f.data.set('/customer/.codex/config.toml', 'model = "gpt-5"\n')
    await expect(codex.readCurrentBaseUrl!()).resolves.toBeUndefined()
  })

  it('Codex 项目配置只作诊断，所有 provider 路由都写入用户级 config.toml', async () => {
    const f = files()
    const projectPath = '/customer/project/.codex/config.toml'
    const projectContents = 'model = "cc-switch"\n'
    f.data.set(projectPath, projectContents)
    const codex = createDeepSeekAdapters({
      home: '/customer', projectDir: '/customer/project', platform: 'darwin', file: f.io
    }).find((adapter) => adapter.shell === 'codex')!

    await expect(codex.configurationTargetStatus!()).resolves.toMatchObject({
      scope: 'user', override: 'none', writable: true, reason: 'project-configuration-ignored'
    })
    expect(codex.selectConfigurationTarget).toBeUndefined()
    expect(codex.selectConfigurationProject).toBeUndefined()
    await codex.applyDeepSeek('sk-toolbox-fixture-key-1234567890')

    expect(f.data.get('/customer/.codex/config.toml')).toContain('model_provider = "laixin-deepseek"')
    expect(f.data.get(projectPath)).toBe(projectContents)
  })

  it('历史 Codex 私有项目选择在适配器重建后被忽略，仍读取和写入用户级配置', async () => {
    const f = files()
    const projectDirectory = '/customer/project'
    const projectPath = `${projectDirectory}/.codex/config.toml`
    const privateTargets = createProjectConfigurationTargetStore(f.io, '/toolbox/private-project-targets.json', 'darwin')
    const projectContents = 'model = "cc-switch"\n'
    f.data.set(projectPath, projectContents)
    f.data.set('/toolbox/private-project-targets.json', JSON.stringify({ version: 1, directories: { codex: projectDirectory } }))
    const selectedProjectDirectory = vi.spyOn(privateTargets, 'selectedProjectDirectory')
    const first = createDeepSeekAdapters({
      home: '/customer', platform: 'darwin', file: f.io, projectTargetStore: privateTargets
    }).find((adapter) => adapter.shell === 'codex')!

    await first.applyDeepSeek('sk-toolbox-fixture-key-1234567890')
    const expected = await first.readManagedFingerprint!()
    expect(selectedProjectDirectory).not.toHaveBeenCalled()
    expect(f.data.get(projectPath)).toBe(projectContents)

    const restarted = createDeepSeekAdapters({
      home: '/customer', platform: 'darwin', file: f.io, projectTargetStore: privateTargets
    }).find((adapter) => adapter.shell === 'codex')!
    expect(await restarted.readManagedFingerprint!()).toBe(expected)
    const evidence = await restarted.configurationTargetStatus!()
    expect(evidence).toMatchObject({ scope: 'user', override: 'none', writable: true })
    expect(JSON.stringify(evidence)).not.toContain(projectDirectory)
  })

  it('Codex 服务重启会自动迁移历史项目 scope，并继续读取用户级指纹', async () => {
    const f = files()
    const projectDirectory = '/customer/project'
    const projectPath = `${projectDirectory}/.codex/config.toml`
    const projectContents = 'approval_policy = "on-request"\n'
    const targetStore = createProjectConfigurationTargetStore(f.io, '/toolbox/private-project-targets.json', 'darwin')
    f.data.set(projectPath, projectContents)
    f.data.set('/toolbox/private-project-targets.json', JSON.stringify({ version: 1, directories: { codex: projectDirectory } }))
    let state: AiAccessState = { version: 1, selected: {} }
    const store = { read: async () => state, write: async (next: AiAccessState) => { state = next } }
    const first = new AiAccessService(store, createDeepSeekAdapters({
      home: '/customer', platform: 'darwin', file: f.io, projectTargetStore: targetStore
    }), acceptingGateway())

    await first.saveProviderKey('codex', 'deepseek', 'sk-toolbox-fixture-key-1234567890')
    const firstStatus = await first.useProvider('codex', 'deepseek')
    expect(firstStatus).toMatchObject({ attempt: { ok: true } })
    await first.stop()
    state = { ...state, configurationTargetScopes: { codex: 'project' } }

    const restarted = new AiAccessService(store, createDeepSeekAdapters({
      home: '/customer', platform: 'darwin', file: f.io, projectTargetStore: targetStore
    }), acceptingGateway())
    await restarted.initialize()
    const recovered = await restarted.recoverAccess('startup')
    const status = await restarted.status()

    expect(recovered).toMatchObject({ outcome: 'ok', configurations: { codex: 'ok' } })
    expect(status.configurationTargets?.codex).toMatchObject({ scope: 'user', override: 'none', writable: true })
    expect(state.configurationTargetScopes?.codex).toBeUndefined()
    expect(JSON.stringify({ recovered, status, state })).not.toContain(projectDirectory)
    expect(f.data.get('/customer/.codex/config.toml')).toContain('model_provider = "laixin-deepseek-local"')
    expect(f.data.get(projectPath)).toBe(projectContents)
    await restarted.stop()
  })

  it('Codex 重启端口回写只更新用户级配置，项目文件和历史 project scope 都不生效', async () => {
    const f = files()
    const projectDirectory = '/customer/project'
    const projectPath = `${projectDirectory}/.codex/config.toml`
    const projectContents = 'approval_policy = "on-request"\n'
    const targetStore = createProjectConfigurationTargetStore(f.io, '/toolbox/private-project-targets.json', 'darwin')
    f.data.set(projectPath, projectContents)
    f.data.set('/toolbox/private-project-targets.json', JSON.stringify({ version: 1, directories: { codex: projectDirectory } }))
    let state: AiAccessState = { version: 1, selected: {} }
    const store = { read: async () => state, write: async (next: AiAccessState) => { state = next } }
    const first = new AiAccessService(store, createDeepSeekAdapters({
      home: '/customer', platform: 'darwin', file: f.io, projectTargetStore: targetStore
    }), acceptingGateway({ allocatedPort: 19_361 }))

    await first.saveProviderKey('codex', 'deepseek', 'sk-toolbox-fixture-key-1234567890')
    expect((await first.useProvider('codex', 'deepseek')).attempt).toMatchObject({ ok: true })
    await first.stop()
    state = { ...state, configurationTargetScopes: { codex: 'project' } }

    const restarted = new AiAccessService(store, createDeepSeekAdapters({
      home: '/customer', platform: 'darwin', file: f.io, projectTargetStore: targetStore
    }), acceptingGateway({ failFixedPort: true, allocatedPort: 19_444 }))
    await restarted.initialize()
    const recovered = await restarted.recoverAccess('periodic')
    const status = await restarted.status()

    expect(recovered).toMatchObject({ outcome: 'repaired', rewroteShells: ['codex'], configurations: { codex: 'ok' } })
    expect(f.data.get('/customer/.codex/config.toml')).toContain('127.0.0.1:19444/codex/deepseek/v1')
    expect(f.data.get(projectPath)).toBe(projectContents)
    expect(state.pendingShells).toEqual([])
    expect(state.configurationTargetScopes?.codex).toBeUndefined()
    expect(status.configurationTargets?.codex).toMatchObject({ scope: 'user', override: 'none', writable: true })
    expect(JSON.stringify({ recovered, status, state })).not.toContain(projectDirectory)
    await restarted.stop()
  })

  it('损坏的历史 Codex 私有项目选择不会阻塞重启恢复，仍只读取用户级配置', async () => {
    const f = files()
    const projectDirectory = '/customer/project'
    const projectPath = `${projectDirectory}/.codex/config.toml`
    const privatePath = '/toolbox/private-project-targets.json'
    const targetStore = createProjectConfigurationTargetStore(f.io, privatePath, 'darwin')
    const projectContents = 'approval_policy = "on-request"\n'
    f.data.set(projectPath, projectContents)
    let state: AiAccessState = { version: 1, selected: {} }
    const store = { read: async () => state, write: async (next: AiAccessState) => { state = next } }
    const first = new AiAccessService(store, createDeepSeekAdapters({
      home: '/customer', platform: 'darwin', file: f.io, projectTargetStore: targetStore
    }), acceptingGateway())

    await first.saveProviderKey('codex', 'deepseek', 'sk-toolbox-fixture-key-1234567890')
    await first.useProvider('codex', 'deepseek')
    await first.stop()
    state = { ...state, configurationTargetScopes: { codex: 'project' } }
    f.data.set(privatePath, '{invalid private selection')

    const restarted = new AiAccessService(store, createDeepSeekAdapters({
      home: '/customer', platform: 'darwin', file: f.io, projectTargetStore: targetStore
    }), acceptingGateway())
    await restarted.initialize()
    const recovered = await restarted.recoverAccess('startup')

    expect(recovered).toMatchObject({ outcome: 'ok', configurations: { codex: 'ok' } })
    expect(state.configurationTargetScopes?.codex).toBeUndefined()
    expect(JSON.stringify(recovered)).not.toContain(projectDirectory)
    expect(f.data.get('/customer/.codex/config.toml')).toContain('model_provider = "laixin-deepseek-local"')
    expect(f.data.get(projectPath)).toBe(projectContents)
    await restarted.stop()
  })

  it('Codex 解除路由后只报告 auth.json 的安全结论，保留其他工具的 API Key 原文', async () => {
    const f = files()
    const authPath = '/customer/.codex/auth.json'
    const auth = JSON.stringify({ OPENAI_API_KEY: 'fixture-third-party-api-key' })
    f.data.set(authPath, auth)
    const codex = createDeepSeekAdapters({ home: '/customer', platform: 'darwin', file: f.io }).find((adapter) => adapter.shell === 'codex')!

    await codex.applyDeepSeek('sk-toolbox-fixture-key-1234567890')
    await codex.deactivateToolboxConnection!()

    await expect(codex.officialAuthenticationStatus!()).resolves.toEqual({ state: 'login-required', reason: 'other-tool-api-key' })
    expect(f.data.get(authPath)).toBe(auth)
  })

  it('自定义 CODEX_HOME 仍是用户级配置根，Codex 只写其中的 config.toml', async () => {
    const f = files()
    const codex = createDeepSeekAdapters({
      home: '/customer', platform: 'darwin', file: f.io,
      // This is the same main-process observation passed by productionAiAccessService.
      configurationExecution: observedConfigurationExecution('/customer', 'darwin', { CODEX_HOME: '/other/.codex' })
    }).find((adapter) => adapter.shell === 'codex')!

    await expect(codex.configurationTargetStatus!()).resolves.toMatchObject({ scope: 'user', override: 'none', writable: true })
    await expect(codex.codexOfficialLoginRoot!()).resolves.toBe('/other/.codex')
    await codex.applyDeepSeek('sk-toolbox-fixture-key-1234567890')
    expect(f.data.get('/other/.codex/config.toml')).toContain('model_provider = "laixin-deepseek"')
    expect(f.data.has('/customer/.codex/config.toml')).toBe(false)
  })

  it('自定义 CODEX_HOME 的 auth.json 决定官方认证结论，默认根不会掩盖它', async () => {
    const f = files()
    const defaultAuthPath = '/customer/.codex/auth.json'
    const customAuthPath = '/other/.codex/auth.json'
    f.data.set(defaultAuthPath, JSON.stringify({
      tokens: { access_token: 'fixture-default-access', refresh_token: 'fixture-default-refresh' }
    }))
    f.data.set(customAuthPath, JSON.stringify({ OPENAI_API_KEY: 'fixture-custom-third-party-key' }))
    const codex = createDeepSeekAdapters({
      home: '/customer', platform: 'darwin', file: f.io,
      configurationExecution: observedConfigurationExecution('/customer', 'darwin', { CODEX_HOME: '/other/.codex' })
    }).find((adapter) => adapter.shell === 'codex')!

    await expect(codex.officialAuthenticationStatus!()).resolves.toEqual({ state: 'login-required', reason: 'other-tool-api-key' })

    f.data.set(defaultAuthPath, JSON.stringify({ OPENAI_API_KEY: 'fixture-default-third-party-key' }))
    f.data.set(customAuthPath, JSON.stringify({
      tokens: { access_token: 'fixture-custom-access', refresh_token: 'fixture-custom-refresh' }
    }))
    await expect(codex.officialAuthenticationStatus!()).resolves.toEqual({ state: 'official', reason: 'chatgpt-session' })
  })

  it('自定义 CLAUDE_CONFIG_DIR 是实际用户配置根，不被误当成命令行覆盖', async () => {
    const f = files()
    const execution = observedConfigurationExecution('/customer', 'darwin', { CLAUDE_CONFIG_DIR: '/other/.claude' })
    expect(execution.claude).toEqual({ source: 'observed', userConfigPath: '/other/.claude/settings.json' })
    const claude = createDeepSeekAdapters({
      home: '/customer', platform: 'darwin', file: f.io, configurationExecution: execution
    }).find((adapter) => adapter.shell === 'claude')!

    await expect(claude.configurationTargetStatus!()).resolves.toMatchObject({ scope: 'user', override: 'none', writable: true })
    await claude.applyDeepSeek('sk-toolbox-fixture-key-1234567890')
    expect(f.data.get('/other/.claude/settings.json')).toContain('https://api.deepseek.com/anthropic')
    expect(f.data.has('/customer/.claude/settings.json')).toBe(false)
  })

  it('自定义 HERMES_HOME 使用其固定 virtualenv 启动器，配置写入实际用户根', async () => {
    const f = files()
    const settings = new Map([['model.provider', 'openai'], ['model.default', 'gpt-5.5']])
    const runHermes = vi.fn(async (_command: string, args: readonly string[]) => {
      if (args[1] === 'set') settings.set(args[2], args[3])
      else settings.delete(args[2])
    })
    const execution = observedConfigurationExecution('/customer', 'darwin', { HERMES_HOME: '/other/.hermes' })
    expect(execution.hermes).toEqual({ source: 'observed', userConfigPath: '/other/.hermes/.env' })
    const hermes = createDeepSeekAdapters({
      home: '/customer', platform: 'darwin', hermesHome: '/other/.hermes', file: f.io,
      configurationExecution: execution, findHermesCommand: async () => '/other/.hermes/hermes-agent/venv/bin/hermes',
      runHermes, readHermesConfig: async (_command, key) => settings.get(key)
    }).find((adapter) => adapter.shell === 'hermes')!

    await expect(hermes.configurationTargetStatus!()).resolves.toMatchObject({ scope: 'user', override: 'none', writable: true })
    await hermes.applyDeepSeek('sk-toolbox-fixture-key-1234567890')
    expect(f.data.get('/other/.hermes/.env')).toContain('DEEPSEEK_API_KEY=sk-toolbox-fixture-key-1234567890')
    expect(runHermes).toHaveBeenCalledWith('/other/.hermes/hermes-agent/venv/bin/hermes', ['config', 'set', 'model.provider', 'deepseek'], '/other/.hermes')
    expect(f.data.has('/customer/.hermes/.env')).toBe(false)
  })

  it('Claude 可切回官方，只移除工具箱写入的配置，不动官方凭据', async () => {
    const f = files()
    const claude = createDeepSeekAdapters({ home: '/customer', platform: 'darwin', file: f.io }).find(adapter => adapter.shell === 'claude')!
    f.data.set('/customer/.claude/.credentials.json', 'fixture-official-session')
    await claude.applyDeepSeek('sk-toolbox-fixture-key-1234567890')
    expect(claude.activateOfficial).toBeTypeOf('function')
    await claude.activateOfficial!()
    expect(f.data.has('/customer/.claude/settings.json')).toBe(false)
    expect(f.data.get('/customer/.claude/.credentials.json')).toBe('fixture-official-session')
    f.data.set('/customer/.claude/settings.json', '{"theme":"dark"}')
    await expect(claude.activateOfficial!()).rejects.toThrow('AI_ACCESS_CONFIG_UNMANAGED')
    expect(f.data.get('/customer/.claude/settings.json')).toBe('{"theme":"dark"}')
  })
  it('Claude 接管期间不换项目目录；解除工具箱接管后恢复原连接并可直接改用新的独立目标', async () => {
    const f = files()
    const userPath = '/customer/.claude/settings.json'
    const projectAPath = '/customer/project-a/.claude/settings.json'
    const projectBPath = '/customer/project-b/.claude/settings.json'
    const originalUser = `${JSON.stringify({ env: {
      CUSTOMER_SETTING: 'keep', ANTHROPIC_BASE_URL: 'https://cc-switch.example/anthropic',
      ANTHROPIC_AUTH_TOKEN: 'fixture-cc-switch-key-1234567890', ANTHROPIC_MODEL: 'customer-route-model'
    } }, null, 2)}\n`
    const originalProject = `${JSON.stringify({ env: { PROJECT_SETTING: 'keep' } }, null, 2)}\n`
    const originalProjectB = `${JSON.stringify({ env: { PROJECT_B_SETTING: 'keep' } }, null, 2)}\n`
    f.data.set(userPath, originalUser)
    f.data.set(projectAPath, originalProject)
    f.data.set(projectBPath, originalProjectB)
    const targets = createProjectConfigurationTargetStore(f.io, '/toolbox/private-project-targets.json', 'darwin')
    let state: AiAccessState = { version: 1, selected: {} }
    const store = { read: async () => state, write: async (next: AiAccessState) => { state = next } }
    const service = new AiAccessService(store, createDeepSeekAdapters({
      home: '/customer', platform: 'darwin', file: f.io, projectTargetStore: targets
    }), acceptingGateway())

    try {
      await service.configureProvider('claude', 'deepseek', 'sk-fixture-target-lock-0123456789', 'deepseek-flash')
      expect(f.data.get(userPath)).toContain('127.0.0.1')
      await expect(service.selectConfigurationProject('claude', '/customer/project-a')).rejects.toThrow('AI_ACCESS_CONFIGURATION_TARGET_CHANGE_REQUIRES_CLEAN_CONNECTION')
      expect(await targets.selectedProjectDirectory('claude')).toBeUndefined()
      expect(f.data.get(projectAPath)).toBe(originalProject)

      await service.useOfficial('claude')
      expect(f.data.get(userPath)).toBe(originalUser)
      expect(f.data.has('/customer/.claude/laixin-model-api-backup.json')).toBe(false)

      await service.selectConfigurationProject('claude', '/customer/project-a')
      await service.useProvider('claude', 'deepseek')
      expect(f.data.get(userPath)).toBe(originalUser)
      expect(f.data.get(projectAPath)).toContain('127.0.0.1')
      await expect(service.selectConfigurationProject('claude', '/customer/project-b')).rejects.toThrow('AI_ACCESS_CONFIGURATION_TARGET_CHANGE_REQUIRES_CLEAN_CONNECTION')
      expect(await targets.selectedProjectDirectory('claude')).toBe('/customer/project-a')
      expect(f.data.get(projectBPath)).toBe(originalProjectB)

      await service.useOfficial('claude')
      expect(f.data.get(userPath)).toBe(originalUser)
      expect(f.data.get(projectAPath)).toBe(originalProject)
      expect(f.data.has('/customer/project-a/.claude/laixin-model-api-backup.json')).toBe(false)

      await service.selectConfigurationProject('claude', '/customer/project-b')
      await service.useProvider('claude', 'deepseek')
      expect(await targets.selectedProjectDirectory('claude')).toBe('/customer/project-b')
      expect(f.data.get(userPath)).toBe(originalUser)
      expect(f.data.get(projectAPath)).toBe(originalProject)
      expect(f.data.get(projectBPath)).toContain('127.0.0.1')
      const restarted = new AiAccessService(store, createDeepSeekAdapters({
        home: '/customer', platform: 'darwin', file: f.io, projectTargetStore: targets
      }), acceptingGateway())
      await expect(restarted.status()).resolves.toMatchObject({
        configurationTargets: { claude: { scope: 'project', override: 'project', writable: true } }
      })
      await restarted.stop()

      await service.useOfficial('claude')
      expect(f.data.get(userPath)).toBe(originalUser)
      expect(f.data.get(projectAPath)).toBe(originalProject)
      expect(f.data.get(projectBPath)).toBe(originalProjectB)
      expect(f.data.has('/customer/project-a/.claude/laixin-model-api-backup.json')).toBe(false)
      expect(f.data.has('/customer/project-b/.claude/laixin-model-api-backup.json')).toBe(false)
    } finally { await service.stop() }
  })
  it('Codex 和 Claude 写各自原生配置，Hermes 确认可写后再选择供应商和模型', async () => {
    const f = files()
    const settings = new Map([['model.provider', 'openai'], ['model.default', 'gpt-5.5']])
    const runHermes = vi.fn(async (_command: string, args: readonly string[]) => {
      if (args[1] === 'set') settings.set(args[2], args[3])
      else settings.delete(args[2])
    })
    const readHermesConfig = vi.fn(async (_command: string, key: HermesModelKey) => settings.get(key))
    const adapters = createDeepSeekAdapters({
      home: '/customer', platform: 'darwin', file: f.io,
      findHermesCommand: async () => '/customer/.local/bin/hermes', runHermes, readHermesConfig
    })
    const key = 'sk-toolbox-fixture-key-1234567890'
    await adapters.find((adapter) => adapter.shell === 'codex')!.applyDeepSeek(key)
    await adapters.find((adapter) => adapter.shell === 'claude')!.applyDeepSeek(key)
    await adapters.find((adapter) => adapter.shell === 'hermes')!.applyDeepSeek(key)

    expect(f.data.get('/customer/.codex/config.toml')).toContain(key)
    expect(f.data.get('/customer/.claude/settings.json')).toContain(key)
    expect(f.data.get('/customer/.hermes/.env')).toContain(key)
    expect(runHermes).toHaveBeenNthCalledWith(1, '/customer/.local/bin/hermes', ['config', 'set', 'model.provider', 'deepseek'], '/customer/.hermes')
    expect(runHermes).toHaveBeenNthCalledWith(2, '/customer/.local/bin/hermes', ['config', 'set', 'model.default', 'deepseek-flash'], '/customer/.hermes')
  })

  it('Hermes 不可用时不创建含 Key 的环境文件', async () => {
    const f = files()
    const hermes = createDeepSeekAdapters({
      home: '/customer', platform: 'darwin', file: f.io, findHermesCommand: async () => undefined
    }).find((adapter) => adapter.shell === 'hermes')!

    await expect(hermes.applyDeepSeek('sk-toolbox-fixture-key-1234567890')).rejects.toThrow('AI_ACCESS_HERMES_NOT_INSTALLED')
    expect(f.data.get('/customer/.hermes/.env')).toBeUndefined()
  })

  it('Hermes 通过本地 API 服务接入国内智谱、Kimi Code 或 Kimi 开放平台时写入并回读专属路由', async () => {
    const f = files()
    const settings = new Map([['model.provider', 'openai'], ['model.default', 'gpt-5.5']])
    const hermes = createDeepSeekAdapters({
      home: '/customer', platform: 'darwin', file: f.io,
      findHermesCommand: async () => '/customer/.local/bin/hermes',
      runHermes: async (_command, args) => { if (args[1] === 'set') settings.set(args[2], args[3]); else settings.delete(args[2]) },
      readHermesConfig: async (_command, key) => settings.get(key)
    }).find((adapter) => adapter.shell === 'hermes')!

    await hermes.applyConnection!('moonshot', {
      baseUrl: 'http://127.0.0.1:19361/hermes/moonshot/v1', apiKey: 'local-toolbox-token-1234567890', model: 'kimi-k3'
    })

    expect(settings.get('model.provider')).toBe('custom')
    expect(settings.get('model.default')).toBe('kimi-k3')
    expect(settings.get('model.base_url')).toBe('http://127.0.0.1:19361/hermes/moonshot/v1')
    expect(settings.get('model.api_key')).toBe('local-toolbox-token-1234567890')
    expect(settings.get('model.api_mode')).toBe('chat_completions')
    expect(settings.get('model.context_length')).toBe('1048576')
  })

  it('Hermes 本机路由覆盖旧协议和上下文，回滚时把每个受管模型设置恢复原状', async () => {
    const f = files()
    const settings = new Map<string, string | undefined>([
      ['model.provider', 'openai'], ['model.default', 'gpt-5.5'], ['model.base_url', 'https://official.example'], ['model.api_key', 'official-token'],
      ['model.api_mode', 'anthropic_messages'], ['model.context_length', '1048576']
    ])
    const hermes = createDeepSeekAdapters({
      home: '/customer', platform: 'darwin', file: f.io,
      findHermesCommand: async () => '/customer/.hermes/bin/hermes',
      runHermes: async (_command, args) => { if (args[1] === 'set') settings.set(args[2], args[3]); else settings.delete(args[2]) },
      readHermesConfig: async (_command, key) => settings.get(key)
    }).find((adapter) => adapter.shell === 'hermes')!

    const rollback = await hermes.captureConnection!()
    await hermes.applyConnection!('zhipu', {
      baseUrl: 'http://127.0.0.1:19361/hermes/zhipu/v1', apiKey: 'local-toolbox-token-1234567890', model: 'glm-5.3-flash'
    })
    expect(Object.fromEntries(settings)).toMatchObject({
      'model.provider': 'custom', 'model.default': 'glm-5.3-flash', 'model.api_mode': 'chat_completions',
      'model.context_length': '1048576'
    })

    await rollback()
    expect(Object.fromEntries(settings)).toEqual({
      'model.provider': 'openai', 'model.default': 'gpt-5.5', 'model.base_url': 'https://official.example', 'model.api_key': 'official-token',
      'model.api_mode': 'anthropic_messages', 'model.context_length': '1048576'
    })
  })

  it('Hermes 配置与安装盘点只使用固定 virtualenv 候选，不把 PATH 或 bin 包装器作为可执行来源', () => {
    expect(trustedHermesCommandCandidates('darwin', '/customer/.hermes')).toEqual([
      '/customer/.hermes/hermes-agent/venv/bin/hermes'
    ])
  })

  it('搬家的 HERMES_HOME 优先使用自身受信 virtualenv 命令，跳过 PATH 里的脚本包装器', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'laixin-hermes-command-')))
    const home = join(root, 'customer')
    const wrapperDirectory = join(root, 'path')
    const wrapper = join(wrapperDirectory, 'hermes')
    const hermesHome = join(home, 'relocated-hermes')
    const native = join(hermesHome, 'hermes-agent', 'venv', 'bin', 'hermes')
    const originalPath = process.env.PATH
    await mkdir(wrapperDirectory, { recursive: true })
    await mkdir(join(hermesHome, 'hermes-agent', 'venv', 'bin'), { recursive: true })
    await writeFile(wrapper, '#!/bin/sh\necho wrapper\n')
    await writeFile(native, officialHermesConsoleScript())
    await Promise.all([chmod(wrapper, 0o755), chmod(native, 0o755)])
    process.env.PATH = wrapperDirectory
    try {
      const f = files()
      const settings = new Map<HermesModelKey, string | undefined>([['model.provider', 'openai'], ['model.default', 'gpt-5.5']])
      const runHermes = vi.fn(async (_command: string, args: readonly string[]) => {
        if (args[1] === 'set') settings.set(args[2] as HermesModelKey, args[3])
        else settings.delete(args[2] as HermesModelKey)
      })
      const hermes = createDeepSeekAdapters({
        home, platform: 'darwin', hermesHome, file: f.io, runHermes,
        readHermesConfig: async (_command, key) => settings.get(key)
      }).find((adapter) => adapter.shell === 'hermes')!

      await hermes.applyDeepSeek('sk-toolbox-fixture-key-1234567890')
      expect(runHermes.mock.calls[0]?.[0]).toBe(native)
    } finally {
      if (originalPath === undefined) delete process.env.PATH
      else process.env.PATH = originalPath
      await rm(root, { recursive: true, force: true })
    }
  })

  it('观察器在创建适配器后发现搬家的 HERMES_HOME 时，默认命令发现随有效配置根刷新', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'laixin-hermes-observed-home-')))
    const home = join(root, 'customer')
    const hermesHome = join(home, 'terminal-hermes')
    const launcher = join(hermesHome, 'hermes-agent', 'venv', 'bin', 'hermes')
    try {
      await mkdir(dirname(launcher), { recursive: true })
      await writeFile(launcher, officialHermesConsoleScript())
      const f = files()
      const settings = new Map<HermesModelKey, string | undefined>([['model.provider', 'openai'], ['model.default', 'gpt-5.5']])
      const runHermes = vi.fn(async (_command: string, args: readonly string[]) => {
        if (args[1] === 'set') settings.set(args[2] as HermesModelKey, args[3])
        else settings.delete(args[2] as HermesModelKey)
      })
      const hermes = createDeepSeekAdapters({
        home, platform: 'linux', file: f.io,
        observeConfigurationExecution: async () => ({ hermes: { source: 'observed', userConfigPath: join(hermesHome, '.env') } }),
        runHermes, readHermesConfig: async (_command, key) => settings.get(key)
      }).find((adapter) => adapter.shell === 'hermes')!

      await hermes.applyDeepSeek('sk-toolbox-fixture-key-1234567890')

      expect(f.data.get(join(hermesHome, '.env'))).toContain('DEEPSEEK_API_KEY=sk-toolbox-fixture-key-1234567890')
      expect(runHermes).toHaveBeenCalledWith(launcher, ['config', 'set', 'model.provider', 'deepseek'], hermesHome)
      expect(f.data.has(join(home, '.hermes', '.env'))).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')('搬家的 Hermes 默认 config set/get 用安全 PATH，不触发客户 dirname、realpath 或 awk 包装器', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'laixin-hermes-adapter-safe-env-')))
    const home = join(root, 'customer')
    const hermesHome = join(home, 'relocated-hermes')
    const bin = join(hermesHome, 'hermes-agent', 'venv', 'bin')
    const launcher = join(bin, 'hermes')
    const python = join(bin, 'python3')
    const wrapperDirectory = join(root, 'wrappers')
    const marker = join(root, 'wrapper-ran')
    try {
      await Promise.all([mkdir(bin, { recursive: true }), mkdir(wrapperDirectory, { recursive: true })])
      await writeFile(launcher, officialHermesConsoleScript(), { mode: 0o700 })
      await writeFile(python, [
        '#!/bin/sh',
        'state="$0.state"',
        'if [ "$2" = "config" ] && [ "$3" = "set" ]; then',
        '  printf "%s=%s\\n" "$4" "$5" >> "$state"',
        '  exit 0',
        'fi',
        'if [ "$2" = "config" ] && [ "$3" = "get" ]; then',
        "  awk -F= -v key=\"$4\" '$1 == key { value=substr($0, length(key)+2) } END { if (value != \"\") print value }' \"$state\"",
        '  exit 0',
        'fi',
        'exit 0',
        ''
      ].join('\n'), { mode: 0o700 })
      for (const utility of ['dirname', 'realpath', 'awk']) {
        const wrapper = join(wrapperDirectory, utility)
        await writeFile(wrapper, `#!/bin/sh\n: > ${marker}\nexit 1\n`, { mode: 0o700 })
        await chmod(wrapper, 0o700)
      }
      await chmod(launcher, 0o700); await chmod(python, 0o700)
      const f = files()
      const hermes = createDeepSeekAdapters({
        home, platform: 'linux', hermesHome, file: f.io, hermesExecutionEnvironment: { PATH: wrapperDirectory, HOME: home }
      }).find((adapter) => adapter.shell === 'hermes')!

      await hermes.applyDeepSeek('sk-toolbox-fixture-key-1234567890')

      expect(f.data.get(join(hermesHome, '.env'))).toContain('sk-toolbox-fixture-key-1234567890')
      await expect(access(marker)).rejects.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('未知 PATH 包装器或受信任根内的脚本候选都不能执行，也不写 Key', async () => {
    const root = await mkdtemp(join(tmpdir(), 'laixin-hermes-command-'))
    const home = join(root, 'customer')
    const wrapperDirectory = join(root, 'path')
    const wrapper = join(wrapperDirectory, 'hermes')
    const rootScript = join(home, '.hermes', 'bin', 'hermes')
    const originalPath = process.env.PATH
    await Promise.all([mkdir(wrapperDirectory, { recursive: true }), mkdir(join(home, '.hermes', 'bin'), { recursive: true })])
    await writeFile(wrapper, '#!/bin/sh\necho wrapper\n')
    await writeFile(rootScript, '#!/bin/sh\necho root-wrapper\n')
    await chmod(wrapper, 0o755)
    process.env.PATH = wrapperDirectory
    try {
      const f = files()
      const runHermes = vi.fn(async () => undefined)
      const hermes = createDeepSeekAdapters({
        home, platform: 'darwin', file: f.io, runHermes,
        readHermesConfig: async () => 'openai'
      }).find((adapter) => adapter.shell === 'hermes')!

      await expect(hermes.applyDeepSeek('sk-toolbox-fixture-key-1234567890')).rejects.toThrow('AI_ACCESS_HERMES_NOT_INSTALLED')
      expect(runHermes).not.toHaveBeenCalled()
      expect(f.data.get(join(home, '.hermes', '.env'))).toBeUndefined()
    } finally {
      if (originalPath === undefined) delete process.env.PATH
      else process.env.PATH = originalPath
      await rm(root, { recursive: true, force: true })
    }
  })

  it('Hermes 状态优先从一次 config.yaml 读取六项受管设置，不启动 config get 子进程', async () => {
    const f = files()
    f.data.set('/customer/.hermes/config.yaml', [
      'model:',
      '  provider: custom',
      '  default: deepseek-v4-flash',
      '  base_url: "http://127.0.0.1:19361/hermes/deepseek/v1"',
      '  api_key: "local-toolbox-token-1234567890"',
      '  api_mode: chat_completions',
      '  context_length: 1048576'
    ].join('\n'))
    const findHermesCommand = vi.fn(async () => '/customer/.hermes/bin/hermes')
    const readHermesConfig = vi.fn(async () => 'should-not-run')
    const hermes = createDeepSeekAdapters({
      home: '/customer', platform: 'darwin', file: f.io, findHermesCommand, readHermesConfig
    }).find((adapter) => adapter.shell === 'hermes')!

    await expect(hermes.readManagedFingerprint!()).resolves.toEqual(expect.any(String))
    expect(readHermesConfig).not.toHaveBeenCalled()
    expect(findHermesCommand).not.toHaveBeenCalled()
  })

  it('Hermes 配置轮询在 config.yaml 缺失时 fail-closed，不启动 CLI 查询', async () => {
    const f = files()
    const settings = new Map<HermesModelKey, string | undefined>([
      ['model.provider', 'custom'], ['model.default', 'deepseek-v4-flash'],
      ['model.base_url', 'http://127.0.0.1:19361/hermes/deepseek/v1'], ['model.api_key', 'local-toolbox-token-1234567890'],
      ['model.api_mode', 'chat_completions'], ['model.context_length', '1048576']
    ])
    let inFlight = 0
    let highestInFlight = 0
    const readHermesConfig = vi.fn(async (_command: string, key: HermesModelKey) => {
      inFlight += 1
      highestInFlight = Math.max(highestInFlight, inFlight)
      await new Promise(resolve => setTimeout(resolve, 0))
      inFlight -= 1
      return settings.get(key)
    })
    const hermes = createDeepSeekAdapters({
      home: '/customer', platform: 'darwin', file: f.io,
      findHermesCommand: async () => '/customer/.hermes/bin/hermes', readHermesConfig
    }).find((adapter) => adapter.shell === 'hermes')!

    await expect(hermes.readManagedFingerprint!()).rejects.toThrow('AI_ACCESS_CONFIGURATION_FINGERPRINT_UNAVAILABLE')
    expect(readHermesConfig).not.toHaveBeenCalled()
    expect(highestInFlight).toBe(0)
  })

  it('Hermes 显式备份在 config.yaml 缺失时才串行回退读取', async () => {
    const f = files()
    const settings = new Map<HermesModelKey, string | undefined>([
      ['model.provider', 'custom'], ['model.default', 'deepseek-v4-flash'],
      ['model.base_url', 'http://127.0.0.1:19361/hermes/deepseek/v1'], ['model.api_key', 'local-toolbox-token-1234567890'],
      ['model.api_mode', 'chat_completions'], ['model.context_length', '1048576']
    ])
    let inFlight = 0
    let highestInFlight = 0
    const readHermesConfig = vi.fn(async (_command: string, key: HermesModelKey) => {
      inFlight += 1
      highestInFlight = Math.max(highestInFlight, inFlight)
      await new Promise(resolve => setTimeout(resolve, 0))
      inFlight -= 1
      return settings.get(key)
    })
    const hermes = createDeepSeekAdapters({
      home: '/customer', platform: 'darwin', file: f.io,
      findHermesCommand: async () => '/customer/.hermes/bin/hermes', readHermesConfig
    }).find((adapter) => adapter.shell === 'hermes')!

    await expect(hermes.captureConnection!()).resolves.toEqual(expect.any(Function))
    expect(readHermesConfig).toHaveBeenCalledTimes(6)
    expect(highestInFlight).toBe(1)
  })

  it('服务状态写入失败时，captureConnection 能把三个壳恢复到切换前状态', async () => {
    const f = files()
    f.data.set('/customer/.codex/config.toml', 'approval_policy = "on-request"\n')
    f.data.set('/customer/.claude/settings.json', '{"theme":"dark"}\n')
    const settings = new Map<string, string | undefined>([
      ['model.provider', 'openai'], ['model.default', 'gpt-5.5'], ['model.base_url', 'https://official.example'], ['model.api_key', 'official-token']
    ])
    const adapters = createDeepSeekAdapters({
      home: '/customer', platform: 'darwin', file: f.io,
      findHermesCommand: async () => '/customer/.local/bin/hermes',
      runHermes: async (_command, args) => {
        if (args[1] === 'set') settings.set(args[2], args[3])
        else settings.delete(args[2])
      },
      readHermesConfig: async (_command, key) => settings.get(key)
    })
    const local = { baseUrl: 'http://127.0.0.1:19361/codex/deepseek/v1', apiKey: 'local-toolbox-token-1234567890', model: 'deepseek-v4-pro' }
    const codex = adapters.find((adapter) => adapter.shell === 'codex')!
    const codexRollback = await codex.captureConnection!()
    await codex.applyConnection!('deepseek', local)
    expect(f.data.get('/customer/.codex/config.toml')).toContain('model = "deepseek-v4-pro"')
    expect(JSON.parse(f.data.get('/customer/.codex/laixin-models.json')!)).toMatchObject({ models: [{ slug: 'deepseek-v4-pro', display_name: 'deepseek-v4-pro' }] })
    await codexRollback()
    expect(f.data.get('/customer/.codex/config.toml')).toBe('approval_policy = "on-request"\n')
    expect(f.data.has('/customer/.codex/laixin-models.json')).toBe(false)
    expect(f.data.has('/customer/.codex/laixin-model-api-backup.json')).toBe(false)

    const claude = adapters.find((adapter) => adapter.shell === 'claude')!
    const claudeRollback = await claude.captureConnection!()
    await claude.applyConnection!('deepseek', { ...local, baseUrl: 'http://127.0.0.1:19361/claude/deepseek' })
    expect(JSON.parse(f.data.get('/customer/.claude/settings.json')!)).toMatchObject({ env: { ANTHROPIC_MODEL: 'deepseek-v4-pro', CLAUDE_CODE_SUBAGENT_MODEL: 'deepseek-v4-pro' } })
    await claudeRollback()
    expect(f.data.get('/customer/.claude/settings.json')).toBe('{"theme":"dark"}\n')
    expect(f.data.has('/customer/.claude/laixin-model-api-backup.json')).toBe(false)

    const hermes = adapters.find((adapter) => adapter.shell === 'hermes')!
    const hermesRollback = await hermes.captureConnection!()
    await hermes.applyConnection!('deepseek', { ...local, baseUrl: 'http://127.0.0.1:19361/hermes/deepseek/v1' })
    expect(settings.get('model.default')).toBe('deepseek-v4-pro')
    await hermesRollback()
    expect(Object.fromEntries(settings)).toEqual({
      'model.provider': 'openai', 'model.default': 'gpt-5.5', 'model.base_url': 'https://official.example', 'model.api_key': 'official-token'
    })
  })

  it('Windows Hermes 将 Key 写入它实际使用的 LocalAppData 目录，并支持 HERMES_HOME', async () => {
    const key = 'sk-toolbox-fixture-key-1234567890'
    const apply = async (hermesHome?: string) => {
      const f = files()
      const settings = new Map([['model.provider', 'openai'], ['model.default', 'gpt-5.5']])
      const hermes = createDeepSeekAdapters({
        home: 'C:\\Users\\customer', platform: 'win32', localAppData: 'C:\\Users\\customer\\AppData\\Local', hermesHome, file: f.io,
        findHermesCommand: async () => 'C:\\fixture\\hermes.exe',
        runHermes: async (_command, args) => { if (args[1] === 'set') settings.set(args[2], args[3]); else settings.delete(args[2]) },
        readHermesConfig: async (_command, setting) => settings.get(setting)
      }).find((adapter) => adapter.shell === 'hermes')!
      await hermes.applyDeepSeek(key)
      return f.data
    }

    const defaultHome = await apply()
    const customHome = await apply('D:\\customer-hermes')
    expect(defaultHome.get('C:\\Users\\customer\\AppData\\Local\\hermes\\.env')).toContain(key)
    expect(customHome.get('D:\\customer-hermes\\.env')).toContain(key)
  })

  it('Hermes 的 .env 不属于工具箱时不执行任何 config set', async () => {
    const f = files()
    const runHermes = vi.fn(async () => undefined)
    const hermes = createDeepSeekAdapters({
      home: '/customer', platform: 'darwin', file: f.io,
      findHermesCommand: async () => '/customer/.local/bin/hermes', runHermes,
      readHermesConfig: async () => 'openai'
    }).find((adapter) => adapter.shell === 'hermes')!
    f.data.set('/customer/.hermes/.env', 'DEEPSEEK_API_KEY=customer-managed-key\n')

    await expect(hermes.applyDeepSeek('sk-toolbox-fixture-key-1234567890')).rejects.toThrow('AI_ACCESS_CONFIG_UNMANAGED')
    expect(runHermes).not.toHaveBeenCalled()
  })

  it('Hermes 后续操作失败时恢复原供应商和模型', async () => {
    const f = files()
    const runHermes = vi.fn(async (_command: string, args: readonly string[]) => {
      if (args[3] === 'deepseek-flash') throw new Error('second setting failed')
    })
    const hermes = createDeepSeekAdapters({
      home: '/customer', platform: 'darwin', file: f.io,
      findHermesCommand: async () => '/customer/.local/bin/hermes', runHermes,
      readHermesConfig: async (_command, key) => key === 'model.provider' ? 'openai' : 'gpt-5.5'
    }).find((adapter) => adapter.shell === 'hermes')!

    await expect(hermes.applyDeepSeek('sk-toolbox-fixture-key-1234567890')).rejects.toThrow('AI_ACCESS_HERMES_CONFIG_FAILED')
    expect(f.data.get('/customer/.hermes/.env')).toBeUndefined()
    expect(runHermes).toHaveBeenCalledWith('/customer/.local/bin/hermes', ['config', 'set', 'model.default', 'gpt-5.5'], '/customer/.hermes')
  })
})

/** Hermes 生产适配器的原生 CLI 状态夹具：settings 即 config.yaml 里六个 model.* 键的语义。 */
function hermesExitFixture(customerSettings: readonly (readonly [HermesModelKey, string])[]) {
  const f = files()
  const settings = new Map<HermesModelKey, string | undefined>(customerSettings)
  const build = () => createDeepSeekAdapters({
    home: '/customer', platform: 'darwin', file: f.io,
    findHermesCommand: async () => '/customer/.hermes/bin/hermes',
    runHermes: async (_command, args) => {
      if (args[1] === 'set') settings.set(args[2] as HermesModelKey, args[3])
      else settings.delete(args[2] as HermesModelKey)
    },
    readHermesConfig: async (_command, key) => settings.get(key)
  }).find((adapter) => adapter.shell === 'hermes')!
  return { f, settings, hermes: build(), rebuild: build }
}

const customerRoute = (provider: 'deepseek' | 'moonshot', model: string) => ({
  baseUrl: `http://127.0.0.1:19361/hermes/${provider}/v1`, apiKey: 'local-toolbox-token-1234567890', model
})


describe('Hermes 解除工具箱接管与接入前恢复（API-02 · 先解除再显式恢复）', () => {
  const customerA: readonly (readonly [HermesModelKey, string])[] = [
    ['model.provider', 'openai'], ['model.default', 'gpt-5.5'], ['model.base_url', 'https://official.example'],
    ['model.api_key', 'official-token'], ['model.api_mode', 'anthropic_messages'], ['model.context_length', '1048576']
  ]
  const backupPath = '/customer/.hermes/laixin-model-api-backup.json'
  const envPath = '/customer/.hermes/.env'
  const expectSettings = (settings: Map<HermesModelKey, string | undefined>, expected: Readonly<Record<string, string | undefined>>) =>
    expect(Object.fromEntries(settings)).toEqual(expected)
  const unsetAll = {
    'model.provider': undefined, 'model.default': undefined, 'model.base_url': undefined,
    'model.api_key': undefined, 'model.api_mode': undefined, 'model.context_length': undefined
  }
  const routeB = (provider: 'deepseek' | 'moonshot', model: string) => ({
    'model.provider': 'custom', 'model.default': model,
    'model.base_url': `http://127.0.0.1:19361/hermes/${provider}/v1`, 'model.api_key': 'local-toolbox-token-1234567890',
    'model.api_mode': 'chat_completions', 'model.context_length': '1048576'
  })

  it('① A→接入B→解除只解除接管（设置清空、恢复点保留）→显式恢复找回 A 并消费恢复点', async () => {
    const { f, settings, hermes, rebuild } = hermesExitFixture(customerA)
    await hermes.applyConnection!('deepseek', customerRoute('deepseek', 'deepseek-flash'))
    const backup = f.data.get(backupPath)
    expect(JSON.parse(JSON.parse(backup!).original)).toEqual(Object.fromEntries(customerA))
    await hermes.applyConnection!('moonshot', customerRoute('moonshot', 'kimi-k3'))
    expect(f.data.get(backupPath)).toBe(backup)

    // 解除：只撤销工具箱自己的管理；恢复点 ⛔ 在这一步被消费或冒充恢复。
    await rebuild().deactivateToolboxConnection!()
    expectSettings(settings, unsetAll)
    expect(JSON.parse(f.data.get(backupPath)!)).toEqual(JSON.parse(backup!))

    // 显式恢复：找回接入前原配置，恢复点用完即消费。
    await rebuild().restorePreviousConnection!()
    expectSettings(settings, Object.fromEntries(customerA))
    expect(f.data.has(backupPath)).toBe(false)
  })

  it('①b 旧安装换 Key 不得把工具箱路由存成恢复点；解除后不仍指向工具箱（复核问题1）', async () => {
    const { f, settings, hermes } = hermesExitFixture(customerA)
    await hermes.applyConnection!('deepseek', customerRoute('deepseek', 'deepseek-flash'))
    f.data.delete(backupPath) // 旧安装形态：路由在、历史恢复点不存在
    await hermes.applyConnection!('moonshot', customerRoute('moonshot', 'kimi-k3'))
    expect(f.data.has(backupPath)).toBe(false)

    await hermes.deactivateToolboxConnection!()
    expectSettings(settings, unsetAll)
    await expect(hermes.restorePreviousConnection!()).rejects.toThrow('AI_ACCESS_CONFIG_UNMANAGED')
    expect(settings.get('model.base_url')).toBeUndefined()
  })

  it('①c 客户手工改过配置后，解除不覆盖客户新值（复核问题2）', async () => {
    const { f, settings, hermes } = hermesExitFixture(customerA)
    await hermes.applyConnection!('deepseek', customerRoute('deepseek', 'deepseek-flash'))
    settings.set('model.provider', 'customer-new-provider')
    settings.set('model.default', 'customer-new-model')
    settings.set('model.base_url', 'https://customer-new.invalid')

    await expect(hermes.deactivateToolboxConnection!()).rejects.toThrow('AI_ACCESS_CONFIG_UNMANAGED')
    expect(settings.get('model.default')).toBe('customer-new-model')
    expect(JSON.parse(f.data.get(backupPath)!).version).toBe(1)
    await expect(hermes.restorePreviousConnection!()).rejects.toThrow('AI_ACCESS_CONFIG_UNMANAGED')
    expect(settings.get('model.default')).toBe('customer-new-model')
  })

  it('①d 解除中途状态保存失败，恢复点保留，重试解除后仍能显式恢复（复核问题3）', async () => {
    const f = files()
    const settings = new Map<HermesModelKey, string | undefined>(customerA)
    let state: AiAccessState = { version: 1, selected: {} }
    let failOfficialSave = false
    const store = {
      read: async () => state,
      write: async (next: AiAccessState) => {
        if (failOfficialSave && next.selected.hermes === 'official') { failOfficialSave = false; throw new Error('fixture local store write failure') }
        state = next
      }
    }
    const service = new AiAccessService(store, createDeepSeekAdapters({
      home: '/customer', platform: 'darwin', file: f.io,
      findHermesCommand: async () => '/customer/.hermes/bin/hermes',
      runHermes: async (_command, args) => {
        if (args[1] === 'set') settings.set(args[2] as HermesModelKey, args[3])
        else settings.delete(args[2] as HermesModelKey)
      },
      readHermesConfig: async (_command, key) => settings.get(key)
    }), acceptingGateway())
    try {
      await service.configureProvider('hermes', 'deepseek', 'sk-fixture-hermes-review-012345678', 'deepseek-flash')
      failOfficialSave = true
      await expect(service.useOfficial('hermes')).rejects.toThrow('AI_ACCESS_APPLY_FAILED')
      expect(settings.get('model.base_url')).toBe('http://127.0.0.1:19361/hermes/deepseek/v1')
      expect(f.data.has(backupPath)).toBe(true)

      await service.useOfficial('hermes')
      expectSettings(settings, unsetAll)
      expect(f.data.has(backupPath)).toBe(true)
      await service.restorePreviousConnection('hermes')
      expectSettings(settings, Object.fromEntries(customerA))
      expect(f.data.has(backupPath)).toBe(false)
    } finally { await service.stop() }
  })

  it('事务回滚闭包把恢复点与 .env 一起纳入边界', async () => {
    const { f, settings, hermes } = hermesExitFixture(customerA)
    f.data.set(envPath, 'CUSTOMER_SETTING=keep\n')
    await hermes.applyConnection!('deepseek', customerRoute('deepseek', 'deepseek-flash'))
    const rollback = await hermes.captureConnection!()
    const backupAtCapture = f.data.get(backupPath)
    const envAtCapture = f.data.get(envPath)
    // 捕获之后文件被外部改坏：回滚必须连恢复点和 .env 一起复原。
    settings.set('model.default', 'external-edit')
    f.data.set(backupPath, '{ 坏掉')
    f.data.set(envPath, 'CUSTOMER_SETTING=lost\n')
    await rollback()
    expectSettings(settings, { ...routeB('deepseek', 'deepseek-flash'), 'model.default': 'deepseek-flash' })
    expect(f.data.get(backupPath)).toBe(backupAtCapture)
    expect(f.data.get(envPath)).toBe(envAtCapture)
  })

  it('恢复点损坏时解除与恢复都拒绝执行，不盲写客户配置（④）', async () => {
    const { f, settings, hermes } = hermesExitFixture(customerA)
    await hermes.applyConnection!('deepseek', customerRoute('deepseek', 'deepseek-flash'))
    f.data.set(backupPath, '{ 坏掉的恢复点')

    await expect(hermes.deactivateToolboxConnection!()).rejects.toThrow('AI_ACCESS_CONFIG_BACKUP_CORRUPT')
    expect(settings.get('model.provider')).toBe('custom')
    await expect(hermes.restorePreviousConnection!()).rejects.toThrow('AI_ACCESS_CONFIG_BACKUP_CORRUPT')
    expect(settings.get('model.provider')).toBe('custom')
  })

  it('解除后配置被外部改写时，显式恢复不覆盖客户手工配置（④）', async () => {
    const { settings, hermes } = hermesExitFixture(customerA)
    await hermes.applyConnection!('deepseek', customerRoute('deepseek', 'deepseek-flash'))
    for (const key of ['model.provider', 'model.default', 'model.base_url', 'model.api_key', 'model.api_mode', 'model.context_length']) {
      settings.delete(key as HermesModelKey)
    }
    settings.set('model.provider', 'customer-new-provider')
    settings.set('model.default', 'customer-new-model')
    await expect(hermes.restorePreviousConnection!()).rejects.toThrow('AI_ACCESS_CONFIG_UNMANAGED')
    expect(settings.get('model.default')).toBe('customer-new-model')
  })

  it('解除时原生 CLI 写入失败会回滚并如实报错，不假报已解除（④）', async () => {
    const f = files()
    const settings = new Map<HermesModelKey, string | undefined>(customerA)
    let failing = false
    const hermes = createDeepSeekAdapters({
      home: '/customer', platform: 'darwin', file: f.io,
      findHermesCommand: async () => '/customer/.hermes/bin/hermes',
      runHermes: async (_command, args) => {
        if (failing) throw new Error('fixture cli failure')
        if (args[1] === 'set') settings.set(args[2] as HermesModelKey, args[3])
        else settings.delete(args[2] as HermesModelKey)
      },
      readHermesConfig: async (_command, key) => settings.get(key)
    }).find((adapter) => adapter.shell === 'hermes')!

    await hermes.applyConnection!('deepseek', customerRoute('deepseek', 'deepseek-flash'))
    failing = true
    await expect(hermes.deactivateToolboxConnection!()).rejects.toThrow('AI_ACCESS_HERMES_ROLLBACK_FAILED')
    expectSettings(settings, routeB('deepseek', 'deepseek-flash'))
  })

  it('旧直连 .env 托管块随解除移除，客户自己的环境变量保留；恢复点留待显式恢复', async () => {
    const { f, settings, hermes } = hermesExitFixture([])
    f.data.set(envPath, 'CUSTOMER_SETTING=keep\n')
    await hermes.applyDeepSeek('sk-toolbox-fixture-key-1234567890')
    expect(f.data.get(envPath)).toContain('LAIXIN_AI_TOOLBOX_MODEL_CONNECTION=1')
    expect(f.data.get(envPath)).toContain('CUSTOMER_SETTING=keep')

    await hermes.deactivateToolboxConnection!()
    expect(settings.get('model.provider')).toBeUndefined()
    expect(f.data.get(envPath)).toBe('CUSTOMER_SETTING=keep')
    expect(f.data.has(backupPath)).toBe(true)
    await hermes.restorePreviousConnection!()
    expect(f.data.get(envPath)).toBe('CUSTOMER_SETTING=keep')
  })

  it('没有工具箱痕迹的 Hermes 上解除和恢复都如实说明无可解除（④）', async () => {
    const { f, hermes } = hermesExitFixture(customerA)
    await expect(hermes.deactivateToolboxConnection!()).rejects.toThrow('AI_ACCESS_CONFIG_UNMANAGED')
    await expect(hermes.restorePreviousConnection!()).rejects.toThrow('AI_ACCESS_CONFIG_UNMANAGED')
    expect(f.data.has(backupPath)).toBe(false)
  })

  it('②a 旧直连客户手工改过 config.yaml 后，解除只移除自己的 .env 块，客户新配置保留（复核补充问题1）', async () => {
    const { f, settings, hermes } = hermesExitFixture([])
    f.data.set(envPath, 'CUSTOMER_SETTING=keep\n')
    await hermes.applyDeepSeek('sk-toolbox-fixture-key-1234567890')
    expect(f.data.get(envPath)).toContain('LAIXIN_AI_TOOLBOX_MODEL_CONNECTION=1')
    // 客户随后把 config.yaml 的模型设置改成自己的 C：.env 块还在，但六个键已不是工具箱写的值。
    settings.set('model.provider', 'customer-c-provider')
    settings.set('model.default', 'customer-c-model')
    settings.set('model.base_url', 'https://customer-c.invalid')

    await hermes.deactivateToolboxConnection!()
    expect(f.data.get(envPath)).toBe('CUSTOMER_SETTING=keep')
    expect(settings.get('model.provider')).toBe('customer-c-provider')
    expect(settings.get('model.default')).toBe('customer-c-model')
    expect(settings.get('model.base_url')).toBe('https://customer-c.invalid')
  })

  it('②b 首次接管失败不留下恢复点；客户改 C 再接入 B 后，显式恢复回到 C（复核补充问题2）', async () => {
    const f = files()
    const settings = new Map<HermesModelKey, string | undefined>(customerA)
    let failNextSet = false
    const hermes = createDeepSeekAdapters({
      home: '/customer', platform: 'darwin', file: f.io,
      findHermesCommand: async () => '/customer/.hermes/bin/hermes',
      runHermes: async (_command, args) => {
        if (failNextSet && args[1] === 'set') { failNextSet = false; throw new Error('fixture first apply failure') }
        if (args[1] === 'set') settings.set(args[2] as HermesModelKey, args[3])
        else settings.delete(args[2] as HermesModelKey)
      },
      readHermesConfig: async (_command, key) => settings.get(key)
    }).find((adapter) => adapter.shell === 'hermes')!

    failNextSet = true
    await expect(hermes.applyConnection!('deepseek', customerRoute('deepseek', 'deepseek-flash'))).rejects.toThrow('AI_ACCESS_HERMES_CONFIG_FAILED')
    // 失败的首次接管：配置回到 A，新建的恢复点必须一起撤销，⛔ 留下假恢复点。
    expectSettings(settings, Object.fromEntries(customerA))
    expect(f.data.has(backupPath)).toBe(false)

    // 客户把配置改成 C，再次成功接入 B：恢复点此刻才记录 C。
    settings.set('model.provider', 'customer-c-provider')
    settings.set('model.default', 'customer-c-model')
    settings.set('model.base_url', 'https://customer-c.invalid')
    await hermes.applyConnection!('deepseek', customerRoute('deepseek', 'deepseek-flash'))
    expect(JSON.parse(JSON.parse(f.data.get(backupPath)!).original)['model.default']).toBe('customer-c-model')

    await hermes.deactivateToolboxConnection!()
    await hermes.restorePreviousConnection!()
    expect(settings.get('model.default')).toBe('customer-c-model')
  })

  it('Hermes 解除不串其他壳：Codex 的配置与恢复点原样保留（⑤）', async () => {
    const f = files()
    const settings = new Map<HermesModelKey, string | undefined>(customerA)
    const adapters = createDeepSeekAdapters({
      home: '/customer', platform: 'darwin', file: f.io,
      findHermesCommand: async () => '/customer/.hermes/bin/hermes',
      runHermes: async (_command, args) => {
        if (args[1] === 'set') settings.set(args[2] as HermesModelKey, args[3])
        else settings.delete(args[2] as HermesModelKey)
      },
      readHermesConfig: async (_command, key) => settings.get(key)
    })
    const key = 'sk-toolbox-fixture-key-1234567890'
    await adapters.find((adapter) => adapter.shell === 'codex')!.applyDeepSeek(key)
    const codexBackup = f.data.get('/customer/.codex/laixin-model-api-backup.json')
    await adapters.find((adapter) => adapter.shell === 'hermes')!.applyConnection!('deepseek', customerRoute('deepseek', 'deepseek-flash'))

    await adapters.find((adapter) => adapter.shell === 'hermes')!.deactivateToolboxConnection!()
    expect(f.data.get('/customer/.codex/config.toml')).toContain('laixin-deepseek')
    expect(f.data.get('/customer/.codex/laixin-model-api-backup.json')).toBe(codexBackup)
  })

  it('service 生产入口两步语义：解除保留恢复点并暴露可见性，显式恢复找回原配置', async () => {
    const f = files()
    const settings = new Map<HermesModelKey, string | undefined>(customerA)
    let state: AiAccessState = { version: 1, selected: {} }
    const store = { read: async () => state, write: async (next: AiAccessState) => { state = next } }
    const service = new AiAccessService(store, createDeepSeekAdapters({
      home: '/customer', platform: 'darwin', file: f.io,
      findHermesCommand: async () => '/customer/.hermes/bin/hermes',
      runHermes: async (_command, args) => {
        if (args[1] === 'set') settings.set(args[2] as HermesModelKey, args[3])
        else settings.delete(args[2] as HermesModelKey)
      },
      readHermesConfig: async (_command, key) => settings.get(key)
    }), acceptingGateway())
    try {
      await service.configureProvider('hermes', 'deepseek', 'sk-fixture-hermes-exit-0123456789', 'deepseek-flash')
      await expect(service.restorePreviousConnection('hermes')).rejects.toThrow('AI_ACCESS_RESTORE_PREVIOUS_REQUIRES_OFFICIAL')

      await service.useOfficial('hermes')
      expect(state.selected.hermes).toBe('official')
      expectSettings(settings, unsetAll)
      expect(f.data.has(backupPath)).toBe(true)
      expect((await service.status()).shells.hermes.recoveryPointAvailable).toBe(true)

      await service.restorePreviousConnection('hermes')
      expectSettings(settings, Object.fromEntries(customerA))
      expect(f.data.has(backupPath)).toBe(false)
      expect((await service.status()).shells.hermes.recoveryPointAvailable).toBe(false)
      expect(state.selected.hermes).toBeUndefined()
    } finally { await service.stop() }
  })
})
